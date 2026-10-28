/**
 * The pure part of the agent template screens: what the gallery shows for a
 * search and a filter, what a template will create, when the "use template"
 * form may be submitted, the body it sends and how the answer is read. No
 * React, so the rules are tested without rendering.
 */

import type {
  AgentTemplateAvailabilityItem,
  AgentTemplateCapability,
  AgentTemplateCategory,
  AgentTemplateDetail,
  AgentTemplateSummary,
  AgentTemplateTrigger,
  InstantiateTemplateInput,
  InstantiateTemplateResult,
  InstantiatedTemplateTrigger,
  SkippedTemplateTrigger,
} from '@/lib/services/agents/templates/types';
import { givenConnectorParams } from '@/lib/services/agents/templates/templateConfig';
import { AGENT_TEMPLATE_CATEGORIES } from '@/lib/services/agents/templates/types';

export const AGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ── Gallery ──────────────────────────────────────────────────────────────

export interface GalleryFilter {
  query: string;
  category: AgentTemplateCategory | 'all';
  capabilities: ReadonlySet<AgentTemplateCapability>;
}

export const EMPTY_GALLERY_FILTER: GalleryFilter = { query: '', category: 'all', capabilities: new Set() };

export function isFilterActive(filter: GalleryFilter): boolean {
  return Boolean(filter.query.trim()) || filter.category !== 'all' || filter.capabilities.size > 0;
}

/**
 * The templates a search and the filters leave. `searchText` gives the words a
 * template is found by (its translated name, summary and key); every word of the
 * query must be in them. A template must carry ALL the chosen capabilities.
 */
export function filterTemplates(
  templates: AgentTemplateSummary[],
  filter: GalleryFilter,
  searchText: (template: AgentTemplateSummary) => string,
): AgentTemplateSummary[] {
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return templates.filter((template) => {
    if (filter.category !== 'all' && template.category !== filter.category) return false;
    for (const capability of filter.capabilities) {
      if (!template.capabilities.includes(capability)) return false;
    }
    if (words.length === 0) return true;
    const haystack = searchText(template).toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export interface GalleryGroups {
  featured: AgentTemplateSummary[];
  /** Categories in the catalog's order; empty ones left out. A featured template is listed in its category too. */
  categories: Array<{ category: AgentTemplateCategory; templates: AgentTemplateSummary[] }>;
}

export function groupTemplates(templates: AgentTemplateSummary[]): GalleryGroups {
  return {
    featured: templates.filter((template) => template.featured),
    categories: AGENT_TEMPLATE_CATEGORIES
      .map((category) => ({ category, templates: templates.filter((template) => template.category === category) }))
      .filter((group) => group.templates.length > 0),
  };
}

/** A template that cannot be created in this deployment (the sandbox module is missing). */
export function isUsable(template: Pick<AgentTemplateSummary, 'availability'>): boolean {
  return template.availability.status !== 'unavailable';
}

/** The reason of an `unavailable` template, as a key under `availability.sandboxReasons` when it has one. */
export function unavailableDetail(template: Pick<AgentTemplateSummary, 'availability'>): AgentTemplateAvailabilityItem | null {
  return template.availability.items.find((item) => item.code === 'sandbox_unavailable') ?? null;
}

// ── What a template will create ──────────────────────────────────────────

export interface TemplateContents {
  tools: string[];
  skills: Array<{ key: string; title: string }>;
  subagents: Array<{ name: string; title: string; header: string }>;
  variables: Array<{ name: string; type: string; default: string | null }>;
  outputFields: string[];
  clientTools: string[];
  guardrailsRecommended: boolean;
  needsSandbox: boolean;
}

function formatDefault(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function describeContents(template: AgentTemplateDetail): TemplateContents {
  const spec = template.spec as {
    toolBindings?: Array<{ toolNames?: string[] }>;
    skills?: string[];
    subagents?: Array<{ name: string; title?: string; header?: string }>;
    variables?: Array<{ name: string; type: string; default?: unknown }>;
    structuredOutput?: { enabled?: boolean; schema?: { properties?: Record<string, unknown> } };
    clientTools?: Array<{ name: string }>;
  };
  const skillTitles = new Map((template.resources?.skills ?? []).map((skill) => [skill.key, skill.title]));
  const tools = (spec.toolBindings ?? []).flatMap((binding) => binding.toolNames ?? []);
  return {
    tools: [...new Set(tools)],
    skills: (spec.skills ?? []).map((key) => ({ key, title: skillTitles.get(key) ?? key })),
    subagents: (spec.subagents ?? []).map((sub) => ({ name: sub.name, title: sub.title ?? sub.name, header: sub.header ?? '' })),
    variables: (spec.variables ?? []).map((variable) => ({
      name: variable.name,
      type: variable.type,
      default: formatDefault(variable.default),
    })),
    outputFields: spec.structuredOutput?.enabled ? Object.keys(spec.structuredOutput.schema?.properties ?? {}) : [],
    clientTools: (spec.clientTools ?? []).map((tool) => tool.name),
    guardrailsRecommended: template.requires.guardrails === 'recommended',
    needsSandbox: template.requires.sandbox === 'required',
  };
}

export type TriggerLine =
  | { kind: 'schedule'; cron: string; name: string }
  | { kind: 'webhook'; preset: string; events: string[]; name: string }
  | { kind: 'connector'; package: string; trigger: string; events: string[]; name: string }
  | { kind: 'manual'; name: string };

export function describeTrigger(trigger: AgentTemplateTrigger): TriggerLine {
  if (trigger.type === 'schedule') return { kind: 'schedule', cron: trigger.schedule?.cron ?? '', name: trigger.name };
  if (trigger.type === 'webhook') {
    return { kind: 'webhook', preset: trigger.webhook?.preset ?? 'generic', events: trigger.webhook?.events ?? [], name: trigger.name };
  }
  if (trigger.type === 'connector') {
    return { kind: 'connector', package: trigger.connector?.package ?? '', trigger: trigger.connector?.trigger ?? '', events: trigger.connector?.events ?? [], name: trigger.name };
  }
  return { kind: 'manual', name: trigger.name };
}

/** The connector packages the template's connector triggers listen to, in the order they first appear. */
export function connectorPackages(template: Pick<AgentTemplateDetail, 'triggers'>): string[] {
  const packages = template.triggers.flatMap((trigger) => (trigger.type === 'connector' && trigger.connector ? [trigger.connector.package] : []));
  return [...new Set(packages)];
}

// ── The "use template" form ──────────────────────────────────────────────

export interface UseTemplateForm {
  name: string;
  key: string;
  modelKey: string | null;
  knowledgeKeys: string[];
  knowledgeLater: boolean;
  guardrailKeys: string[];
  sandboxTemplateKey: string | null;
  createTriggers: boolean;
  /** The connector picked per package (`null` = none on purpose); a package that is absent has not been decided yet. */
  connectors: Record<string, string | null>;
  /** What each connector trigger's package trigger needs (a repository), by the trigger's name in the template. */
  connectorParams: Record<string, Record<string, unknown>>;
  timezone: string;
  publish: boolean;
}

/** The connector ids of each package the project has, as the connector select lists them. */
export type ConnectorChoices = Record<string, readonly string[]>;

/** The connector a package's triggers will listen to: the one picked, else the only one the project has, else none. */
export function selectedConnector(form: Pick<UseTemplateForm, 'connectors'>, pkg: string, available: readonly string[]): string | null {
  const picked = form.connectors[pkg];
  if (picked !== undefined) return picked !== null && available.includes(picked) ? picked : null;
  return available.length === 1 ? available[0]! : null;
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function initialForm(
  template: Pick<AgentTemplateDetail, 'requires' | 'triggers'>,
  defaults: { models: string[]; sandboxTemplates: string[] },
  timezone: string = browserTimezone(),
): UseTemplateForm {
  const sandboxDefault = defaults.sandboxTemplates.includes('multi-base') ? 'multi-base' : (defaults.sandboxTemplates[0] ?? null);
  return {
    name: '',
    key: '',
    modelKey: defaults.models.length === 1 ? defaults.models[0] : null,
    knowledgeKeys: [],
    knowledgeLater: false,
    guardrailKeys: [],
    sandboxTemplateKey: template.requires.sandbox ? sandboxDefault : null,
    createTriggers: template.triggers.length > 0,
    connectors: {},
    connectorParams: {},
    timezone,
    publish: false,
  };
}

export type FormBlocker = 'name' | 'model' | 'knowledge' | 'sandbox' | 'key' | 'unavailable';

/** What stops the form from being submitted, in the order the sections come. */
export function formBlockers(template: AgentTemplateDetail, form: UseTemplateForm): FormBlocker[] {
  const blockers: FormBlocker[] = [];
  if (!isUsable(template)) blockers.push('unavailable');
  if (!form.name.trim()) blockers.push('name');
  if (form.key.trim() && !AGENT_KEY_PATTERN.test(form.key.trim())) blockers.push('key');
  if (!form.modelKey) blockers.push('model');
  if (template.requires.knowledge === 'required' && form.knowledgeKeys.length === 0 && !form.knowledgeLater) blockers.push('knowledge');
  if (template.requires.sandbox === 'required' && !form.sandboxTemplateKey) blockers.push('sandbox');
  return blockers;
}

/**
 * The body of `POST /api/agents/templates/:key/instantiate`. `connectors` lists the connectors the project has per
 * package: the connector triggers get the one selected for their package (and the parameters filled in for them), and
 * are left to the server to skip without one.
 */
export function buildInstantiateBody(template: AgentTemplateDetail, form: UseTemplateForm, connectors: ConnectorChoices = {}): InstantiateTemplateInput {
  const name = form.name.trim();
  const key = form.key.trim();
  const body: InstantiateTemplateInput = { name, modelKey: form.modelKey ?? '' };
  if (key) body.key = key;
  if (template.requires.knowledge && form.knowledgeKeys.length > 0) body.knowledgeKeys = form.knowledgeKeys;
  if (form.guardrailKeys.length > 0) body.guardrailKeys = form.guardrailKeys;
  if (template.requires.sandbox && form.sandboxTemplateKey) body.sandboxTemplateKey = form.sandboxTemplateKey;
  if (template.triggers.length > 0) body.createTriggers = form.createTriggers;
  if (form.createTriggers) {
    const ids: Record<string, string> = {};
    const params: Record<string, Record<string, unknown>> = {};
    for (const trigger of template.triggers) {
      if (trigger.type !== 'connector' || !trigger.connector) continue;
      const id = selectedConnector(form, trigger.connector.package, connectors[trigger.connector.package] ?? []);
      if (!id) continue;
      ids[trigger.name] = id;
      const given = givenConnectorParams(form.connectorParams[trigger.name]);
      if (Object.keys(given).length > 0) params[trigger.name] = given;
    }
    if (Object.keys(ids).length > 0) body.connector_ids = ids;
    if (Object.keys(params).length > 0) body.connector_params = params;
  }
  body.timezone = form.timezone || 'UTC';
  body.publish = form.publish;
  return body;
}

export class InstantiateRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/**
 * Creates the agent. Throws `InstantiateRequestError` with the server's own message when it refuses. `locale` is the
 * reader's language: the Connectors module writes the texts of a connector trigger it creates in it.
 */
export async function instantiateTemplateRequest(
  templateKey: string,
  body: InstantiateTemplateInput,
  fetchImpl: typeof fetch = fetch,
  locale?: string,
): Promise<InstantiateTemplateResult> {
  const path = `/api/agents/templates/${encodeURIComponent(templateKey)}/instantiate`;
  const res = await fetchImpl(locale === 'tr' || locale === 'en' ? `${path}?locale=${locale}` : path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new InstantiateRequestError(typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`, res.status, data?.code);
  return data as InstantiateTemplateResult;
}

// ── The result ───────────────────────────────────────────────────────────

/** The triggers whose webhook the sender still has to be given. */
export function webhookTriggers(result: Pick<InstantiateTemplateResult, 'triggers'>): InstantiatedTemplateTrigger[] {
  return result.triggers.filter((trigger) => Boolean(trigger.webhook));
}

/** The connector triggers the project could not get: the template asked for a connector that was not given (or the module is absent). */
export function skippedTriggers(result: Pick<InstantiateTemplateResult, 'skipped_triggers'>): SkippedTemplateTrigger[] {
  return result.skipped_triggers ?? [];
}

export interface SkippedDescription {
  /** `connector`: needs a connector; `params`: needs values for its parameters; `invalid`: the package refused what was given. */
  kind: 'connector' | 'params' | 'invalid';
  /** The parameters the errors name (`connector.params.repository` is `repository`). */
  params: string[];
  /** What the connector module said about the rest (events, schedule, a refused value). */
  messages: string[];
}

const PARAM_FIELD = /^connector\.params\.(.+)$/;

/** What to tell the user about a trigger that was left out: the reason, the parameters it is missing and the refusals. */
export function describeSkipped(item: SkippedTemplateTrigger): SkippedDescription {
  const errors = item.errors ?? [];
  const params = [...new Set(errors.flatMap((error) => {
    const match = PARAM_FIELD.exec(error.field);
    return match ? [match[1]!] : [];
  }))];
  if (item.reason === 'params_required') {
    return { kind: 'params', params, messages: errors.filter((error) => !PARAM_FIELD.test(error.field)).map((error) => error.message) };
  }
  if (item.reason === 'invalid_params') return { kind: 'invalid', params, messages: [...new Set(errors.map((error) => error.message))] };
  return { kind: 'connector', params: [], messages: [] };
}

/** The connector triggers set up by hand: the sender still has to be given the callback URL (and, once, the secret). */
export function manualConnectorTriggers(result: Pick<InstantiateTemplateResult, 'triggers'>): InstantiatedTemplateTrigger[] {
  return result.triggers.filter((trigger) => trigger.connector?.subscription?.status === 'manual' && Boolean(trigger.connector.subscription.callback_url));
}
