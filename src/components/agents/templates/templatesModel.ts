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
} from '@/lib/services/agents/templates/types';
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
  | { kind: 'manual'; name: string };

export function describeTrigger(trigger: AgentTemplateTrigger): TriggerLine {
  if (trigger.type === 'schedule') return { kind: 'schedule', cron: trigger.schedule?.cron ?? '', name: trigger.name };
  if (trigger.type === 'webhook') {
    return { kind: 'webhook', preset: trigger.webhook?.preset ?? 'generic', events: trigger.webhook?.events ?? [], name: trigger.name };
  }
  return { kind: 'manual', name: trigger.name };
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
  timezone: string;
  publish: boolean;
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

/** The body of `POST /api/agents/templates/:key/instantiate`. */
export function buildInstantiateBody(template: AgentTemplateDetail, form: UseTemplateForm): InstantiateTemplateInput {
  const name = form.name.trim();
  const key = form.key.trim();
  const body: InstantiateTemplateInput = { name, modelKey: form.modelKey ?? '' };
  if (key) body.key = key;
  if (template.requires.knowledge && form.knowledgeKeys.length > 0) body.knowledgeKeys = form.knowledgeKeys;
  if (form.guardrailKeys.length > 0) body.guardrailKeys = form.guardrailKeys;
  if (template.requires.sandbox && form.sandboxTemplateKey) body.sandboxTemplateKey = form.sandboxTemplateKey;
  if (template.triggers.length > 0) body.createTriggers = form.createTriggers;
  body.timezone = form.timezone || 'UTC';
  body.publish = form.publish;
  return body;
}

export class InstantiateRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** Creates the agent. Throws `InstantiateRequestError` with the server's own message when it refuses. */
export async function instantiateTemplateRequest(
  templateKey: string,
  body: InstantiateTemplateInput,
  fetchImpl: typeof fetch = fetch,
): Promise<InstantiateTemplateResult> {
  const res = await fetchImpl(`/api/agents/templates/${encodeURIComponent(templateKey)}/instantiate`, {
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
