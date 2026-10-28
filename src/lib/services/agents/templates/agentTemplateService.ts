/**
 * The server side of agent templates: what the gallery lists (and what each
 * template still needs from the project), and turning a template into an agent.
 *
 * Creating an agent from a template is all-or-nothing and goes through the same
 * checks a Studio save does: the model, knowledge bases and guardrails are
 * looked up first, the config goes through the shared new-agent preparation
 * (guardrail bindings, `validateAgentConfig`), and each suggested trigger goes
 * through the trigger write validation. Whatever was created before a failure -
 * the agent (with its triggers) and the skills this call added - is removed
 * again.
 *
 * The creates of one tenant run one after the other (`serialized`): an agent's
 * key is the template's own (`customer-support`, then `customer-support-2` ...)
 * and an embedded skill is reused when it is there, so two requests in the same
 * moment - a double click - would both find the first key free, each add the
 * skill, and a failure of one would take away the skill the other just reused.
 *
 * The pieces that live in the API layer (they need the caller's role, the
 * bucket permission and the trigger parser) are passed in as `deps`, the way
 * `canNameBucket` is handed to the import service: the library never imports
 * from the route plugins.
 */

import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type { IAgent, IAgentConfig } from '@/lib/database';
import { agentTemplatesEn } from '@/lib/i18n/messages/agentTemplates.en';
import { resolveSandboxAvailability } from '@/lib/services/agents/agentSandboxTools';
import { createAgentRecord, deleteAgentRecord, getAgentById, publishAgent } from '@/lib/services/agents/agentService';
import { resolveAgentKnowledgeModule } from '@/lib/services/agents/bindingResolution';
import { DEFAULT_TRIGGER_TIMEZONE, isValidTriggerTimezone } from '@/lib/services/agents/agentTriggerSchedule';
import {
  createAgentTriggerHosted,
  serializeAgentTrigger,
  type NewTriggerWrite,
  type TriggerWrite,
} from '@/lib/services/agents/agentTriggers';
import { toSubscriptionWire } from '@/lib/services/agents/agentTriggerConnectorHost';
import type { AgentConfigIssue } from '@/lib/services/agents/agentConfigValidation';
import { createSkill, deleteSkill } from '@/lib/services/agents/skillService';
import { listRagModules } from '@/lib/services/rag/ragService';
import { listWebSearchProviders } from '@/lib/services/webSearch/webSearchService';
import { AGENT_TEMPLATE_CATALOG_VERSION, AGENT_TEMPLATES, findAgentTemplate } from './catalog';
import { computeTemplateAvailability, type TemplateFacts } from './templateAvailability';
import {
  AGENT_KEY_MAX_ATTEMPTS,
  AGENT_KEY_PATTERN,
  agentKeyCandidate,
  buildTemplateConfig,
  buildTriggerBody,
  givenConnectorParams,
} from './templateConfig';
import { buildSetupItems } from './templateSetup';
import type {
  AgentTemplate,
  AgentTemplateDetail,
  AgentTemplateListResult,
  AgentTemplateSummary,
  InstantiatedTemplateTrigger,
  InstantiateTemplateResult,
  SkippedTemplateTrigger,
} from './types';

const logger = createLogger('agent-templates');

/** A refusal with the HTTP status and the stable `code` the API answers with. */
export class AgentTemplateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** More fields for the answer (`issues`, `reason`). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AgentTemplateError';
  }
}

/** Where the agent is made: the caller's tenant and project. */
export interface AgentTemplateScope {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
}

export type PreparedAgentConfig =
  | { config: IAgentConfig; warnings: AgentConfigIssue[] }
  | { badRequest: Record<string, unknown> }
  | { forbidden: Record<string, unknown> };

export type PreparedTriggerWrite =
  | { ok: true; write: TriggerWrite; /** A newly generated webhook secret, shown once. */ webhookSecret?: string }
  | { ok: false; errors: Array<{ field: string; message: string }> };

/** What only the API layer can do for a create (see the file header). */
export interface AgentTemplateWriteDeps {
  /** May the caller bind this guardrail? (The project's, a tenant-wide one, or any for an owner or admin.) */
  guardrailExists(key: string): Promise<boolean>;
  /** A new agent's config as the Studio's create route stores it: normalized, guardrail bindings checked, validated. */
  prepareAgentConfig(config: IAgentConfig): Promise<PreparedAgentConfig>;
  /** A trigger body in the shape `POST /agents/:id/triggers` takes, checked against the created agent. */
  prepareTriggerWrite(input: { body: Record<string, unknown>; agent: IAgent; actorId?: string }): Promise<PreparedTriggerWrite>;
}

// ── Listing ──────────────────────────────────────────────────────────────

function softly<T>(what: string, fallback: T) {
  return (error: unknown): T => {
    logger.warn(`Template availability: ${what} could not be read`, { error });
    return fallback;
  };
}

async function readSandboxFacts(scope: AgentTemplateScope): Promise<TemplateFacts['sandbox']> {
  const availability = await resolveSandboxAvailability(scope.tenantId)
    .catch(softly<{ available: false; reason: 'license' }>('the sandbox availability', { available: false, reason: 'license' }));
  if (!availability.available) return { available: false, reason: availability.reason };
  const templates = await availability.runner.listTemplates(scope.tenantDbName, scope.tenantId)
    .catch(softly('the sandbox templates', null));
  return { available: true, ...(templates ? { templateKeys: templates.map((template) => template.key) } : {}) };
}

async function readTemplateFacts(scope: AgentTemplateScope): Promise<TemplateFacts> {
  const [chatModels, webSearchProviders, knowledgeBases, sandbox] = await Promise.all([
    runWithTenantScope(scope.tenantDbName, (db) => db.listModels({ projectId: scope.projectId, category: 'llm' })),
    listWebSearchProviders(scope.tenantDbName, scope.tenantId, scope.projectId).catch(softly('the web search providers', [])),
    listRagModules(scope.tenantDbName, { projectId: scope.projectId, status: 'active' }).catch(softly('the knowledge bases', [])),
    readSandboxFacts(scope),
  ]);
  return {
    hasLlmModel: chatModels.length > 0,
    hasWebSearchProvider: webSearchProviders.some((provider) => provider.status === 'active'),
    hasKnowledgeEngine: knowledgeBases.length > 0,
    sandbox,
  };
}

function summarize(template: AgentTemplate, facts: TemplateFacts): AgentTemplateSummary {
  return {
    key: template.key,
    version: template.version,
    category: template.category,
    icon: template.icon,
    featured: template.featured === true,
    capabilities: template.capabilities,
    modelHint: template.modelHint,
    requires: template.requires,
    surfaces: template.surfaces,
    availability: computeTemplateAvailability(template, facts),
  };
}

export async function listTemplates(scope: AgentTemplateScope): Promise<AgentTemplateListResult> {
  const facts = await readTemplateFacts(scope);
  return {
    catalogVersion: AGENT_TEMPLATE_CATALOG_VERSION,
    templates: AGENT_TEMPLATES.map((template) => summarize(template, facts)),
  };
}

const templateNotFound = (key: string) => new AgentTemplateError(404, 'template_not_found', `Template "${key}" does not exist`);

export async function getTemplate(scope: AgentTemplateScope, key: string): Promise<AgentTemplateDetail> {
  const template = findAgentTemplate(key);
  if (!template) throw templateNotFound(key);
  const facts = await readTemplateFacts(scope);
  return {
    ...summarize(template, facts),
    spec: template.spec,
    resources: template.resources ?? null,
    triggers: template.triggers ?? [],
    tryIt: template.tryIt ?? null,
  };
}

// ── Creating an agent from a template ────────────────────────────────────

const NAME_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 1000;
const MAX_PICKS = 10;

export interface ParsedInstantiateInput {
  name?: string;
  description?: string;
  key?: string;
  modelKey: string;
  knowledgeKeys: string[];
  guardrailKeys: string[];
  sandboxTemplateKey?: string;
  createTriggers: boolean;
  timezone: string;
  publish: boolean;
  connectorId?: string;
  connectorIds: Record<string, string>;
  /** Parameters per suggested connector trigger, by its name in the template. */
  connectorParams: Record<string, Record<string, unknown>>;
}

const invalid = (code: string, message: string) => new AgentTemplateError(400, code, message);

function readKeyList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw invalid('invalid_request', `${field} must be a list of keys`);
  const keys = [...new Set((value as string[]).map((entry) => entry.trim()).filter(Boolean))];
  if (keys.length > MAX_PICKS) throw invalid('invalid_request', `${field} can name at most ${MAX_PICKS} entries`);
  return keys;
}

function readFlag(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw invalid('invalid_request', `${field} must be true or false`);
  return value;
}

/** `connector_ids`: connector ids by the suggested trigger's name. */
function readConnectorIds(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('invalid_request', 'connector_ids must be an object of trigger names to connector ids');
  const out: Record<string, string> = {};
  for (const [name, id] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id !== 'string' || !id.trim()) throw invalid('invalid_request', 'connector_ids must be an object of trigger names to connector ids');
    out[name] = id.trim();
  }
  return out;
}

/** `connector_params`: the parameters of each suggested connector trigger, by the trigger's name. */
function readConnectorParams(value: unknown): Record<string, Record<string, unknown>> {
  if (value === undefined || value === null) return {};
  const message = 'connector_params must be an object of trigger names to parameter objects';
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('invalid_request', message);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PICKS) throw invalid('invalid_request', `connector_params can name at most ${MAX_PICKS} triggers`);
  for (const [, params] of entries) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('invalid_request', message);
  }
  return Object.fromEntries(entries.map(([name, params]) => [name, params as Record<string, unknown>]));
}

function readOptionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid('invalid_request', `${field} must be text`);
  return value.trim() || undefined;
}

/** The body of an instantiate request, checked and given its defaults. Throws a 400 `AgentTemplateError`. */
export function parseInstantiateInput(raw: unknown): ParsedInstantiateInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('invalid_request', 'The body must be a JSON object');
  const body = raw as Record<string, unknown>;

  const modelKey = typeof body.modelKey === 'string' ? body.modelKey.trim() : '';
  if (!modelKey) throw invalid('invalid_model', 'Pick a chat model for the agent (modelKey)');

  const name = readOptionalText(body.name, 'name');
  if (name && name.length > NAME_MAX_LENGTH) throw invalid('invalid_request', `name can be at most ${NAME_MAX_LENGTH} characters`);

  const description = readOptionalText(body.description, 'description');
  if (description && description.length > DESCRIPTION_MAX_LENGTH) {
    throw invalid('invalid_request', `description can be at most ${DESCRIPTION_MAX_LENGTH} characters`);
  }

  const key = readOptionalText(body.key, 'key');
  if (key && !AGENT_KEY_PATTERN.test(key)) {
    throw invalid('invalid_key', 'key must be lower case letters, digits, "-" or "_", start with a letter or digit, and be at most 64 characters');
  }

  const timezone = readOptionalText(body.timezone, 'timezone') ?? DEFAULT_TRIGGER_TIMEZONE;
  if (!isValidTriggerTimezone(timezone)) throw invalid('invalid_timezone', 'timezone must be an IANA timezone name, like "Europe/Istanbul"');

  const sandboxTemplateKey = readOptionalText(body.sandboxTemplateKey, 'sandboxTemplateKey');
  const connectorId = readOptionalText(body.connector_id, 'connector_id');
  const connectorIds = readConnectorIds(body.connector_ids);
  const connectorParams = readConnectorParams(body.connector_params);
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(key ? { key } : {}),
    modelKey,
    knowledgeKeys: readKeyList(body.knowledgeKeys, 'knowledgeKeys'),
    guardrailKeys: readKeyList(body.guardrailKeys, 'guardrailKeys'),
    ...(sandboxTemplateKey ? { sandboxTemplateKey } : {}),
    createTriggers: readFlag(body.createTriggers, 'createTriggers', true),
    timezone,
    publish: readFlag(body.publish, 'publish', false),
    ...(connectorId ? { connectorId } : {}),
    connectorIds,
    connectorParams,
  };
}

/** Everything the user picked has to exist in this project, checked before anything is created. */
async function assertPicksExist(
  scope: AgentTemplateScope,
  template: AgentTemplate,
  input: ParsedInstantiateInput,
  deps: AgentTemplateWriteDeps,
): Promise<void> {
  const model = await runWithTenantScope(scope.tenantDbName, (db) => db.findModelByKey(input.modelKey, scope.projectId));
  if (!model) throw invalid('invalid_model', `Model "${input.modelKey}" does not exist in this project`);
  if (model.category !== 'llm') throw invalid('invalid_model', `Model "${input.modelKey}" is a ${model.category} model, not a chat model`);

  if (input.knowledgeKeys.length > 0 && !template.requires.knowledge) {
    throw invalid('knowledge_not_supported', `The "${template.key}" template does not use a knowledge base`);
  }
  for (const key of input.knowledgeKeys) {
    const found = await resolveAgentKnowledgeModule(scope.tenantDbName, key, scope.projectId).catch(() => null);
    if (!found) throw invalid('knowledge_not_found', `Knowledge base "${key}" does not exist in this project`);
  }
  for (const key of input.guardrailKeys) {
    if (!(await deps.guardrailExists(key))) throw invalid('guardrail_not_found', `Guardrail "${key}" does not exist in this project`);
  }
}

/** The sandbox template a sandbox template uses: the picked one, else `multi-base` when the tenant has it, else the first. */
async function resolveSandboxTemplateKey(scope: AgentTemplateScope, requested: string | undefined): Promise<string> {
  const availability = await resolveSandboxAvailability(scope.tenantId);
  if (!availability.available) {
    throw new AgentTemplateError(
      409,
      'sandbox_unavailable',
      availability.reason === 'license'
        ? 'This template needs the sandbox, which requires an Enterprise license'
        : 'This template needs the sandbox, which this edition does not include',
      { reason: availability.reason },
    );
  }
  const templates = await availability.runner.listTemplates(scope.tenantDbName, scope.tenantId).catch(() => null);
  const key = requested
    ?? templates?.find((template) => template.key === 'multi-base')?.key
    ?? templates?.[0]?.key;
  if (!key) throw invalid('sandbox_template_required', 'Pick a sandbox template (sandboxTemplateKey); the tenant has none yet');
  if (templates && !templates.some((template) => template.key === key)) {
    throw invalid('sandbox_template_not_found', `Sandbox template "${key}" does not exist`);
  }
  return key;
}

/**
 * Runs `work` after every earlier piece of work under the same name has
 * finished, whether that went well or not. In this process only: a second
 * server process racing for the same key is answered by the 409 in
 * `createFromTemplate`, and where the store has a unique index for agent keys
 * (SQLite) the insert refuses a duplicate anyway.
 */
const queues = new Map<string, Promise<void>>();

async function serialized<T>(name: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(name) ?? Promise.resolve()).then(work);
  const settled = run.then(() => undefined, () => undefined);
  queues.set(name, settled);
  try {
    return await run;
  } finally {
    if (queues.get(name) === settled) queues.delete(name);
  }
}

const agentKeyTaken = (scope: AgentTemplateScope, key: string) =>
  // Not scoped to the project: the stores keep one agent per key across the tenant's database.
  runWithTenantScope(scope.tenantDbName, async (db) => Boolean(await db.findAgentByKey(key)));

const keyConflict = (key: string) => new AgentTemplateError(409, 'agent_key_conflict', `An agent with the key "${key}" already exists`);

/** The key asked for (refused when taken), else the template key with `-2`, `-3` ... until it is free. */
async function chooseAgentKey(scope: AgentTemplateScope, template: AgentTemplate, requested: string | undefined): Promise<string> {
  if (requested) {
    if (await agentKeyTaken(scope, requested)) throw keyConflict(requested);
    return requested;
  }
  for (let attempt = 0; attempt < AGENT_KEY_MAX_ATTEMPTS; attempt += 1) {
    const candidate = agentKeyCandidate(template.key, attempt);
    if (!(await agentKeyTaken(scope, candidate))) return candidate;
  }
  throw new AgentTemplateError(409, 'agent_key_conflict', `No free key was found for "${template.key}"; pass a key`);
}

/**
 * The embedded skills: one the project already has under that key is reused as
 * it is (it may have been edited), a missing one is created. Returns the key
 * each is held under and records the ids this call created.
 */
async function ensureSkills(
  scope: AgentTemplateScope,
  template: AgentTemplate,
  userId: string,
  createdSkillIds: string[],
): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};
  for (const skill of template.resources?.skills ?? []) {
    const existing = await runWithTenantScope(scope.tenantDbName, (db) => db.findSkillByKey(skill.key, scope.projectId));
    if (existing) {
      keys[skill.key] = existing.key;
      continue;
    }
    const record = await createSkill(scope.tenantDbName, scope.tenantId, scope.projectId, userId, {
      key: skill.key,
      title: skill.title,
      header: skill.header,
      body: skill.body,
      ...(skill.minModelTier ? { minModelTier: skill.minModelTier } : {}),
    });
    createdSkillIds.push(String(record._id));
    keys[skill.key] = record.key;
  }
  return keys;
}

/** What the Studio would send an English-speaking caller for the agent's name and description. */
function defaultCopy(template: AgentTemplate): { name: string; summary: string } {
  const copy = (agentTemplatesEn.items as Record<string, { name: string; summary: string } | undefined>)[template.key];
  return { name: copy?.name ?? template.key, summary: copy?.summary ?? '' };
}

/** How many field errors a skipped trigger lists. */
const MAX_SKIP_ERRORS = 10;

/**
 * Why the Connectors module refused a suggested connector trigger, as a reason to leave it out - or null when the
 * refusal is about the template itself (its name, prompt, variables, filter), which is a defect to surface, not to hide.
 *
 * Only a refusal about the connector (it does not exist, is of another package, has no such trigger) or about what the
 * user supplies (the parameters, and the events and schedule the package checks) skips the trigger. Without parameters
 * given, a refusal that is all about parameters is `params_required`.
 */
export function connectorRefusal(
  errors: ReadonlyArray<{ field: string; message: string }>,
  paramsGiven: boolean,
): Pick<SkippedTemplateTrigger, 'reason' | 'errors'> | null {
  const aboutTarget = (field: string) => field === 'type' || field === 'connector.connector_id' || field === 'connector.trigger';
  const aboutParams = (field: string) => field === 'connector.params' || field.startsWith('connector.params.');
  const aboutSetup = (field: string) => aboutParams(field) || field.startsWith('connector.events') || field.startsWith('connector.schedule');
  if (errors.some((issue) => aboutTarget(issue.field))) return { reason: 'connector_required' };
  if (errors.length === 0 || !errors.every((issue) => aboutSetup(issue.field))) return null;
  const listed = errors.slice(0, MAX_SKIP_ERRORS).map((issue) => ({ field: issue.field, message: issue.message }));
  return { reason: !paramsGiven && errors.every((issue) => aboutParams(issue.field)) ? 'params_required' : 'invalid_params', errors: listed };
}

async function createSuggestedTriggers(
  scope: AgentTemplateScope,
  template: AgentTemplate,
  agent: IAgent,
  timezone: string,
  userId: string,
  deps: AgentTemplateWriteDeps,
  connectors: Pick<ParsedInstantiateInput, 'connectorId' | 'connectorIds' | 'connectorParams'>,
): Promise<{ created: InstantiatedTemplateTrigger[]; skipped: SkippedTemplateTrigger[] }> {
  const created: InstantiatedTemplateTrigger[] = [];
  const skipped: SkippedTemplateTrigger[] = [];
  const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);
  for (const suggestion of template.triggers ?? []) {
    // A connector trigger needs a connector of its package; without one (or without the module) it is left out.
    const connectorId = suggestion.type === 'connector'
      ? (own(connectors.connectorIds, suggestion.name) ? connectors.connectorIds[suggestion.name] : undefined) ?? connectors.connectorId
      : undefined;
    const params = suggestion.type === 'connector' && own(connectors.connectorParams, suggestion.name)
      ? givenConnectorParams(connectors.connectorParams[suggestion.name])
      : {};
    const skip = (refusal: Pick<SkippedTemplateTrigger, 'reason' | 'errors'>) =>
      skipped.push({ name: suggestion.name, package: suggestion.connector?.package ?? '', ...refusal });
    if (suggestion.type === 'connector' && (!suggestion.connector || !connectorId)) {
      skip({ reason: 'connector_required' });
      continue;
    }
    const prepared = await deps.prepareTriggerWrite({ body: buildTriggerBody(suggestion, timezone, connectorId, params), agent, actorId: userId });
    if (!prepared.ok && suggestion.type === 'connector') {
      // The module refused the picked connector (another package, deleted, none in this edition) or the parameters it needs.
      const refusal = connectorRefusal(prepared.errors, Object.keys(params).length > 0);
      if (refusal) {
        skip(refusal);
        continue;
      }
    }
    if (!prepared.ok) {
      const summary = prepared.errors.slice(0, 3).map((issue) => `${issue.field}: ${issue.message}`).join('; ');
      throw new AgentTemplateError(400, 'invalid_template_trigger', `The suggested trigger "${suggestion.name}" is not valid - ${summary}`, { issues: prepared.errors });
    }
    const { trigger, connectorView } = await createAgentTriggerHosted(
      scope,
      agent.key,
      { ...prepared.write, name: prepared.write.name!, prompt: prepared.write.prompt ?? '' } as NewTriggerWrite,
      userId,
    );
    const view = serializeAgentTrigger(trigger);
    created.push({
      id: view.id,
      name: view.name,
      type: view.type === 'schedule' || view.type === 'webhook' || view.type === 'connector' ? view.type : 'manual',
      enabled: view.enabled,
      ...(view.type === 'schedule' ? { schedule: view.schedule } : {}),
      ...(view.type === 'webhook'
        ? {
          webhook: {
            url: String(view.webhook.url),
            preset: String(view.webhook.preset),
            auth: String(view.webhook.auth),
            ...(prepared.webhookSecret ? { secret: prepared.webhookSecret } : {}),
          },
        }
        : {}),
      ...(view.type === 'connector'
        ? { connector: { connectorId: view.connector.connector_id, trigger: view.connector.trigger, subscription: toSubscriptionWire(connectorView) } }
        : {}),
    });
  }
  return { created, skipped };
}

/** Removes what a failed create left: the agent (its triggers go with it), then the skills this call added. Best effort, one by one. */
async function rollBack(scope: AgentTemplateScope, created: { agentId?: string; skillIds: string[] }): Promise<void> {
  if (created.agentId) {
    await deleteAgentRecord(scope.tenantDbName, created.agentId)
      .catch((error: unknown) => logger.warn('Template rollback could not delete the agent', { agentId: created.agentId, error }));
  }
  for (const skillId of created.skillIds) {
    await deleteSkill(scope.tenantDbName, scope.projectId, skillId)
      .catch((error: unknown) => logger.warn('Template rollback could not delete a skill', { skillId, error }));
  }
}

function invalidConfigError(body: Record<string, unknown>): AgentTemplateError {
  const validation = body.validation as { errors?: AgentConfigIssue[] } | undefined;
  return new AgentTemplateError(
    400,
    'invalid_template_config',
    typeof body.error === 'string' ? body.error : 'The template produced an invalid agent config',
    { issues: validation?.errors ?? [] },
  );
}

/**
 * Creates an agent from a template. See the file header for what is checked and
 * undone. `rawInput` is the request body as received.
 */
export async function instantiateTemplate(
  scope: AgentTemplateScope,
  templateKey: string,
  rawInput: unknown,
  userId: string,
  deps: AgentTemplateWriteDeps,
): Promise<InstantiateTemplateResult> {
  const template = findAgentTemplate(templateKey);
  if (!template) throw templateNotFound(templateKey);
  const input = parseInstantiateInput(rawInput);

  await assertPicksExist(scope, template, input, deps);
  const sandboxTemplateKey = template.requires.sandbox ? await resolveSandboxTemplateKey(scope, input.sandboxTemplateKey) : undefined;

  return serialized(scope.tenantDbName, () => createFromTemplate(scope, template, input, sandboxTemplateKey, userId, deps));
}

/** The all-or-nothing part of a create: everything it makes is removed again when a step fails. */
async function createFromTemplate(
  scope: AgentTemplateScope,
  template: AgentTemplate,
  input: ParsedInstantiateInput,
  sandboxTemplateKey: string | undefined,
  userId: string,
  deps: AgentTemplateWriteDeps,
): Promise<InstantiateTemplateResult> {
  const copy = defaultCopy(template);
  const templateRef = { key: template.key, version: template.version, catalogVersion: AGENT_TEMPLATE_CATALOG_VERSION };

  const created: { agentId?: string; claimedKey?: string; skillIds: string[] } = { skillIds: [] };
  try {
    const skillKeys = await ensureSkills(scope, template, userId, created.skillIds);
    const prepared = await deps.prepareAgentConfig(buildTemplateConfig(template, {
      modelKey: input.modelKey,
      knowledgeKeys: input.knowledgeKeys,
      guardrailKeys: input.guardrailKeys,
      sandboxTemplateKey,
      skillKeys,
    }));
    if ('forbidden' in prepared) {
      throw new AgentTemplateError(403, 'forbidden', typeof prepared.forbidden.error === 'string' ? prepared.forbidden.error : 'Not allowed', prepared.forbidden);
    }
    if ('badRequest' in prepared) throw invalidConfigError(prepared.badRequest);

    // Chosen as late as possible: the checks above are the slow part, and the key may have been taken meanwhile.
    created.claimedKey = await chooseAgentKey(scope, template, input.key);
    const description = input.description ?? copy.summary;
    const agent = await createAgentRecord(scope.tenantDbName, scope.tenantId, scope.projectId, userId, {
      name: input.name ?? copy.name,
      ...(description ? { description } : {}),
      config: prepared.config,
      key: created.claimedKey,
      metadata: { template: templateRef },
    });
    created.agentId = String(agent._id);

    const { created: triggers, skipped: skippedTriggers } = input.createTriggers
      ? await createSuggestedTriggers(scope, template, agent, input.timezone, userId, deps, input)
      : { created: [], skipped: [] };
    if (input.publish) {
      await publishAgent(scope.tenantDbName, created.agentId, userId, `Created from the "${template.key}" template`);
    }

    const webSearchAvailable = template.requires.webSearch
      ? (await listWebSearchProviders(scope.tenantDbName, scope.tenantId, scope.projectId).catch(softly('the web search providers', [])))
        .some((provider) => provider.status === 'active')
      : true;
    const result: InstantiateTemplateResult = {
      agent: (await getAgentById(scope.tenantDbName, created.agentId)) ?? agent,
      template: templateRef,
      triggers,
      skipped_triggers: skippedTriggers,
      setup: buildSetupItems({
        template,
        knowledgeKeys: input.knowledgeKeys,
        guardrailKeys: input.guardrailKeys,
        webSearchAvailable,
        published: input.publish,
        triggers,
      }),
      warnings: prepared.warnings,
    };
    logger.info('Agent created from a template', {
      template: template.key,
      version: template.version,
      agentKey: agent.key,
      projectId: scope.projectId,
      triggers: triggers.length,
      published: input.publish,
    });
    return result;
  } catch (error) {
    await rollBack(scope, created);
    if (error instanceof AgentTemplateError) throw error;
    // Another server process took the key between the choosing and the insert.
    if (!created.agentId && created.claimedKey && (await agentKeyTaken(scope, created.claimedKey).catch(() => false))) {
      throw keyConflict(created.claimedKey);
    }
    throw error;
  }
}
