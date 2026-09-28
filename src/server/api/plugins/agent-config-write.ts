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
import { maskAgentSandboxSecrets } from '@/lib/services/agents/agentSandboxSecrets';
import type { IAgent, IAgentConfig, IAgentVersion, IUser } from '@/lib/database';
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
import { readJsonBody } from '../fastify-utils';
import { carriedGuardrailFields, resolveConfigGuardrailBindings } from './guardrail-bindings';

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
}

/** A config write refused with a 400 (`badRequest` is the body), or accepted. */
type ConfigWriteOutcome<T> = { badRequest: Record<string, unknown> } | T;

/**
 * A new agent's config, as both create routes store it: normalized, guardrail
 * bindings validated, then the whole config validated.
 */
export async function prepareNewAgentConfig(
  rawConfig: unknown,
  scope: AgentConfigWriteScope,
): Promise<ConfigWriteOutcome<{ config: IAgentConfig; warnings: AgentConfigIssue[] }>> {
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

  const validation = await validateAgentConfig({
    tenantDbName: scope.tenantDbName,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    config,
  });
  if (validation.errors.length > 0) return { badRequest: invalidConfigBody(validation) };
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

/** A native config sent on update: guardrail bindings, then validation. */
export async function validateNativeConfigUpdate(
  cfg: Record<string, unknown>,
  agentKey: string,
  scope: AgentConfigWriteScope,
): Promise<ConfigWriteOutcome<{ warnings: AgentConfigIssue[] }>> {
  // The config replaces the stored one wholesale, so the projected legacy
  // slots must be written on the SAME object — leaving them out would clear
  // the columns an older binary still reads.
  const config = cfg as IAgentConfig;
  const bindingError = await applyConfigGuardrailBindings(config, scope.tenantDbName, scope.projectId, scope.user);
  if (bindingError) return { badRequest: { error: bindingError } };

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
  return { warnings: validation.warnings };
}

/**
 * Publish the stored draft as a new version. Validated first: a draft saved
 * before validation existed (or whose tool was deleted since) must not become
 * what every API caller runs. The body is read only after validation passes.
 */
export async function publishValidatedAgent(
  request: FastifyRequest,
  scope: AgentConfigWriteScope,
  agent: Pick<IAgent, 'config' | 'key'>,
  agentId: string,
  userId: string,
): Promise<ConfigWriteOutcome<{ version: IAgentVersion }>> {
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
