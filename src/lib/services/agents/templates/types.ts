/**
 * Agent templates: a curated, versioned catalog of ready-made agents a user can
 * browse, inspect and turn into a real, editable agent in their project in one
 * step.
 *
 * Types and constants only - no database, React or server imports (type-only
 * imports are erased) - so the server, the dashboard and the tests share them,
 * the way the guardrail catalog does.
 *
 * A template carries the agent's CONFIG without a model and without any
 * tenant-local key. What belongs to the project (the model, knowledge bases,
 * guardrails, the sandbox template) is chosen when the template is turned into
 * an agent. Display strings (names, summaries, use cases) are not here: they
 * live in the message files (`agentTemplates.en.ts` / `.tr.ts`), keyed by the
 * template key.
 */

import type {
  AgentTriggerWebhookFilterRule,
  AgentTriggerWebhookPreset,
  IAgent,
  IAgentConfig,
} from '@/lib/database';
import type { ConnectorSubscriptionWire } from '@/lib/shared/connectorTriggers';
import type { ManifestResources } from '@/lib/services/agents/manifestResources';

/** The order the gallery lists the categories in. */
export const AGENT_TEMPLATE_CATEGORIES = [
  'support',
  'knowledge',
  'engineering',
  'research',
  'sales_marketing',
  'operations',
  'multi_agent',
] as const;
export type AgentTemplateCategory = typeof AGENT_TEMPLATE_CATEGORIES[number];

/** What a template shows off: the chips on a card and the filter of the gallery. */
export const AGENT_TEMPLATE_CAPABILITIES = [
  'knowledge',
  'web_search',
  'mcp',
  'client_tools',
  'approval',
  'ask_user',
  'subagents',
  'skills',
  'structured_output',
  'variables',
  'schedule',
  'webhook',
  'sandbox',
  'guardrails',
] as const;
export type AgentTemplateCapability = typeof AGENT_TEMPLATE_CAPABILITIES[number];

/** The kind of model the template was written for (the picker shows it as a hint; any chat model is accepted). */
export const AGENT_TEMPLATE_MODEL_HINTS = ['fast', 'balanced', 'reasoning'] as const;
export type AgentTemplateModelHint = typeof AGENT_TEMPLATE_MODEL_HINTS[number];

/** Where a template is meant to be used. */
export const AGENT_TEMPLATE_SURFACES = ['chat', 'api', 'trigger'] as const;
export type AgentTemplateSurface = typeof AGENT_TEMPLATE_SURFACES[number];

/** A suggested trigger. Always created DISABLED, so nothing fires before the owner has reviewed it. */
export interface AgentTemplateTrigger {
  /** English; the owner can rename it. */
  name: string;
  type: 'schedule' | 'webhook' | 'manual' | 'connector';
  /** The timezone is the one the user picked when creating the agent (their browser's by default, else UTC). */
  schedule?: { cron: string };
  webhook?: {
    preset: AgentTriggerWebhookPreset;
    events?: string[];
    filter?: AgentTriggerWebhookFilterRule[];
    include_payload?: boolean;
  };
  /**
   * Connector: an event of a connector package (`package` = the package id,
   * `trigger` = one it declares). The trigger is created on the connector the
   * user picks at instantiate time (`connector_id`); without one it is skipped.
   */
  connector?: {
    package: string;
    trigger: string;
    params?: Record<string, unknown>;
    events?: string[];
    filter?: AgentTriggerWebhookFilterRule[];
    includePayload: boolean;
  };
  /**
   * Webhook and connector: a Mustache template over the event (`payload`, `headers`,
   * `event`, `delivery_id`, `preset`, `trigger`, `agent`, `connector`; never `received_at`).
   * Other types: the literal message.
   */
  prompt: string;
  /** Values for the variables the agent declares. A webhook's values may be templates over the delivery. */
  variables?: Record<string, unknown>;
}

export interface AgentTemplate {
  /** Kebab case, stable forever. */
  key: string;
  /** Raised whenever the content of the template changes. */
  version: number;
  category: AgentTemplateCategory;
  /** The name of a `@tabler/icons-react` component, e.g. `IconHeadset`. */
  icon: string;
  featured?: boolean;
  capabilities: AgentTemplateCapability[];
  modelHint: AgentTemplateModelHint;
  /** What the project needs for the template to work; drives availability and the sections of the create form. */
  requires: {
    knowledge?: 'required' | 'optional';
    webSearch?: 'required' | 'optional';
    sandbox?: 'required';
    guardrails?: 'recommended';
  };
  surfaces: AgentTemplateSurface[];
  /** The agent's config without a model and without tenant-local keys (knowledge, guardrails, MCP servers, tools, buckets). */
  spec: Omit<IAgentConfig, 'modelKey'>;
  /** Definitions created along with the agent (embedded skills, keys prefixed `tpl-`). */
  resources?: Pick<ManifestResources, 'skills'>;
  triggers?: AgentTemplateTrigger[];
  /** A sample first message (and variables) for trying the agent in the playground. */
  tryIt?: { message: string; variables?: Record<string, unknown> };
}

// ── What the API answers ─────────────────────────────────────────────────

/** Why a template is not ready as it stands. */
export const AGENT_TEMPLATE_AVAILABILITY_CODES = [
  'no_llm_model',
  'sandbox_unavailable',
  'sandbox_template_missing',
  'web_search_unavailable',
  'knowledge_missing',
] as const;
export type AgentTemplateAvailabilityCode = typeof AGENT_TEMPLATE_AVAILABILITY_CODES[number];

export interface AgentTemplateAvailabilityItem {
  code: AgentTemplateAvailabilityCode;
  /** A `blocker` has to be fixed for the agent to work; a `warning` only limits it. */
  severity: 'blocker' | 'warning';
  /** For `sandbox_unavailable`: `edition` (no sandbox module in this build) or `license` (no Enterprise license). */
  detail?: string;
}

/**
 * - `ready`: can be created and works as it is.
 * - `needs_setup`: can be created, but something the project lacks has to be
 *   set up first (a model, a web search provider, a knowledge base).
 * - `unavailable`: cannot be created in this deployment (the sandbox module).
 */
export type AgentTemplateAvailabilityStatus = 'ready' | 'needs_setup' | 'unavailable';

export interface AgentTemplateAvailability {
  status: AgentTemplateAvailabilityStatus;
  items: AgentTemplateAvailabilityItem[];
}

/** A template as the gallery lists it: structure only (the texts come from the message files). */
export interface AgentTemplateSummary {
  key: string;
  version: number;
  category: AgentTemplateCategory;
  icon: string;
  featured: boolean;
  capabilities: AgentTemplateCapability[];
  modelHint: AgentTemplateModelHint;
  requires: AgentTemplate['requires'];
  surfaces: AgentTemplateSurface[];
  availability: AgentTemplateAvailability;
}

/** A template with everything the detail view and the create form need. */
export interface AgentTemplateDetail extends AgentTemplateSummary {
  spec: AgentTemplate['spec'];
  resources: AgentTemplate['resources'] | null;
  triggers: AgentTemplateTrigger[];
  tryIt: AgentTemplate['tryIt'] | null;
}

export interface AgentTemplateListResult {
  catalogVersion: number;
  templates: AgentTemplateSummary[];
}

// ── Creating an agent from a template ────────────────────────────────────

export interface InstantiateTemplateInput {
  /** The agent's name. Default: the template's English name. */
  name?: string;
  /** The agent's description. Default: the template's English summary. */
  description?: string;
  /** The agent's key. Default: the template key, with `-2`, `-3` ... added while it is taken. A key given here that is taken is refused. */
  key?: string;
  /** The main model: a chat model of the project. */
  modelKey: string;
  knowledgeKeys?: string[];
  guardrailKeys?: string[];
  /** Templates that need the sandbox: its template key. Default: `multi-base` when the tenant has it. */
  sandboxTemplateKey?: string;
  /** Create the suggested triggers (disabled). Default true. */
  createTriggers?: boolean;
  /** IANA timezone of the suggested schedules. Default `UTC`. */
  timezone?: string;
  /** Publish version 1 right away (API, triggers and A2A run the published version). Default false. */
  publish?: boolean;
  /** The connector the template's connector triggers listen to (every connector trigger without an entry in `connector_ids`). */
  connector_id?: string;
  /** Connector per suggested connector trigger, by the trigger's name in the template. */
  connector_ids?: Record<string, string>;
}

/** What is left to do after the agent exists. */
export const AGENT_TEMPLATE_SETUP_CODES = [
  'knowledge_not_bound',
  'web_search_unavailable',
  'guardrails_recommended',
  'client_tools',
  'publish_needed',
  'triggers_disabled',
  'webhook_secret',
] as const;
export type AgentTemplateSetupCode = typeof AGENT_TEMPLATE_SETUP_CODES[number];

export interface AgentTemplateSetupItem {
  code: AgentTemplateSetupCode;
  severity: 'info' | 'warning';
  /** English text; the dashboard shows its own translation of `code`. */
  message: string;
  /** For `client_tools`: the tool names; for `triggers_disabled`: the trigger names. */
  detail?: string;
}

export interface InstantiatedTemplateTrigger {
  id: string;
  name: string;
  type: AgentTemplateTrigger['type'];
  enabled: boolean;
  schedule?: { cron: string; timezone: string };
  /** The URL to give the sender and the secret it signs with: shown this once, only its last four characters after that. */
  webhook?: { url: string; preset: string; auth: string; secret?: string };
  /** A connector trigger: the connector and the subscription it was bound to (its secret, in manual setup, is shown this once). */
  connector?: { connectorId: string; trigger: string; subscription: ConnectorSubscriptionWire | null };
}

/** A suggested trigger that was not created. */
export interface SkippedTemplateTrigger {
  name: string;
  /** `connector_required`: no connector was picked for it (or the Connectors module is not part of this edition). */
  reason: 'connector_required';
  /** The connector package the trigger needs. */
  package: string;
}

export interface InstantiateTemplateResult {
  agent: IAgent;
  template: { key: string; version: number; catalogVersion: number };
  triggers: InstantiatedTemplateTrigger[];
  /** Suggested triggers that need a connector and were not created. */
  skipped_triggers: SkippedTemplateTrigger[];
  setup: AgentTemplateSetupItem[];
  /** Notes from the same validation a Studio save runs (they do not stop the agent from being created). */
  warnings: Array<{ field: string; message: string }>;
}
