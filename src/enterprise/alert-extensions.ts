/**
 * Alert extension seam — COMMUNITY (open-source) edition.
 *
 * The alerting core (rule evaluation, incidents, channels) lives here; a few
 * capabilities are provided by the enterprise overlay and plugged in through
 * this leaf module:
 *
 *   - baseline-relative alerting ("2x above its 14-day normal") and the
 *     expected-range band the health charts draw (`EntityBaselineProvider`);
 *   - SLO burn-rate alerting (`SloBurnEvaluator`);
 *   - incident enrichment such as correlated dependency regressions
 *     (`IncidentEnricher`);
 *   - entity links to the enterprise health pages (`EntityLinkResolver`);
 *   - extra metric collectors (e.g. the AI App Gateway collector), searched by
 *     the collector registry at call time.
 *
 * Nothing is registered in the community edition: those rule modes report
 * `license_required` / `not_enterprise_build`, incidents carry only the core
 * context, and only the built-in collectors resolve.
 *
 * Leaf module on purpose: only types are imported, so the overlay registry can
 * import it at load time without creating a cycle, and it is a separate
 * community file (NOT replaced by the overlay), so the `registry.ts` seam shape
 * and SEAM_CONTRACT_VERSION do not change because of it.
 * Never read a registered value at module scope: resolve it at call time.
 * Registration runs while the server is still importing, before the .env files
 * are loaded: do not log or read config here (the first log builds and caches
 * the config without the .env values).
 */
import type {
  AlertMetric,
  EntityMetricType,
  IAlertBaselineConfig,
  IAlertRule,
  IAlertSloConfig,
  IIncidentContext,
} from '@/lib/database';

// ── Baseline provider ───────────────────────────────────────────────────

export interface EntityBaselineRequest {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  entityType: EntityMetricType;
  metric: AlertMetric;
  windowMinutes: number;
  nowMs: number;
  config: IAlertBaselineConfig;
  /** Current-window value per entity (null = undefined, e.g. an empty denominator). */
  current: Array<{ entityKey: string; value: number | null; sampleCount: number }>;
}

export interface EntityBaselineResult {
  breached: boolean;
  baseline: number | null;
  lower: number | null;
  upper: number | null;
  /** Robust z-score of the current value against the baseline. */
  z: number | null;
  /** current / baseline */
  ratio: number | null;
  /** Number of historical points the baseline is built from. */
  points: number;
  insufficientHistory: boolean;
}

export interface EntityBandRequest {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  entityType: EntityMetricType;
  entityKey: string;
  metric: AlertMetric;
  fromMs: number;
  toMs: number;
  bucketMs: number;
  lookbackDays: number;
}

export interface EntityBandPoint {
  t: number;
  median: number | null;
  lower: number | null;
  upper: number | null;
}

export interface EntityBaselineProvider {
  /** One call per rule with all its targets; keyed by entityKey. */
  evaluate(req: EntityBaselineRequest): Promise<Map<string, EntityBaselineResult>>;
  /** Expected-range band for a chart. */
  band(req: EntityBandRequest): Promise<EntityBandPoint[]>;
}

// ── SLO burn evaluator ──────────────────────────────────────────────────

export interface SloBurnRequest {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  entityType: EntityMetricType;
  metric: AlertMetric;
  nowMs: number;
  config: IAlertSloConfig;
  entityKeys: string[];
}

export interface SloBurnResult {
  breached: boolean;
  burnLong: number | null;
  burnShort: number | null;
  attainmentPct: number | null;
  budgetRemainingPct: number | null;
  sampleCount: number;
}

export type SloBurnEvaluator = (req: SloBurnRequest) => Promise<Map<string, SloBurnResult>>;

// ── Incident enricher ───────────────────────────────────────────────────

export interface IncidentEnrichmentRequest {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  rule: IAlertRule;
  entityType: EntityMetricType | null;
  entityKey: string;
  windowMinutes: number;
  nowMs: number;
}

export type IncidentEnricher = (req: IncidentEnrichmentRequest) => Promise<Partial<IIncidentContext>>;

// ── Extra metric collectors ─────────────────────────────────────────────

/**
 * Structural mirror of `IMetricCollector` (declared here to stay a leaf):
 * `supportedMetrics` are alert metric ids, `collect` takes the `MetricQuery`.
 */
export interface IMetricCollectorLike {
  readonly supportedMetrics: readonly string[];
  collect(query: unknown): Promise<{ value: number; sampleCount: number }>;
}

// ── Entity links ────────────────────────────────────────────────────────

/**
 * Path (no origin) of the page an entity should link to, or null to use the core page. Synchronous
 * and pure: the overlay answers from the entity type and key alone.
 */
export type EntityLinkResolver = (entityType: EntityMetricType, entityKey: string) => string | null;

let baselineProvider: EntityBaselineProvider | null = null;
let sloBurnEvaluator: SloBurnEvaluator | null = null;
let incidentEnricher: IncidentEnricher | null = null;
const metricCollectors: IMetricCollectorLike[] = [];
let entityLinkResolver: EntityLinkResolver | null = null;

/** The overlay registers its provider once at load; `null` clears it (tests). A later registration replaces the earlier one. */
export function registerEntityBaselineProvider(provider: EntityBaselineProvider | null): void {
  baselineProvider = provider;
}

export function getEntityBaselineProvider(): EntityBaselineProvider | null {
  return baselineProvider;
}

export function registerSloBurnEvaluator(fn: SloBurnEvaluator | null): void {
  sloBurnEvaluator = fn;
}

export function getSloBurnEvaluator(): SloBurnEvaluator | null {
  return sloBurnEvaluator;
}

export function registerIncidentEnricher(fn: IncidentEnricher | null): void {
  incidentEnricher = fn;
}

export function getIncidentEnricher(): IncidentEnricher | null {
  return incidentEnricher;
}

/** The overlay registers its health-page links once at load; `null` clears them (tests). */
export function registerEntityLinkResolver(fn: EntityLinkResolver | null): void {
  entityLinkResolver = fn;
}

export function getEntityLinkResolver(): EntityLinkResolver | null {
  return entityLinkResolver;
}

/** Add a collector the registry should search besides the built-in ones. Registering the same instance twice is a no-op. */
export function registerAlertMetricCollector(collector: IMetricCollectorLike): void {
  if (metricCollectors.includes(collector)) return;
  metricCollectors.push(collector);
}

export function getRegisteredAlertMetricCollectors(): IMetricCollectorLike[] {
  return [...metricCollectors];
}

/** Test helper: forget everything that was registered. */
export function __resetAlertExtensionsForTests(): void {
  baselineProvider = null;
  sloBurnEvaluator = null;
  incidentEnricher = null;
  entityLinkResolver = null;
  metricCollectors.length = 0;
}
