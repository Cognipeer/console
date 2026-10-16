/**
 * Starter alert rules: the recommended set every new project gets (enabled),
 * which any project can also browse and add from the Alerts page.
 *
 * One threshold rule per entity module, on the error rate, over every entity of
 * that module, so new agents, models and servers are covered as they appear.
 * A window needs at least 20 samples (one failed call out of one would read as
 * 100%) and the breach must hold for 10 minutes before the rule fires.
 * Notifications go to the project's admins, or to the workspace owners and
 * admins when the project has none.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric, AlertModule, EntityMetricType, IAlertRule } from '@/lib/database';
import { AlertApiError } from './alertApiError';
import { AlertService, type CreateAlertRuleInput } from './alertService';
import { resolveProjectAdminRecipients } from './channels/emailChannel';

const log = createLogger('alerts:starters');

/** The current definitions. A rule keeps the version it was added at. */
export const STARTER_SET_VERSION = 1;

export const STARTER_ALERT_KEYS = ['agent-errors', 'model-errors', 'kb-errors', 'mcp-errors', 'tool-errors'] as const;
export type StarterAlertKey = (typeof STARTER_ALERT_KEYS)[number];

export interface StarterAlertDefinition {
  key: StarterAlertKey;
  version: number;
  module: AlertModule;
  metric: AlertMetric;
  entityType: EntityMetricType;
  /** Error-rate percentage the rule fires above. */
  threshold: number;
  name: string;
  description: string;
}

/** Shared by every starter rule. */
export const STARTER_DEFAULTS = {
  windowMinutes: 30,
  forMinutes: 10,
  minSamples: 20,
  cooldownMinutes: 120,
} as const;

export const STARTER_ALERTS: readonly StarterAlertDefinition[] = [
  {
    key: 'agent-errors', version: 1, module: 'agents', metric: 'agent_error_rate', entityType: 'agent', threshold: 20,
    name: 'Agent error rate above 20%',
    description: 'An agent fails more than 20% of its runs over 30 minutes (at least 20 runs).',
  },
  {
    key: 'model-errors', version: 1, module: 'models', metric: 'model_error_rate', entityType: 'model', threshold: 20,
    name: 'Model error rate above 20%',
    description: 'A model fails more than 20% of its requests over 30 minutes (at least 20 requests).',
  },
  {
    key: 'kb-errors', version: 1, module: 'rag', metric: 'kb_error_rate', entityType: 'kb', threshold: 20,
    name: 'Knowledge base error rate above 20%',
    description: 'A knowledge base fails more than 20% of its queries over 30 minutes (at least 20 queries).',
  },
  {
    key: 'mcp-errors', version: 1, module: 'mcp', metric: 'mcp_server_error_rate', entityType: 'mcp', threshold: 30,
    name: 'MCP server error rate above 30%',
    description: 'An MCP server fails more than 30% of its requests over 30 minutes (at least 20 requests).',
  },
  {
    key: 'tool-errors', version: 1, module: 'tools', metric: 'tool_error_rate', entityType: 'tool', threshold: 30,
    name: 'Tool error rate above 30%',
    description: 'A tool fails more than 30% of its calls over 30 minutes (at least 20 calls).',
  },
];

export function getStarterDefinition(key: unknown): StarterAlertDefinition | undefined {
  return STARTER_ALERTS.find((def) => def.key === key);
}

/** The rule a starter creates; also what the rule form is prefilled with to customise it first. */
export function starterRuleInput(def: StarterAlertDefinition): CreateAlertRuleInput {
  return {
    name: def.name,
    description: def.description,
    module: def.module,
    metric: def.metric,
    condition: {
      mode: 'threshold',
      operator: 'gt',
      threshold: def.threshold,
      forMinutes: STARTER_DEFAULTS.forMinutes,
      minSamples: STARTER_DEFAULTS.minSamples,
    },
    windowMinutes: STARTER_DEFAULTS.windowMinutes,
    cooldownMinutes: STARTER_DEFAULTS.cooldownMinutes,
    entity: { entityType: def.entityType, mode: 'all' },
    severity: 'auto',
    notifyOnResolve: true,
    renotifyMinutes: 0,
    channels: [{ type: 'email', recipients: [], audience: 'project_admins' }],
    enabled: true,
  };
}

/** Whether new projects get the starter rules (`ALERT_STARTER_RULES_ON_CREATE`, default on). */
export function starterAlertsOnCreate(): boolean {
  return getConfig().health.starterAlertsOnCreate;
}

/**
 * `added`: a rule of the project came from this starter.
 * `covered`: another enabled rule already watches the same metric on every entity.
 * `available`: neither.
 */
export type StarterAlertState = 'added' | 'covered' | 'available';

export interface StarterAlertItem {
  key: StarterAlertKey;
  version: number;
  module: AlertModule;
  metric: AlertMetric;
  name: string;
  description: string;
  threshold: number;
  windowMinutes: number;
  forMinutes: number;
  minSamples: number;
  cooldownMinutes: number;
  state: StarterAlertState;
  /** The rule added from this starter (`added`) or the one that covers it (`covered`). */
  rule?: { id: string; name: string; enabled: boolean };
  /** What adding it creates (the rule form takes it as a prefill). */
  input: CreateAlertRuleInput;
}

export interface StarterAlertList {
  version: number;
  items: StarterAlertItem[];
  /** Admins the starter rules notify in this project; 0 means the workspace owners and admins get them. */
  projectAdminRecipients: number;
  /** Whether new projects get the starter rules in this installation. */
  addedToNewProjects: boolean;
}

export interface ApplyStarterAlertsResult {
  created: IAlertRule[];
  skipped: Array<{ key: StarterAlertKey; reason: 'exists' | 'covered' }>;
}

function watchesEveryEntity(rule: IAlertRule): boolean {
  return !rule.entity || rule.entity.mode === 'all';
}

function stateOf(def: StarterAlertDefinition, rules: IAlertRule[]): Pick<StarterAlertItem, 'state' | 'rule'> {
  const ref = (rule: IAlertRule) => ({ id: String(rule._id), name: rule.name, enabled: rule.enabled });
  const added = rules.find((rule) => rule.starter?.key === def.key);
  if (added) return { state: 'added', rule: ref(added) };
  const covering = rules.find((rule) => rule.enabled && rule.metric === def.metric && watchesEveryEntity(rule));
  if (covering) return { state: 'covered', rule: ref(covering) };
  return { state: 'available' };
}

function toItem(def: StarterAlertDefinition, rules: IAlertRule[]): StarterAlertItem {
  return {
    key: def.key,
    version: def.version,
    module: def.module,
    metric: def.metric,
    name: def.name,
    description: def.description,
    threshold: def.threshold,
    ...STARTER_DEFAULTS,
    ...stateOf(def, rules),
    input: starterRuleInput(def),
  };
}

function parseKeys(raw: unknown): StarterAlertKey[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > STARTER_ALERTS.length) {
    throw new AlertApiError(400, 'invalid_value', `keys must list 1 to ${STARTER_ALERTS.length} starter keys`);
  }
  const keys: StarterAlertKey[] = [];
  for (const entry of raw) {
    const def = getStarterDefinition(entry);
    if (!def) throw new AlertApiError(400, 'invalid_value', `Unknown starter key. Use one of: ${STARTER_ALERT_KEYS.join(', ')}`);
    if (!keys.includes(def.key)) keys.push(def.key);
  }
  return keys;
}

/** Applies on one project run one after another in this process, so a double click adds each starter once. */
const projectLocks = new Map<string, Promise<unknown>>();

async function withProjectLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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

export class StarterAlertService {
  static async list(tenantDbName: string, tenantId: string, projectId: string): Promise<StarterAlertList> {
    const db = await getTenantDatabase(tenantDbName);
    const [rules, admins] = await Promise.all([
      db.listAlertRules(tenantId, { projectId }),
      resolveProjectAdminRecipients(tenantDbName, projectId),
    ]);
    return {
      version: STARTER_SET_VERSION,
      items: STARTER_ALERTS.map((def) => toItem(def, rules)),
      projectAdminRecipients: admins.length,
      addedToNewProjects: starterAlertsOnCreate(),
    };
  }

  /**
   * Add starter rules to the project. Without `keys`, every starter that is
   * neither added nor covered; with `keys`, those (covered ones included).
   * A starter already added is never added twice.
   */
  static async apply(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    options: { keys?: unknown } = {},
  ): Promise<ApplyStarterAlertsResult> {
    const keys = parseKeys(options.keys);
    return withProjectLock(`${tenantDbName}\u0000${projectId}`, async () => {
      const db = await getTenantDatabase(tenantDbName);
      const rules = await db.listAlertRules(tenantId, { projectId });
      const result: ApplyStarterAlertsResult = { created: [], skipped: [] };
      const wanted = keys ? STARTER_ALERTS.filter((def) => keys.includes(def.key)) : STARTER_ALERTS;
      for (const def of wanted) {
        const { state } = stateOf(def, rules);
        if (state === 'added') {
          result.skipped.push({ key: def.key, reason: 'exists' });
          continue;
        }
        if (state === 'covered' && !keys) {
          result.skipped.push({ key: def.key, reason: 'covered' });
          continue;
        }
        const rule = await AlertService.createRule(tenantDbName, tenantId, projectId, userId, starterRuleInput(def), {
          starter: { key: def.key, version: def.version },
        });
        result.created.push(rule);
      }
      return result;
    });
  }
}

/**
 * Add the starter rules to a project that was just created. Best effort: the
 * project exists whatever happens here, so this never throws. Returns the
 * number of rules added, or null when adding them failed (logged).
 */
export async function seedStarterAlerts(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  userId: string,
): Promise<number | null> {
  try {
    const { created } = await StarterAlertService.apply(tenantDbName, tenantId, projectId, userId);
    return created.length;
  } catch (error) {
    log.error('Adding the starter alert rules failed', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
