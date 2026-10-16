/**
 * Alert rule templates: a catalog of recommended rules any project can browse
 * and add from the Alerts page. The templates marked `default` form the default
 * set that every new project gets (enabled).
 *
 * The default set is one threshold rule per entity module, on the error rate,
 * over every entity of that module, so new agents, models and servers are
 * covered as they appear. A window needs at least 20 samples (one failed call
 * out of one would read as 100%) and the breach must hold for 10 minutes before
 * the rule fires. Notifications go to the project's admins, or to the workspace
 * owners and admins when the project has none.
 *
 * Inference (tenant-wide servers) and the AI App Gateway (its enterprise
 * collector does not filter by project yet) have no templates on purpose: a
 * rule of one project would watch every project's traffic.
 */

import { randomUUID } from 'crypto';
import { getCache } from '@/lib/core/cache';
import type { CacheProvider } from '@/lib/core/cache';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getTenantDatabase, runWithTenantScope } from '@/lib/database';
import type {
  AlertConditionMode,
  AlertMetric,
  AlertModule,
  IAlertCondition,
  IAlertRule,
} from '@/lib/database';
import { AlertApiError } from './alertApiError';
import { AlertService, type CreateAlertRuleInput } from './alertService';
import { resolveProjectAdminRecipients } from './channels/emailChannel';
import { getMetricDef } from './metricCatalog';
import { createModeGate, type ModeAvailability, type ModeGate } from './modeAvailability';
import { getCollectorForMetric } from './metrics';

const log = createLogger('alerts:templates');

/** The current definitions. A rule keeps the version of the template it was added at. */
export const ALERT_TEMPLATE_CATALOG_VERSION = 1;

export type AlertTemplateCategory = 'errors' | 'latency' | 'traffic' | 'cost' | 'quality' | 'safety';

export const ALERT_TEMPLATE_CATEGORIES: readonly AlertTemplateCategory[] = [
  'errors', 'latency', 'traffic', 'cost', 'quality', 'safety',
];

/** The condition of a template: its mode is always spelled out. */
export type AlertTemplateCondition = IAlertCondition & { mode: AlertConditionMode };

export interface AlertTemplateDefinition {
  /** Kebab-case and stable: rules refer to it. */
  key: string;
  /** Bumped when this template's rule changes. */
  version: number;
  category: AlertTemplateCategory;
  module: AlertModule;
  metric: AlertMetric;
  /** The created rule's name. */
  name: string;
  /** The created rule's description. */
  description: string;
  /** Part of the default set added to new projects. */
  default?: true;
  condition: AlertTemplateCondition;
  windowMinutes: number;
  cooldownMinutes: number;
}

// ── Catalog ─────────────────────────────────────────────────────────────────

function threshold(operator: 'gt' | 'lt', value: number, forMinutes: number, minSamples: number): AlertTemplateCondition {
  return { mode: 'threshold', operator, threshold: value, forMinutes, minSamples };
}

/** The modes without a threshold keep a well-formed one (see `normalizeCondition`). */
function absence(lookbackHours: number, minExpectedPerWindow: number): AlertTemplateCondition {
  return { mode: 'absence', operator: 'gt', threshold: 0, forMinutes: 0, minSamples: 1, absence: { lookbackHours, minExpectedPerWindow } };
}

/** Fast burn of a 99% objective over 30 days: both the last hour and the last 5 minutes spend the budget 14.4 times too fast. */
function errorBudgetBurn(): AlertTemplateCondition {
  return {
    mode: 'slo_burn',
    operator: 'gt',
    threshold: 0,
    forMinutes: 0,
    minSamples: 50,
    slo: { objectivePct: 99, windowDays: 30, burnRate: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5 },
  };
}

/** At least twice the usual for this hour of the day, and at least $1 more. */
function costSpike(): AlertTemplateCondition {
  return {
    mode: 'baseline',
    operator: 'gt',
    threshold: 0,
    forMinutes: 0,
    minSamples: 20,
    baseline: { direction: 'up', minRatio: 2, minZ: 3, minDelta: 1, lookbackDays: 14, seasonality: 'daily' },
  };
}

export const ALERT_TEMPLATES: readonly AlertTemplateDefinition[] = [
  // ── errors ────────────────────────────────────────────────────────────
  {
    key: 'agent-errors', version: 1, category: 'errors', module: 'agents', metric: 'agent_error_rate', default: true,
    name: 'Agent error rate above 20%',
    description: 'An agent fails more than 20% of its runs over 30 minutes (at least 20 runs).',
    condition: threshold('gt', 20, 10, 20), windowMinutes: 30, cooldownMinutes: 120,
  },
  {
    key: 'model-errors', version: 1, category: 'errors', module: 'models', metric: 'model_error_rate', default: true,
    name: 'Model error rate above 20%',
    description: 'A model fails more than 20% of its requests over 30 minutes (at least 20 requests).',
    condition: threshold('gt', 20, 10, 20), windowMinutes: 30, cooldownMinutes: 120,
  },
  {
    key: 'kb-errors', version: 1, category: 'errors', module: 'rag', metric: 'kb_error_rate', default: true,
    name: 'Knowledge base error rate above 20%',
    description: 'A knowledge base fails more than 20% of its queries over 30 minutes (at least 20 queries).',
    condition: threshold('gt', 20, 10, 20), windowMinutes: 30, cooldownMinutes: 120,
  },
  {
    key: 'mcp-errors', version: 1, category: 'errors', module: 'mcp', metric: 'mcp_server_error_rate', default: true,
    name: 'MCP server error rate above 30%',
    description: 'An MCP server fails more than 30% of its requests over 30 minutes (at least 20 requests).',
    condition: threshold('gt', 30, 10, 20), windowMinutes: 30, cooldownMinutes: 120,
  },
  {
    key: 'tool-errors', version: 1, category: 'errors', module: 'tools', metric: 'tool_error_rate', default: true,
    name: 'Tool error rate above 30%',
    description: 'A tool fails more than 30% of its calls over 30 minutes (at least 20 calls).',
    condition: threshold('gt', 30, 10, 20), windowMinutes: 30, cooldownMinutes: 120,
  },
  {
    key: 'agent-tool-errors', version: 1, category: 'errors', module: 'agents', metric: 'agent_tool_error_rate',
    name: 'Agent tool calls failing above 25%',
    description: 'More than 25% of the tool calls an agent makes fail over 30 minutes (at least 20 calls).',
    condition: threshold('gt', 25, 10, 20), windowMinutes: 30, cooldownMinutes: 120,
  },
  {
    key: 'agent-model-errors', version: 1, category: 'errors', module: 'agents', metric: 'agent_ai_error_rate',
    name: 'Agent model calls failing above 10%',
    description: 'More than 10% of the model calls an agent makes fail over 30 minutes (at least 20 calls).',
    condition: threshold('gt', 10, 10, 20), windowMinutes: 30, cooldownMinutes: 120,
  },
  {
    key: 'kb-ingestion-failures', version: 1, category: 'errors', module: 'rag', metric: 'rag_failed_documents',
    name: 'Knowledge base documents failing to ingest',
    description: "A document fails to ingest into one of the project's knowledge bases (checked over the last hour).",
    condition: threshold('gt', 0, 0, 1), windowMinutes: 60, cooldownMinutes: 360,
  },
  {
    key: 'agent-error-budget', version: 1, category: 'errors', module: 'agents', metric: 'agent_error_rate',
    name: 'Agent error budget burning fast',
    description: 'An agent spends its 30-day error budget (99% of runs succeed) more than 14 times faster than it can afford, over both the last hour and the last 5 minutes.',
    condition: errorBudgetBurn(), windowMinutes: 60, cooldownMinutes: 60,
  },
  {
    key: 'model-error-budget', version: 1, category: 'errors', module: 'models', metric: 'model_error_rate',
    name: 'Model error budget burning fast',
    description: 'A model spends its 30-day error budget (99% of requests succeed) more than 14 times faster than it can afford, over both the last hour and the last 5 minutes.',
    condition: errorBudgetBurn(), windowMinutes: 60, cooldownMinutes: 60,
  },

  // ── latency ───────────────────────────────────────────────────────────
  {
    key: 'agent-slow-runs', version: 1, category: 'latency', module: 'agents', metric: 'agent_p95_duration_ms',
    name: 'Agent p95 run time above 2 minutes',
    description: "The slowest 5% of an agent's runs take longer than 2 minutes over an hour (at least 20 runs).",
    condition: threshold('gt', 120_000, 15, 20), windowMinutes: 60, cooldownMinutes: 240,
  },
  {
    key: 'model-latency', version: 1, category: 'latency', module: 'models', metric: 'model_p95_latency_ms',
    name: 'Model p95 latency above 20 seconds',
    description: "The slowest 5% of a model's requests take longer than 20 seconds over 30 minutes (at least 20 requests).",
    condition: threshold('gt', 20_000, 10, 20), windowMinutes: 30, cooldownMinutes: 120,
  },
  {
    key: 'kb-latency', version: 1, category: 'latency', module: 'rag', metric: 'kb_p95_latency_ms',
    name: 'Knowledge base p95 latency above 5 seconds',
    description: "The slowest 5% of a knowledge base's queries take longer than 5 seconds over 30 minutes (at least 20 queries).",
    condition: threshold('gt', 5_000, 10, 20), windowMinutes: 30, cooldownMinutes: 120,
  },
  {
    key: 'mcp-latency', version: 1, category: 'latency', module: 'mcp', metric: 'mcp_server_p95_latency_ms',
    name: 'MCP server p95 latency above 10 seconds',
    description: "The slowest 5% of an MCP server's requests take longer than 10 seconds over 30 minutes (at least 20 requests).",
    condition: threshold('gt', 10_000, 10, 20), windowMinutes: 30, cooldownMinutes: 120,
  },
  {
    key: 'tool-latency', version: 1, category: 'latency', module: 'tools', metric: 'tool_p95_latency_ms',
    name: 'Tool p95 latency above 10 seconds',
    description: "The slowest 5% of a tool's calls take longer than 10 seconds over 30 minutes (at least 20 calls).",
    condition: threshold('gt', 10_000, 10, 20), windowMinutes: 30, cooldownMinutes: 120,
  },

  // ── traffic ───────────────────────────────────────────────────────────
  {
    key: 'agent-traffic-stopped', version: 1, category: 'traffic', module: 'agents', metric: 'agent_sessions',
    name: 'Agent traffic stopped',
    description: 'An agent that averaged at least 5 sessions an hour over the last day gets no session for an hour.',
    condition: absence(24, 5), windowMinutes: 60, cooldownMinutes: 240,
  },
  {
    key: 'model-traffic-stopped', version: 1, category: 'traffic', module: 'models', metric: 'model_requests',
    name: 'Model traffic stopped',
    description: 'A model that averaged at least 10 requests an hour over the last day gets no request for an hour.',
    condition: absence(24, 10), windowMinutes: 60, cooldownMinutes: 240,
  },

  // ── cost ──────────────────────────────────────────────────────────────
  {
    key: 'agent-daily-spend', version: 1, category: 'cost', module: 'agents', metric: 'agent_cost',
    name: 'Agent spend above $50 a day',
    description: 'An agent costs more than $50 over the last 24 hours.',
    condition: threshold('gt', 50, 0, 1), windowMinutes: 1440, cooldownMinutes: 1440,
  },
  {
    key: 'model-daily-spend', version: 1, category: 'cost', module: 'models', metric: 'model_cost',
    name: 'Model spend above $100 a day',
    description: 'A model costs more than $100 over the last 24 hours.',
    condition: threshold('gt', 100, 0, 1), windowMinutes: 1440, cooldownMinutes: 1440,
  },
  {
    key: 'agent-cost-spike', version: 1, category: 'cost', module: 'agents', metric: 'agent_cost',
    name: 'Agent cost spike',
    description: 'An agent costs more than twice its usual amount for this hour of the day (compared with the last 14 days, and at least $1 more).',
    condition: costSpike(), windowMinutes: 60, cooldownMinutes: 360,
  },
  {
    key: 'model-cost-spike', version: 1, category: 'cost', module: 'models', metric: 'model_cost',
    name: 'Model cost spike',
    description: 'A model costs more than twice its usual amount for this hour of the day (compared with the last 14 days, and at least $1 more).',
    condition: costSpike(), windowMinutes: 60, cooldownMinutes: 360,
  },

  // ── quality ───────────────────────────────────────────────────────────
  {
    key: 'agent-abandoned', version: 1, category: 'quality', module: 'agents', metric: 'agent_abandoned_rate',
    name: 'Agent sessions abandoned above 30%',
    description: "More than 30% of an agent's sessions are abandoned over an hour (at least 20 sessions).",
    condition: threshold('gt', 30, 15, 20), windowMinutes: 60, cooldownMinutes: 240,
  },
  {
    key: 'kb-empty-results', version: 1, category: 'quality', module: 'rag', metric: 'kb_empty_result_rate',
    name: 'Knowledge base empty results above 30%',
    description: "More than 30% of a knowledge base's queries return no results over an hour (at least 20 queries).",
    condition: threshold('gt', 30, 15, 20), windowMinutes: 60, cooldownMinutes: 240,
  },
  {
    key: 'evaluation-pass-rate', version: 1, category: 'quality', module: 'evaluation', metric: 'evaluation_pass_rate',
    name: 'Evaluation pass rate below 80%',
    description: 'Evaluation runs completed in the last 24 hours pass less than 80% of their cases on average.',
    condition: threshold('lt', 80, 0, 1), windowMinutes: 1440, cooldownMinutes: 1440,
  },

  // ── safety ────────────────────────────────────────────────────────────
  {
    key: 'guardrail-blocks', version: 1, category: 'safety', module: 'guardrails', metric: 'guardrail_block_rate',
    name: 'Guardrail block rate above 20%',
    description: 'Guardrails block more than 20% of the requests they check over an hour (at least 20 checks).',
    condition: threshold('gt', 20, 0, 20), windowMinutes: 60, cooldownMinutes: 240,
  },
  {
    key: 'redteam-attack-success', version: 1, category: 'safety', module: 'redteam', metric: 'redteam_attack_success_rate',
    name: 'Red team attack success above 10%',
    description: 'Red team runs completed in the last 24 hours show attacks succeeding more than 10% of the time.',
    condition: threshold('gt', 10, 0, 1), windowMinutes: 1440, cooldownMinutes: 1440,
  },
];

/** Keys of the templates new projects get. */
export const DEFAULT_ALERT_TEMPLATE_KEYS: readonly string[] = ALERT_TEMPLATES.filter((def) => def.default).map((def) => def.key);

export function getAlertTemplate(key: unknown): AlertTemplateDefinition | undefined {
  return ALERT_TEMPLATES.find((def) => def.key === key);
}

/** The rule a template creates; also what the rule form is prefilled with to customise it first. */
export function templateRuleInput(def: AlertTemplateDefinition): CreateAlertRuleInput {
  const metricDef = getMetricDef(def.metric);
  return {
    name: def.name,
    description: def.description,
    module: def.module,
    metric: def.metric,
    condition: structuredClone(def.condition),
    windowMinutes: def.windowMinutes,
    cooldownMinutes: def.cooldownMinutes,
    // Legacy metrics have no entity: they watch the whole project.
    ...(metricDef?.source === 'entity' && metricDef.entityType ? { entity: { entityType: metricDef.entityType, mode: 'all' as const } } : {}),
    severity: 'auto',
    notifyOnResolve: true,
    renotifyMinutes: 0,
    channels: [{ type: 'email', recipients: [], audience: 'project_admins' }],
    enabled: true,
  };
}

/** Whether new projects get the default alert rules (`ALERT_DEFAULT_RULES_ON_CREATE`, default on). */
export function defaultAlertRulesOnCreate(): boolean {
  return getConfig().health.defaultAlertRulesOnCreate;
}

// ── State and availability ──────────────────────────────────────────────────

/**
 * `added`: a rule of the project came from this template (and still watches its metric).
 * `covered`: another enabled rule already watches the same metric, in the same mode, on the whole target.
 * `available`: neither.
 */
export type AlertTemplateState = 'added' | 'covered' | 'available';

export type AlertTemplateAvailability = ModeAvailability;

export interface AlertTemplateItem {
  key: string;
  version: number;
  category: AlertTemplateCategory;
  module: AlertModule;
  metric: AlertMetric;
  mode: AlertConditionMode;
  default: boolean;
  name: string;
  description: string;
  state: AlertTemplateState;
  /** The rule added from this template (`added`) or the one that covers it (`covered`). */
  rule?: { id: string; name: string; enabled: boolean };
  /** Whether this build and licence can run the rule (separate from its state). */
  availability: AlertTemplateAvailability;
  /** What adding it creates (the rule form takes it as a prefill). */
  input: CreateAlertRuleInput;
}

export interface AlertTemplateList {
  version: number;
  items: AlertTemplateItem[];
  /** Admins the template rules notify in this project; 0 means the workspace owners and admins get them. */
  projectAdminRecipients: number;
  /** Whether new projects get the default rules in this installation. */
  defaultRulesOnNewProjects: boolean;
}

export interface ApplyAlertTemplatesResult {
  created: IAlertRule[];
  skipped: Array<{ key: string; reason: 'exists' | 'covered' | 'unavailable' }>;
}

/** Does the rule watch everything the template's metric can be watched on (every entity, or the whole project)? */
function watchesWholeTarget(rule: IAlertRule): boolean {
  if (getMetricDef(rule.metric)?.source === 'entity') return !rule.entity || rule.entity.mode === 'all';
  return Object.values(rule.scope ?? {}).every((value) => !value);
}

function stateOf(def: AlertTemplateDefinition, rules: IAlertRule[]): Pick<AlertTemplateItem, 'state' | 'rule'> {
  const ref = (rule: IAlertRule) => ({ id: String(rule._id), name: rule.name, enabled: rule.enabled });
  // A rule retargeted to another metric is no longer this template's rule.
  const added = rules.find((rule) => rule.template?.key === def.key && rule.metric === def.metric);
  if (added) return { state: 'added', rule: ref(added) };
  const covering = rules.find((rule) =>
    rule.enabled
    && rule.metric === def.metric
    && (rule.condition?.mode ?? 'threshold') === def.condition.mode
    && watchesWholeTarget(rule));
  if (covering) return { state: 'covered', rule: ref(covering) };
  return { state: 'available' };
}

async function availabilityOf(def: AlertTemplateDefinition, gate: ModeGate): Promise<AlertTemplateAvailability> {
  // The collector of a legacy metric can live in the enterprise build only.
  if (!getCollectorForMetric(def.metric)) return { available: false, reason: 'not_enterprise_build' };
  return gate.check(def.condition.mode);
}

async function toItem(def: AlertTemplateDefinition, rules: IAlertRule[], gate: ModeGate): Promise<AlertTemplateItem> {
  return {
    key: def.key,
    version: def.version,
    category: def.category,
    module: def.module,
    metric: def.metric,
    mode: def.condition.mode,
    default: def.default === true,
    name: def.name,
    description: def.description,
    ...stateOf(def, rules),
    availability: await availabilityOf(def, gate),
    input: templateRuleInput(def),
  };
}

function parseKeys(raw: unknown): AlertTemplateDefinition[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > ALERT_TEMPLATES.length) {
    throw new AlertApiError(400, 'invalid_value', `keys must list 1 to ${ALERT_TEMPLATES.length} template keys`);
  }
  const picked = new Set<string>();
  for (const entry of raw) {
    const def = getAlertTemplate(entry);
    if (!def) throw unknownTemplate(entry);
    picked.add(def.key);
  }
  return ALERT_TEMPLATES.filter((def) => picked.has(def.key));
}

function unknownTemplate(key: unknown): AlertApiError {
  const shown = typeof key === 'string' ? key.slice(0, 100) : typeof key;
  return new AlertApiError(400, 'invalid_value', `Unknown template key: ${shown}`);
}

// ── Locking ─────────────────────────────────────────────────────────────────

const LOCK_TTL_SECONDS = 60;
const LOCK_RETRY_MS = 100;
const LOCK_WAIT_MS = 5_000;

/** Runs on one project run one after another in this process, even when the cache lock is a no-op. */
const projectLocks = new Map<string, Promise<unknown>>();

async function withProcessLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  projectLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (projectLocks.get(key) === tail) projectLocks.delete(key);
  }
}

let warnedNoClusterLock = false;

function continueWithoutClusterLock(reason: string): null {
  if (!warnedNoClusterLock) {
    warnedNoClusterLock = true;
    log.warn('The cache gives no lock: rule templates are serialised within this process only', { reason });
  }
  return null;
}

/** A key nobody else holds: a cache that cannot grant it grants no lock at all. */
async function grantsLocks(cache: CacheProvider): Promise<boolean> {
  try {
    const probeKey = `alerts:templates:probe:${randomUUID()}`;
    const token = await cache.acquireLock(probeKey, 5);
    if (!token) return false;
    await cache.releaseLock(probeKey, token).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * The cross-process lock of one project. Returns its release, or null when the
 * cache cannot lock at all (down, or a provider that never grants): the
 * in-process lock alone applies then, so an apply never hangs or fails for it.
 * A lock another process holds is waited for, then answered with 409 `busy`.
 */
async function acquireClusterLock(key: string): Promise<(() => Promise<void>) | null> {
  let cache: CacheProvider;
  try {
    cache = await getCache();
  } catch {
    return continueWithoutClusterLock('cache unavailable');
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  let probed = false;
  for (;;) {
    let token: string | undefined;
    try {
      token = await cache.acquireLock(key, LOCK_TTL_SECONDS);
    } catch {
      return continueWithoutClusterLock('lock request failed');
    }
    if (token) {
      return async () => {
        try {
          await cache.releaseLock(key, token as string);
        } catch { /* it expires on its own */ }
      };
    }
    if (!probed) {
      probed = true;
      if (!(await grantsLocks(cache))) return continueWithoutClusterLock('lock never granted');
    }
    if (Date.now() >= deadline) {
      throw new AlertApiError(409, 'busy', 'Rule templates are being added to this project. Try again in a moment.');
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

/**
 * Runs `fn` as the only template change of this project, in this process and
 * across processes, so a double click or two nodes add each template once.
 */
export async function withAlertTemplateLock<T>(tenantDbName: string, projectId: string, fn: () => Promise<T>): Promise<T> {
  return withProcessLock(`${tenantDbName}\u0000${projectId}`, async () => {
    const release = await acquireClusterLock(`alerts:templates:${tenantDbName}:${projectId}`);
    try {
      return await fn();
    } finally {
      if (release) await release();
    }
  });
}

// ── Service ─────────────────────────────────────────────────────────────────

export class AlertTemplateService {
  static async list(tenantDbName: string, tenantId: string, projectId: string): Promise<AlertTemplateList> {
    const db = await getTenantDatabase(tenantDbName);
    const [rules, admins] = await Promise.all([
      db.listAlertRules(tenantId, { projectId }),
      resolveProjectAdminRecipients(tenantDbName, projectId),
    ]);
    const gate = createModeGate(tenantId);
    return {
      version: ALERT_TEMPLATE_CATALOG_VERSION,
      items: await Promise.all(ALERT_TEMPLATES.map((def) => toItem(def, rules, gate))),
      projectAdminRecipients: admins.length,
      defaultRulesOnNewProjects: defaultAlertRulesOnCreate(),
    };
  }

  /**
   * Add template rules to the project. Without `keys`, the default set minus
   * what is added, covered or unavailable; with `keys`, those templates (covered
   * ones included, since the person picked them). A template already added is
   * never added twice.
   */
  static async apply(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    options: { keys?: unknown } = {},
  ): Promise<ApplyAlertTemplatesResult> {
    const picked = parseKeys(options.keys);
    return withAlertTemplateLock(tenantDbName, projectId, async () => {
      const db = await getTenantDatabase(tenantDbName);
      const rules = await db.listAlertRules(tenantId, { projectId });
      const gate = createModeGate(tenantId);
      const result: ApplyAlertTemplatesResult = { created: [], skipped: [] };
      for (const def of picked ?? ALERT_TEMPLATES.filter((entry) => entry.default)) {
        const { state } = stateOf(def, rules);
        if (state === 'added') {
          result.skipped.push({ key: def.key, reason: 'exists' });
          continue;
        }
        if (!(await availabilityOf(def, gate)).available) {
          result.skipped.push({ key: def.key, reason: 'unavailable' });
          continue;
        }
        if (state === 'covered' && !picked) {
          result.skipped.push({ key: def.key, reason: 'covered' });
          continue;
        }
        const rule = await AlertService.createRule(tenantDbName, tenantId, projectId, userId, templateRuleInput(def), {
          template: { key: def.key, version: def.version },
        });
        result.created.push(rule);
      }
      return result;
    });
  }

  /**
   * Save a rule the person customised from a template, keeping its template
   * mark. The mark says which template the rule stands in for, so it must watch
   * the template's metric, and a project holds each template once.
   */
  static async createFromTemplate(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    input: CreateAlertRuleInput,
    templateKey: unknown,
  ): Promise<IAlertRule> {
    const def = getAlertTemplate(templateKey);
    if (!def) throw unknownTemplate(templateKey);
    if (input?.metric !== def.metric) {
      throw new AlertApiError(400, 'invalid_value', `templateKey "${def.key}" needs the metric ${def.metric}`);
    }
    return withAlertTemplateLock(tenantDbName, projectId, async () => {
      const db = await getTenantDatabase(tenantDbName);
      const rules = await db.listAlertRules(tenantId, { projectId });
      if (stateOf(def, rules).state === 'added') {
        throw new AlertApiError(409, 'template_exists', 'This template is already added to the project');
      }
      return AlertService.createRule(tenantDbName, tenantId, projectId, userId, input, {
        template: { key: def.key, version: def.version },
      });
    });
  }
}

/**
 * Add the default alert rules to a project that was just created. Best effort:
 * the project exists whatever happens here, so this never throws. Returns the
 * number of rules added, or null when adding them failed (logged). Callers
 * outside a request (provisioning, bootstrap) have no tenant scope of their
 * own, so the whole body runs in one.
 */
export async function seedDefaultAlertRules(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  userId: string,
): Promise<number | null> {
  try {
    return await runWithTenantScope(tenantDbName, async () => {
      const { created } = await AlertTemplateService.apply(tenantDbName, tenantId, projectId, userId);
      return created.length;
    });
  } catch (error) {
    log.error('Adding the default alert rules failed', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
