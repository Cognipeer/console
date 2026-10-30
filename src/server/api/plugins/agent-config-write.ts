/**
 * The agent config-write and redaction helpers shared by the dashboard
 * (`agents.ts`) and client (`client-agents.ts`) agent routes.
 *
 * They live beside the route plugins rather than inside one for the same
 * reason `guardrail-bindings.ts` does: two plugins create, update and publish
 * agents, and a per-plugin copy is how a dashboard write and an API write end
 * up accepting different payloads.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  maskAgentSandboxSecrets,
  SANDBOX_SECRETS_UNREADABLE_CODE,
  SANDBOX_SECRETS_UNREADABLE_MESSAGE,
  sandboxSecretsConflict,
} from '@/lib/services/agents/agentSandboxSecrets';
import { runWithTenantScope, type IAgent, type IAgentConfig, type IAgentVersion, type IUser } from '@/lib/database';
import {
  normalizeA2aMetadataUpdate,
  prepareConnectionForStorage,
  publishAgent,
} from '@/lib/services/agents';
import {
  invalidConfigBody,
  validateAgentConfig,
  type AgentConfigIssue,
} from '@/lib/services/agents/agentConfigValidation';
// By path: the agents barrel does not export the error class.
import { AgentGuardrailBlockedError } from '@/lib/services/agents/agentService';
import {
  bucketNamingRefusal,
  type BucketNamingRefusal,
  type CanNameBucket,
} from '@/lib/services/agents/attachmentsBucketAccess';
import {
  addsConfigTargets,
  configRefTargets,
  loadProjectConfigIndex,
  normalizeConfigGroupRefs,
  normalizeConfigValueRefs,
  rawConfigRefTargets,
} from '@/lib/services/config/configRefs';
import { readJsonBody } from '../fastify-utils';
import { configReadRequiredBody } from './config-permission';
import { sandboxWriteRequiredBody } from './sandbox-permission';
import { CONSOLE_IDENTITY_AUTH_TYPE, ensureConsoleIdentityKey } from '@/lib/iam/consoleIdentity';
import { carriedGuardrailFields, resolveConfigGuardrailBindings } from './guardrail-bindings';
import { FILES_WRITE_REQUIRED_MESSAGE } from './files-permission';

/**
 * A guardrail refusal is a policy decision, not a server fault: answered with
 * the same `{ error: { type: 'guardrail_block' } }` envelope and status the
 * inference routes use for `GuardrailBlockError`, so a dashboard or SDK client
 * branches on `error.type` and reads `guardrail_key` and `reason` whether it
 * called a model or an agent. Returns null for any other error so the caller's
 * own fallback still applies.
 */
export function sendAgentGuardrailBlock(reply: FastifyReply, error: unknown) {
  if (!(error instanceof AgentGuardrailBlockedError)) return null;
  return reply.code(error.status).send({
    error: {
      type: 'guardrail_block',
      action: 'block',
      message: error.message,
      reason: error.reason,
      guardrail_key: error.guardrailKey ?? null,
      hook: error.hook ?? null,
    },
  });
}

/**
 * Strip secret material (encrypted inline API keys) from an agent before it
 * leaves the API. The presence of a key is surfaced as `connection.hasApiKey`.
 */
export function redactAgent<T extends IAgent>(input: T): T {
  // Sandbox secrets: keys with a masked value, never the sealed payload.
  const agent = maskAgentSandboxSecrets(input);
  const connection = agent.config?.connection;
  if (!connection) return agent;
  const { apiKeyEnc, ...rest } = connection;
  return {
    ...agent,
    config: {
      ...agent.config,
      connection: { ...rest, hasApiKey: Boolean(apiKeyEnc) },
    },
  } as unknown as T;
}

/**
 * A version as it leaves the API: its snapshot froze the agent's config, so it
 * gets the same redaction as the agent itself (sandbox and callback secrets,
 * the connection's encrypted key).
 */
export function redactVersion<T extends { snapshot?: { config?: IAgentConfig } }>(version: T): T {
  if (!version?.snapshot) return version;
  return { ...version, snapshot: redactAgent(version.snapshot as unknown as IAgent) } as T;
}

/**
 * Normalize an incoming agent config. For connected (external) agents the
 * connection is validated and its inline API key encrypted; native agents must
 * carry a modelKey. Throws (Error) on invalid input — callers map to 400.
 *
 * A connected agent's config is rebuilt from scratch so nothing but the
 * validated connection is stored — EXCEPT its guardrail bindings, which are
 * carried through (`carriedGuardrailFields`) and validated by
 * `applyConfigGuardrailBindings` right after. Dropping them here is what made
 * the connected-agent enforcement branch unreachable: the binding list saved
 * with a 200 and `resolveBindings` read `{ kind, connection }` as "nothing bound".
 */
function normalizeAgentConfig(rawConfig: unknown): IAgentConfig {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('Agent config is required');
  }
  const cfg = rawConfig as Record<string, unknown>;

  if (cfg.kind === 'external') {
    return {
      kind: 'external',
      connection: prepareConnectionForStorage(cfg.connection),
      ...carriedGuardrailFields(cfg),
    };
  }

  if (typeof cfg.modelKey !== 'string' || !cfg.modelKey) {
    throw new Error('Model configuration is required');
  }
  return cfg as IAgentConfig;
}

/**
 * Validate `config.guardrails` and stamp the deprecated single slots back onto
 * the config from it, in place.
 *
 * Done here rather than in `normalizeAgentConfig` because it needs the tenant
 * database and the caller's project scope, and `normalizeAgentConfig` is
 * deliberately synchronous and DB-free. Returns the 400 message, or null.
 *
 * Runs for connected (external) agents too: their `input.pre` / `output.pre`
 * bindings are enforced by `executeAgentChatLocal`'s external branch, so they
 * are validated exactly like a native agent's.
 */
export async function applyConfigGuardrailBindings(
  config: IAgentConfig,
  tenantDbName: string,
  projectId: string,
  user?: Pick<IUser, 'role'>,
): Promise<string | null> {
  const resolved = await resolveConfigGuardrailBindings(
    tenantDbName,
    projectId,
    config.guardrails,
    user,
  );
  if (resolved.error) return resolved.error;
  if (resolved.patch) Object.assign(config, resolved.patch);
  return null;
}

/**
 * Where an agent config is written. `user` is the dashboard caller, whose
 * owner/admin role widens guardrail lookup to the whole tenant; the client API
 * passes none (a token is confined to its project).
 */
export interface AgentConfigWriteScope {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  user?: Pick<IUser, 'role'>;
  /**
   * May the caller name this bucket (by key) in an agent's settings? A Files decision about THAT bucket
   * (`file-bucket.update`, the policy engine's). Asked only when a write sets or changes
   * `attachments.bucketKey`: the files an agent takes land in a Document Store bucket, so naming the bucket is a
   * Files decision. A refusal's `decisionId` is quoted in the 403; an engine that cannot decide throws its 503.
   */
  canNameBucket: CanNameBucket;
  /**
   * May the caller read Config in this project? Asked only when a write points `config.sandbox.envRefs`,
   * `secretRefs` or `groupRefs` at a config item or group the stored config did not: a reference makes the
   * value readable by the agent's commands, so naming one is a Config read decision. Re-saving stored
   * references asks nothing.
   */
  canReferenceConfig: () => Promise<boolean>;
  /**
   * May the caller work in this project's sandboxes (Sandbox write)? Asked only when a write sets or changes
   * `config.sandbox.instanceId`: the agent then runs its commands in that persistent sandbox and reads its files,
   * so choosing it is a Sandbox decision. Absent = such a write is refused (fails closed).
   */
  canUseSandbox?: () => Promise<boolean>;
}

/** `canReferenceConfig` answered once per write: it is asked before the lookups and again after them. */
function onceCanReferenceConfig(scope: AgentConfigWriteScope): AgentConfigWriteScope {
  let answer: Promise<boolean> | undefined;
  return { ...scope, canReferenceConfig: () => (answer ??= scope.canReferenceConfig()) };
}

/** A config write refused with a 400 (`badRequest` is the body) or a 403 (`forbidden`), or accepted. */
type ConfigWriteOutcome<T> = { badRequest: Record<string, unknown> } | { forbidden: Record<string, unknown> } | T;

/** The 409 body for a write that mixes masked sandbox secrets with new values while the stored ones cannot be decrypted. */
export function sandboxSecretsUnreadableBody(): Record<string, unknown> {
  return {
    error: SANDBOX_SECRETS_UNREADABLE_MESSAGE,
    type: SANDBOX_SECRETS_UNREADABLE_CODE,
    code: SANDBOX_SECRETS_UNREADABLE_CODE,
    field: 'config.sandbox.secrets',
  };
}

/** The 403 body for a write that named a bucket its caller may not name (`bucketNamingRefusal` found it). */
export function bucketNamingForbiddenBody(refusal: Pick<BucketNamingRefusal, 'decisionId'>): Record<string, unknown> {
  return {
    error: FILES_WRITE_REQUIRED_MESSAGE,
    type: 'files_write_required',
    code: 'files_write_required',
    field: 'attachments.bucketKey',
    ...(refusal.decisionId ? { decisionId: refusal.decisionId } : {}),
  };
}

/**
 * The 403 for a write that picks or changes the bucket session files go to
 * without write access to Files, else null. Re-saving the bucket already stored
 * (any other edit of the agent) asks nothing of Files.
 */
export async function attachmentsBucketRefusal(
  next: IAgentConfig,
  previous: IAgentConfig | undefined,
  scope: Pick<AgentConfigWriteScope, 'canNameBucket'>,
): Promise<{ forbidden: Record<string, unknown> } | null> {
  const refusal = await bucketNamingRefusal(next, previous, scope.canNameBucket);
  return refusal ? { forbidden: bucketNamingForbiddenBody(refusal) } : null;
}

/** The sandbox reference fields of an agent config (value maps and the group list). */
const SANDBOX_REF_FIELDS = [
  { key: 'envRefs', refs: true },
  { key: 'secretRefs', refs: true },
  { key: 'groupRefs', refs: false },
] as const;

/**
 * The 403 for a write whose RAW references (ids or keys, not yet looked up) name a config item or group the
 * stored config did not, without Config read access, else null. Asked before anything is normalized, so a
 * caller without Config read learns nothing about what Config holds from a 400 (unknown key, secret item,
 * other project) that the lookup would have produced.
 */
async function rawConfigReferenceRefusal(
  sandbox: NonNullable<IAgentConfig['sandbox']>,
  previous: IAgentConfig | undefined,
  scope: Pick<AgentConfigWriteScope, 'canReferenceConfig'>,
): Promise<{ forbidden: Record<string, unknown> } | null> {
  for (const { key, refs } of SANDBOX_REF_FIELDS) {
    const raw = rawConfigRefTargets(refs ? { refs: [sandbox[key]] } : { groupRefs: [sandbox[key]] });
    if (raw.size === 0) continue;
    const stored = previous?.sandbox?.[key] as never;
    if (!addsConfigTargets(raw, configRefTargets(refs ? { refs: [stored] } : { groupRefs: [stored] }))) continue;
    if (await scope.canReferenceConfig()) return null;
    return { forbidden: configReadRequiredBody(`config.sandbox.${key}`) };
  }
  return null;
}

/**
 * Normalizes `config.sandbox.envRefs` / `secretRefs` / `groupRefs` to the stored shape (ids, never values), in
 * place, against the request's project. A name that is both a typed value and a reference is refused. Returns
 * the 403 body (the raw references add a target and the caller cannot read Config; checked before any lookup),
 * the 400 body, or null. The project's Config is loaded only when a reference is present.
 */
async function normalizeSandboxConfigRefs(
  config: IAgentConfig,
  previous: IAgentConfig | undefined,
  scope: Pick<AgentConfigWriteScope, 'tenantDbName' | 'projectId' | 'canReferenceConfig'>,
): Promise<{ badRequest: Record<string, unknown> } | { forbidden: Record<string, unknown> } | null> {
  const sandbox = config.sandbox;
  if (!sandbox || typeof sandbox !== 'object') return null;
  const sent = [sandbox.envRefs, sandbox.secretRefs, sandbox.groupRefs];
  if (sent.every((value) => value === undefined)) return null;

  const forbidden = await rawConfigReferenceRefusal(sandbox, previous, scope);
  if (forbidden) return forbidden;

  const needsIndex = sent.some((value) => (Array.isArray(value) ? value.length > 0 : value !== null && typeof value === 'object' ? Object.keys(value).length > 0 : value !== undefined && value !== null));
  // One tenant binding for every read below: a process-global switchToTenant can be overwritten by another
  // tenant's request between the awaits.
  return runWithTenantScope(scope.tenantDbName, async (db) => {
    const errors: AgentConfigIssue[] = [];
    const index = needsIndex
      ? await loadProjectConfigIndex(db, scope.projectId)
      : { projectId: scope.projectId, groups: [], items: [] };

    const valueMaps = [
      { key: 'envRefs', typed: 'env', allowSecret: false },
      { key: 'secretRefs', typed: 'secrets', allowSecret: true },
    ] as const;
    for (const { key, typed, allowSecret } of valueMaps) {
      const field = `config.sandbox.${key}`;
      const { refs, issues } = await normalizeConfigValueRefs(db, index, sandbox[key], field, { allowSecret });
      errors.push(...issues);
      if (refs === undefined) continue;
      const typedNames = new Set(Object.keys(sandbox[typed] ?? {}));
      for (const name of Object.keys(refs)) {
        if (typedNames.has(name)) {
          errors.push({ field: `${field}.${name}`, message: `${name} is also set in ${typed}: set it in one place` });
        }
      }
      if (Object.keys(refs).length > 0) sandbox[key] = refs;
      else delete sandbox[key];
    }
    const groups = await normalizeConfigGroupRefs(db, index, sandbox.groupRefs, 'config.sandbox.groupRefs');
    errors.push(...groups.issues);
    if (groups.refs !== undefined) {
      if (groups.refs.length > 0) sandbox.groupRefs = groups.refs;
      else delete sandbox.groupRefs;
    }
    return errors.length > 0 ? { badRequest: invalidConfigBody({ errors, warnings: [] }) } : null;
  });
}

/**
 * The 403 for a write that points the sandbox at a config item or group its stored version did not, without
 * Config read access, else null. Re-saving what is stored asks nothing.
 */
async function configReferenceRefusal(
  next: IAgentConfig,
  previous: IAgentConfig | undefined,
  scope: Pick<AgentConfigWriteScope, 'canReferenceConfig'>,
): Promise<{ forbidden: Record<string, unknown> } | null> {
  for (const { key, refs } of SANDBOX_REF_FIELDS) {
    const pick = (config: IAgentConfig | undefined) => config?.sandbox?.[key] as never;
    const targets = (config: IAgentConfig | undefined) =>
      configRefTargets(refs ? { refs: [pick(config)] } : { groupRefs: [pick(config)] });
    if (!addsConfigTargets(targets(next), targets(previous))) continue;
    if (await scope.canReferenceConfig()) return null;
    return { forbidden: configReadRequiredBody(`config.sandbox.${key}`) };
  }
  return null;
}

/**
 * The 403 for a write that sets or changes the persistent sandbox (`config.sandbox.instanceId`) without Sandbox
 * write access, else null. Asked whatever the mode and the `enabled` switch say, so a sandbox cannot be chosen
 * while switched off and turned on later by someone the stored id no longer asks. Re-saving the stored id asks
 * nothing; clearing it asks nothing.
 */
async function sandboxInstanceRefusal(
  next: IAgentConfig,
  previous: IAgentConfig | undefined,
  scope: Pick<AgentConfigWriteScope, 'canUseSandbox'>,
): Promise<{ forbidden: Record<string, unknown> } | null> {
  const chosen = typeof next.sandbox?.instanceId === 'string' ? next.sandbox.instanceId.trim() : '';
  if (!chosen || chosen === previous?.sandbox?.instanceId) return null;
  if (scope.canUseSandbox && await scope.canUseSandbox()) return null;
  return { forbidden: sandboxWriteRequiredBody('config.sandbox.instanceId') };
}

/**
 * A connected agent set up for Console identity: make sure the workspace's signing key exists, so
 * its key set is published before the first call (that call creates it otherwise).
 */
export async function prepareConnectedAgentIdentity(config: IAgentConfig, tenantDbName: string): Promise<void> {
  if (config.kind !== 'external' || config.connection?.authType !== CONSOLE_IDENTITY_AUTH_TYPE) return;
  await ensureConsoleIdentityKey(tenantDbName).catch(() => undefined);
}

/**
 * A new agent's config, as both create routes store it: normalized, guardrail
 * bindings validated, then the whole config validated.
 */
export async function prepareNewAgentConfig(
  rawConfig: unknown,
  writeScope: AgentConfigWriteScope,
): Promise<ConfigWriteOutcome<{ config: IAgentConfig; warnings: AgentConfigIssue[] }>> {
  const scope = onceCanReferenceConfig(writeScope);
  let config: IAgentConfig;
  try {
    config = normalizeAgentConfig(rawConfig);
  } catch (validationError) {
    return {
      badRequest: { error: validationError instanceof Error ? validationError.message : 'Invalid agent config' },
    };
  }
  const bindingError = await applyConfigGuardrailBindings(config, scope.tenantDbName, scope.projectId, scope.user);
  if (bindingError) return { badRequest: { error: bindingError } };
  const refsError = await normalizeSandboxConfigRefs(config, undefined, scope);
  if (refsError) return refsError;
  // Before validation, whose lookup would tell a caller without Sandbox access which sandboxes exist.
  const instanceRefusal = await sandboxInstanceRefusal(config, undefined, scope);
  if (instanceRefusal) return instanceRefusal;
  await prepareConnectedAgentIdentity(config, scope.tenantDbName);

  const validation = await validateAgentConfig({
    tenantDbName: scope.tenantDbName,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    config,
  });
  if (validation.errors.length > 0) return { badRequest: invalidConfigBody(validation) };
  const refusal = await attachmentsBucketRefusal(config, undefined, scope);
  if (refusal) return refusal;
  const configRefusal = await configReferenceRefusal(config, undefined, scope);
  if (configRefusal) return configRefusal;
  return { config, warnings: validation.warnings };
}

/**
 * Connected-agent config: validate connection & preserve the stored API key
 * when the client edits without resending it. Throws like `normalizeAgentConfig`.
 */
export function connectedConfigForUpdate(cfg: Record<string, unknown>, existing: IAgent): IAgentConfig {
  const connection = { ...((cfg.connection as Record<string, unknown>) ?? {}) };
  const stored = existing.config?.connection?.apiKeyEnc;
  if (!connection.apiKey && !connection.apiKeyEnc && stored) connection.apiKeyEnc = stored;
  return normalizeAgentConfig({ ...cfg, connection });
}

/** A native config sent on update: guardrail bindings, then validation; a 409 (`conflict`) when it cannot be saved over what is stored. */
export async function validateNativeConfigUpdate(
  cfg: Record<string, unknown>,
  agentKey: string,
  writeScope: AgentConfigWriteScope,
  /** The config stored now: re-saving its bucket or its config references is not a change. */
  previous?: IAgentConfig,
): Promise<ConfigWriteOutcome<{ warnings: AgentConfigIssue[] }> | { conflict: Record<string, unknown> }> {
  const scope = onceCanReferenceConfig(writeScope);
  // The config replaces the stored one wholesale, so the projected legacy
  // slots must be written on the SAME object — leaving them out would clear
  // the columns an older binary still reads.
  const config = cfg as IAgentConfig;
  const bindingError = await applyConfigGuardrailBindings(config, scope.tenantDbName, scope.projectId, scope.user);
  if (bindingError) return { badRequest: { error: bindingError } };
  const refsError = await normalizeSandboxConfigRefs(config, previous, scope);
  if (refsError) return refsError;
  // Before validation, whose lookup would tell a caller without Sandbox access which sandboxes exist.
  const instanceRefusal = await sandboxInstanceRefusal(config, previous, scope);
  if (instanceRefusal) return instanceRefusal;

  // A config that would not run as configured is not saved: the runtime
  // would skip the broken parts silently.
  const validation = await validateAgentConfig({
    tenantDbName: scope.tenantDbName,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    config,
    agentKey,
  });
  if (validation.errors.length > 0) return { badRequest: invalidConfigBody(validation) };
  if (sandboxSecretsConflict(config.sandbox, previous?.sandbox)) return { conflict: sandboxSecretsUnreadableBody() };
  const refusal = await attachmentsBucketRefusal(config, previous, scope);
  if (refusal) return refusal;
  const configRefusal = await configReferenceRefusal(config, previous, scope);
  if (configRefusal) return configRefusal;
  return { warnings: validation.warnings };
}

/**
 * Publish the stored draft as a new version. Validated first: a draft saved
 * before validation existed (or whose tool was deleted since) must not become
 * what every API caller runs. The body is read only after validation passes.
 */
export async function publishValidatedAgent(
  request: FastifyRequest,
  scope: Pick<AgentConfigWriteScope, 'tenantDbName' | 'tenantId' | 'projectId'>,
  agent: Pick<IAgent, 'config' | 'key'>,
  agentId: string,
  userId: string,
): Promise<{ badRequest: Record<string, unknown> } | { version: IAgentVersion }> {
  const validation = await validateAgentConfig({
    tenantDbName: scope.tenantDbName,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    config: agent.config,
    agentKey: agent.key,
  });
  if (validation.errors.length > 0) return { badRequest: invalidConfigBody(validation) };
  const body = readJsonBody<Record<string, unknown>>(request);
  return {
    version: await publishAgent(
      scope.tenantDbName,
      agentId,
      userId,
      typeof body.changelog === 'string' ? body.changelog : undefined,
    ),
  };
}

/**
 * A2A exposure updates, in place: whitelist fields and keep the endpoint slug
 * server-owned (existing slug is preserved, never client-chosen).
 */
export function normalizeA2aUpdate(body: Record<string, unknown>, existing: IAgent): void {
  const metadata = body.metadata as Record<string, unknown> | undefined;
  if (metadata && typeof metadata === 'object' && metadata.a2a !== undefined) {
    metadata.a2a = normalizeA2aMetadataUpdate(metadata.a2a, existing);
  }
}

/**
 * The agent fields a PATCH may write. The body otherwise reaches the store as
 * a `$set` of whatever the caller sent, so `projectId` (move the agent — and
 * its runs and credentials — into another project), `tenantId`,
 * `publishedVersion`, `createdBy` and the timestamps would all be writable.
 * Everything not listed here is server-owned.
 */
const AGENT_UPDATABLE_FIELDS = ['name', 'description', 'config', 'status', 'metadata'] as const;

export function pickAgentUpdateFields(body: Record<string, unknown>): Partial<Pick<IAgent, typeof AGENT_UPDATABLE_FIELDS[number]>> {
  const picked: Record<string, unknown> = {};
  for (const field of AGENT_UPDATABLE_FIELDS) {
    if (body[field] !== undefined) picked[field] = body[field];
  }
  return picked as Partial<Pick<IAgent, typeof AGENT_UPDATABLE_FIELDS[number]>>;
}

const AGENT_STATUSES = ['active', 'inactive', 'draft'] as const;

/**
 * The 400 body for a write whose `status` is not one of the agent statuses
 * (`active`, `inactive`, `draft`), else null. An absent status is fine.
 */
export function invalidAgentStatusBody(body: Record<string, unknown>): Record<string, unknown> | null {
  if (body.status === undefined) return null;
  if (typeof body.status === 'string' && (AGENT_STATUSES as readonly string[]).includes(body.status)) return null;
  return {
    error: `status must be one of: ${AGENT_STATUSES.join(', ')}`,
    type: 'invalid_request',
    code: 'invalid_status',
    field: 'status',
  };
}
