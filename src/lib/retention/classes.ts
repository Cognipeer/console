/**
 * Retention data classes.
 *
 * A duration belongs to a class of data, not to a collection: the prompt inside
 * a `model_usage_logs` row is `content` (cleared early), the row itself is
 * `telemetry` (deleted later). Every registered collection maps its fields to
 * these classes (targets.ts), and a tenant policy sets one number per class.
 *
 * `delivery` is listed for completeness: its collections keep their own,
 * older retention mechanisms (see the `legacy` targets), so it is not editable.
 *
 * Every class has a built-in default and every registered collection belongs
 * to a class (or names the mechanism and default that age it out): nothing
 * the console logs is kept forever unless a policy says so explicitly.
 */

export const RETENTION_CLASS_IDS = [
  'content',
  'telemetry',
  'trace',
  'jobs',
  'delivery',
  'metrics',
  'alerts',
  'audit',
  'usage',
  'results',
] as const;

export type RetentionClassId = typeof RETENTION_CLASS_IDS[number];

export interface RetentionClassDef {
  id: RetentionClassId;
  /** Built-in default (before RETENTION_<CLASS>_DAYS and the tenant policy). */
  defaultDays: number;
  /** The shortest duration a tenant may choose. `audit` also has the deployment floor (RETENTION_AUDIT_MIN_DAYS). */
  minDays: number;
  /** The longest duration a tenant may choose. */
  maxDays: number;
  /** What happens to an expired row of this class. */
  action: 'redact' | 'delete';
}

export const RETENTION_CLASSES: Record<RetentionClassId, RetentionClassDef> = {
  content: { id: 'content', defaultDays: 30, minDays: 1, maxDays: 90, action: 'redact' },
  telemetry: { id: 'telemetry', defaultDays: 90, minDays: 30, maxDays: 400, action: 'delete' },
  trace: { id: 'trace', defaultDays: 30, minDays: 7, maxDays: 180, action: 'delete' },
  jobs: { id: 'jobs', defaultDays: 90, minDays: 30, maxDays: 365, action: 'delete' },
  delivery: { id: 'delivery', defaultDays: 30, minDays: 7, maxDays: 90, action: 'delete' },
  metrics: { id: 'metrics', defaultDays: 45, minDays: 7, maxDays: 180, action: 'delete' },
  alerts: { id: 'alerts', defaultDays: 180, minDays: 90, maxDays: 730, action: 'delete' },
  audit: { id: 'audit', defaultDays: 365, minDays: 365, maxDays: 3650, action: 'delete' },
  usage: { id: 'usage', defaultDays: 760, minDays: 400, maxDays: 1095, action: 'delete' },
  results: { id: 'results', defaultDays: 365, minDays: 90, maxDays: 3650, action: 'delete' },
};

export function isRetentionClassId(value: unknown): value is RetentionClassId {
  return typeof value === 'string' && (RETENTION_CLASS_IDS as readonly string[]).includes(value);
}

export const RETENTION_PRESET_IDS = ['standard', 'minimal', 'eu-ai-act-high-risk', 'finance'] as const;
export type RetentionPresetId = typeof RETENTION_PRESET_IDS[number];

export function isRetentionPresetId(value: unknown): value is RetentionPresetId {
  return typeof value === 'string' && (RETENTION_PRESET_IDS as readonly string[]).includes(value);
}

type ClassDays = Partial<Record<RetentionClassId, number>>;

/**
 * Starting points a tenant can pick. They are engineering defaults, not legal
 * advice: `eu-ai-act-high-risk` keeps automatically generated logs for at least
 * six months (AI Act art. 19 / 26(6)); `finance` is to be confirmed per contract.
 * `delivery` is absent everywhere because it is not policy-driven.
 */
export const RETENTION_PRESETS: Record<RetentionPresetId, ClassDays> = {
  standard: {
    content: 30, telemetry: 90, trace: 30, jobs: 90, metrics: 45, alerts: 180, audit: 365, usage: 760, results: 365,
  },
  minimal: {
    content: 7, telemetry: 30, trace: 14, jobs: 30, metrics: 45, alerts: 90, audit: 365, usage: 400, results: 180,
  },
  // Evaluation and red-team results are part of a high-risk system's technical documentation (art. 18: ten years).
  'eu-ai-act-high-risk': {
    content: 30, telemetry: 180, trace: 180, jobs: 180, metrics: 45, alerts: 365, audit: 365, usage: 760, results: 3650,
  },
  finance: {
    content: 30, telemetry: 365, trace: 90, jobs: 180, metrics: 45, alerts: 365, audit: 1095, usage: 1095, results: 1095,
  },
};
