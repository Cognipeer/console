/**
 * Pure data layer of the Authorization Engine settings page: the response
 * shapes of `/api/iam/*` and the parsers that turn them into view models.
 * Kept free of React so a contract test can feed it the real handler payloads.
 *
 * The shapes below mirror src/server/api/plugins/iam.ts and
 * src/lib/iam/shadow/aggregate.ts (summarizeShadowEntries). If the API changes,
 * the contract test (iam-ui-contract.test.ts) fails instead of the page
 * silently rendering zeros.
 */

export type Mode = 'legacy' | 'shadow' | 'enforce';
export type Category = 'parity-mismatch' | 'token-groups' | 'project-narrowing' | 'unmapped-path';

export const CATEGORIES: Category[] = ['parity-mismatch', 'token-groups', 'project-narrowing', 'unmapped-path'];

export const CATEGORY_I18N: Record<Category, string> = {
  'parity-mismatch': 'parityMismatch',
  'token-groups': 'tokenGroups',
  'project-narrowing': 'projectNarrowing',
  'unmapped-path': 'unmappedPath',
};

export interface CategoryTotals {
  events: number;
  keys: number;
  /** Requests the current rules allow but the target rule would deny. */
  wouldDeny: number;
  /** Requests the current rules deny but the target rule would allow. */
  wouldAllow: number;
}

export interface RouteRow {
  category: string;
  service: string;
  method: string;
  route: string;
  legacyAllowed: boolean;
  targetAllowed: boolean;
  count: number;
  lastSeen?: string;
}

export interface SampleRow {
  category: string;
  service: string;
  method: string;
  route: string;
  requestId?: string;
  userId?: string;
  tokenId?: string;
  role?: string;
  at?: string;
  detail?: string;
}

export interface ServiceRow {
  service: string;
  total: number;
  byCategory: Partial<Record<string, number>>;
}

export interface Summary {
  mode: Mode;
  collecting: boolean;
  totalEvents: number;
  categories: Record<Category, CategoryTotals>;
  perService: ServiceRow[];
  topRoutes: RouteRow[];
  samples: SampleRow[];
  dropped: { keys: number; events: number };
  maxKeys: number;
}

export interface EngineStats {
  statsScope: 'process' | 'tenant';
  decisions: number;
  p50Us: number | null;
  p99Us: number | null;
  queueDrops: number;
  evaluationFailures: number;
  parityMismatches: number;
  droppedEvents: number;
  queueDepth: number | null;
  cacheHitRate: number | null;
}

const MAX_SAMPLES_SHOWN = 30;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function emptyCategories(): Record<Category, CategoryTotals> {
  const out = {} as Record<Category, CategoryTotals>;
  for (const c of CATEGORIES) out[c] = { events: 0, keys: 0, wouldDeny: 0, wouldAllow: 0 };
  return out;
}

function toMode(v: unknown): Mode {
  return v === 'shadow' || v === 'enforce' ? v : 'legacy';
}

export function parseMode(raw: unknown): Mode {
  return toMode(asRecord(raw).mode);
}

export interface ModeInfo {
  /** Stored mode. */
  mode: Mode;
  /** Mode actually applied; 'legacy' while the operator kill switch overrides enforce. */
  effectiveMode: Mode;
  enforceKillSwitch: boolean;
  /** Name the admin types to confirm enforce mode (company name, else slug, else tenant id). */
  tenantName: string | null;
  tenantSlug: string | null;
  tenantId: string | null;
  undeclaredCount: number;
}

export function parseModeInfo(raw: unknown): ModeInfo {
  const r = asRecord(raw);
  const mode = toMode(r.mode);
  const tenant = asRecord(r.tenant);
  return {
    mode,
    effectiveMode: r.effectiveMode === undefined ? mode : toMode(r.effectiveMode),
    enforceKillSwitch: asRecord(r.killSwitches).enforce === true,
    tenantName: str(tenant.name) ?? null,
    tenantSlug: str(tenant.slug) ?? null,
    tenantId: str(tenant.id) ?? null,
    undeclaredCount: num(asRecord(r.undeclaredRoutes).count),
  };
}

export function parseSummary(raw: unknown): Summary {
  const r = asRecord(raw);

  const categories = emptyCategories();
  for (const row of asArray(r.categories)) {
    const o = asRecord(row);
    const key = o.category as Category;
    if (!CATEGORIES.includes(key)) continue;
    categories[key] = {
      events: num(o.events),
      keys: num(o.keys),
      wouldDeny: num(o.wouldDeny),
      wouldAllow: num(o.wouldAllow),
    };
  }

  const perService = asArray(r.services).map((row): ServiceRow => {
    const o = asRecord(row);
    return {
      service: String(o.service ?? ''),
      total: num(o.total),
      byCategory: asRecord(o.byCategory) as Partial<Record<string, number>>,
    };
  });

  const topRoutes: RouteRow[] = [];
  const samples: SampleRow[] = [];
  for (const row of asArray(r.topRoutes)) {
    const o = asRecord(row);
    const base = {
      category: String(o.category ?? ''),
      service: String(o.service ?? ''),
      method: String(o.method ?? ''),
      route: String(o.route ?? ''),
    };
    topRoutes.push({
      ...base,
      legacyAllowed: o.legacyAllowed === true,
      targetAllowed: o.targetAllowed === true,
      count: num(o.count),
      lastSeen: str(o.lastSeen),
    });
    // Samples are nested per route (newest first); carry the route context along.
    for (const sample of asArray(o.samples)) {
      const s = asRecord(sample);
      samples.push({
        ...base,
        requestId: str(s.requestId),
        userId: str(s.userId),
        tokenId: str(s.tokenId),
        role: str(s.role),
        at: str(s.at),
        detail: str(s.detail),
      });
    }
  }
  samples.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));

  const totals = asRecord(r.totals);
  const dropped = asRecord(r.dropped);
  return {
    mode: parseMode(r),
    collecting: r.collecting === true,
    totalEvents: num(totals.events),
    categories,
    perService,
    topRoutes,
    samples: samples.slice(0, MAX_SAMPLES_SHOWN),
    dropped: { keys: num(dropped.keys), events: num(dropped.events) },
    maxKeys: num(r.maxKeys),
  };
}

export function parseStats(raw: unknown): EngineStats {
  const r = asRecord(raw);
  const engine = asRecord(r.engine);
  const shadow = asRecord(r.shadow);
  const queue = asRecord(shadow.queue);
  return {
    statsScope: r.statsScope === 'tenant' ? 'tenant' : 'process',
    decisions: num(engine.decisions),
    p50Us: numOrNull(engine.p50Us),
    p99Us: numOrNull(engine.p99Us),
    queueDrops: num(shadow.queueDrops),
    evaluationFailures: num(shadow.evaluationFailures),
    parityMismatches: num(shadow.parityMismatches),
    droppedEvents: num(shadow.droppedEvents),
    queueDepth: numOrNull(queue.queued),
    cacheHitRate: numOrNull(asRecord(engine.principalCache).hitRate),
  };
}

/** The error `code` and message of a failed API call (`{ error, code }` bodies). */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body?.error) message = body.error;
      code = body?.code;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status, code);
  }
  return res.json();
}
