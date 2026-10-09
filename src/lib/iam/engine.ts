/**
 * Authorization engine.
 *
 * `authorize()` evaluates one (principal, action, resource, context) request
 * against the tenant's policy set — the managed RBAC policies plus the tenant's
 * enabled custom policies — and ALWAYS returns a result: any failure (WASM
 * unavailable, store unreadable, entity build error, Cedar error) becomes
 * `allowed: false` with the reason in `errors`. It never throws.
 *
 * Policy sets
 * -----------
 * One preparsed (WASM-side) set per tenant, under a stable id that is simply
 * overwritten when the tenant's policy version changes:
 *   tenant:<tenantDbName>:enforce   managed + enabled `enforce` custom policies
 *   tenant:<tenantDbName>:monitor   the above + enabled `monitor` policies
 *                                   (only built when a monitor policy exists)
 * A tenant without enabled custom policies shares the global `managed:rbac`
 * set, so an idle tenant costs no WASM memory.
 *
 * Freshness: the tenant's `policy_version` counter (iam_meta) is compared at
 * most every VERSION_CHECK_MS (5 s) on the hot path, and a local policy write
 * triggers an immediate reload through events.ts.
 *
 * Obligations: policy annotations other than the reserved ones (`managed`,
 * `id`, `description`) of the permits that DETERMINED an allow are returned as
 * `obligations` (e.g. `@guardrail("pii-strict")`, `@limits("{\"rpm\":10}")`).
 * Values that are valid JSON objects/arrays/numbers/booleans are parsed; others
 * stay strings. The map policy -> annotations is built once when the set loads.
 * On a key clash the lexicographically first policy id wins.
 */

import { createLogger } from '@/lib/core/logger';
import {
  getCedarVersion,
  isCedarLoaded,
  policyAnnotations,
  preparsePolicySet,
  splitPolicyText,
  statefulIsAuthorized,
  type CedarAuthorizeInput,
  type CedarDecision,
} from './cedar';
import {
  gateActionId as gateActionIdFor,
  serviceActionId,
  indexCatalog,
  type ActionDefinition,
} from './actions';
import {
  actionEntities,
  principalEntities,
  resourceEntities,
  type IamPrincipal,
  type IamResource,
} from './entities';
import { onIamInvalidation } from './events';
import { MANAGED_POLICIES } from './managedPolicies';
import { getPrincipalCacheStats } from './principalCache';
import { ensureSchemaPreparsed, getIamSchema, PREPARSED_SCHEMA_NAME } from './schemaState';
import { customCedarIds, getPolicyVersion, listPolicies, policyIdFromCedarId } from './store';

const logger = createLogger('iam:engine');

export const VERSION_CHECK_MS = 5_000;
const MANAGED_SET_ID = 'managed:rbac';
const RESERVED_ANNOTATIONS = new Set(['managed', 'id', 'description']);
const LATENCY_WINDOW = 2_048;

export interface IamEngineConfig {
  /** Validate every request against the schema (+100-140 µs). Off in the hot path; on in tests. */
  validateRequests: boolean;
  /** How often the tenant policy version is re-read. */
  versionCheckMs: number;
}

const config: IamEngineConfig = {
  validateRequests: process.env.IAM_VALIDATE_REQUESTS === '1',
  versionCheckMs: VERSION_CHECK_MS,
};

export function configureIamEngine(patch: Partial<IamEngineConfig>): IamEngineConfig {
  Object.assign(config, patch);
  return { ...config };
}

// ── public types ─────────────────────────────────────────────────────────

export type IamTenantRef = string | { tenantDbName: string };

export interface AuthorizeInput {
  tenant: IamTenantRef;
  principal: IamPrincipal;
  /** Action id from the catalog (e.g. `agents.write`, `agent.get`). */
  action: string;
  resource: IamResource;
  /** Optional request context (see IAM_CONTEXT_ATTRS). */
  context?: Record<string, string>;
}

export interface AuthorizeResult {
  allowed: boolean;
  /** Ids of the policies that determined the decision (Cedar ids, e.g. `managed:rbac:user-read`, `custom:my-policy`). */
  reasons: string[];
  /** Evaluation problems (a policy that errored, a failed load...). Non-empty on a deny does NOT mean the deny is only an error. */
  errors: string[];
  /**
   * True when NO decision could be made (engine/WASM unavailable, policy store
   * unreadable, request could not be built). `allowed` is false then, but the
   * deny is not a verdict: enforce mode falls back to the legacy decision.
   */
  failed?: boolean;
  obligations: Record<string, unknown>;
  durationUs: number;
  /**
   * Present when the tenant has enabled `monitor`-mode policies: what the
   * decision WOULD be with them applied. Never affects `allowed`.
   */
  monitor?: { allowed: boolean; reasons: string[]; differs: boolean };
}

// ── metrics ──────────────────────────────────────────────────────────────

const metrics = {
  decisions: 0,
  allows: 0,
  denies: 0,
  errored: 0,
  setReloads: 0,
  setLoadFailures: 0,
  latencies: new Float64Array(LATENCY_WINDOW),
  latencyCount: 0,
  startedAt: Date.now(),
};

function recordDecision(allowed: boolean, hadFailure: boolean, durationUs: number): void {
  metrics.decisions++;
  if (allowed) metrics.allows++;
  else metrics.denies++;
  if (hadFailure) metrics.errored++;
  metrics.latencies[metrics.latencyCount % LATENCY_WINDOW] = durationUs;
  metrics.latencyCount++;
}

export interface IamEngineStats {
  decisions: number;
  allows: number;
  denies: number;
  /** Decisions where the evaluation itself failed (deny + errors). */
  failures: number;
  /** Latency over the last `window` decisions, microseconds. */
  p50Us: number;
  p99Us: number;
  window: number;
  setReloads: number;
  setLoadFailures: number;
  principalCache: ReturnType<typeof getPrincipalCacheStats>;
  tenantsLoaded: number;
  cedar: { loaded: boolean; sdk?: string; language?: string };
  uptimeMs: number;
  validateRequests: boolean;
}

export function getIamEngineStats(): IamEngineStats {
  const n = Math.min(metrics.latencyCount, LATENCY_WINDOW);
  const sorted = Array.from(metrics.latencies.subarray(0, n)).sort((a, b) => a - b);
  const pick = (q: number) => (n === 0 ? 0 : sorted[Math.min(n - 1, Math.floor(n * q))]);
  let cedarInfo: IamEngineStats['cedar'] = { loaded: isCedarLoaded() };
  if (isCedarLoaded()) {
    try {
      const v = getCedarVersion();
      cedarInfo = { loaded: true, sdk: v.sdk, language: v.language };
    } catch {
      // keep loaded only
    }
  }
  return {
    decisions: metrics.decisions,
    allows: metrics.allows,
    denies: metrics.denies,
    failures: metrics.errored,
    p50Us: Math.round(pick(0.5)),
    p99Us: Math.round(pick(0.99)),
    window: n,
    setReloads: metrics.setReloads,
    setLoadFailures: metrics.setLoadFailures,
    principalCache: getPrincipalCacheStats(),
    tenantsLoaded: tenantStates.size,
    cedar: cedarInfo,
    uptimeMs: Date.now() - metrics.startedAt,
    validateRequests: config.validateRequests,
  };
}

export function resetIamEngineStatsForTests(): void {
  metrics.decisions = metrics.allows = metrics.denies = metrics.errored = 0;
  metrics.setReloads = metrics.setLoadFailures = 0;
  metrics.latencyCount = 0;
  metrics.latencies.fill(0);
  metrics.startedAt = Date.now();
}

// ── policy sets ──────────────────────────────────────────────────────────

interface LoadedSet {
  setId: string;
  /** policy cedar id -> annotations to surface as obligations. */
  obligations: Map<string, Record<string, unknown>>;
}

interface TenantState {
  version: number;
  enforce: LoadedSet;
  monitor: LoadedSet | null;
  customEnforce: number;
  customMonitor: number;
  /** Cedar ids of custom statements that failed to load and were skipped. */
  skipped: string[];
  checkedAt: number;
}

const tenantStates = new Map<string, TenantState>();
let managedLoaded = false;
const managedSet: LoadedSet = { setId: MANAGED_SET_ID, obligations: new Map() };

function ensureManagedSet(): string | null {
  if (managedLoaded) return null;
  const res = preparsePolicySet(MANAGED_SET_ID, { ...MANAGED_POLICIES });
  if (!res.ok) return `managed policy set failed to load: ${res.errors.map((e) => e.message).join('; ')}`;
  managedLoaded = true;
  return null;
}

function parseAnnotationValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return raw;
  if (/^[{\["]/.test(trimmed) || /^(true|false|null|-?\d+(\.\d+)?)$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

function obligationsOf(statement: string): Record<string, unknown> | null {
  const annotations = policyAnnotations(statement);
  if (!annotations) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(annotations)) {
    if (RESERVED_ANNOTATIONS.has(key)) continue;
    out[key] = parseAnnotationValue(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeTenant(tenant: IamTenantRef): string {
  return typeof tenant === 'string' ? tenant : tenant.tenantDbName;
}

async function buildTenantState(tenantDbName: string): Promise<TenantState> {
  const loadError = ensureManagedSet();
  if (loadError) throw new Error(loadError);

  const version = await getPolicyVersion(tenantDbName);
  const policies = version === 0 ? [] : (await listPolicies(tenantDbName, { enabled: true }));
  const enforce = policies.filter((p) => p.mode === 'enforce');
  const monitor = policies.filter((p) => p.mode === 'monitor');

  const skipped: string[] = [];
  const toRecord = (list: typeof policies) => {
    const record: Record<string, string> = {};
    const obligations = new Map<string, Record<string, unknown>>();
    for (const policy of list) {
      const parts = splitPolicyText(policy.cedar);
      if (!parts.ok) {
        skipped.push(`custom:${policy.policyId}`);
        continue;
      }
      customCedarIds(policy.policyId, parts.policies.length).forEach((id, i) => {
        record[id] = parts.policies[i];
        const ob = obligationsOf(parts.policies[i]);
        if (ob) obligations.set(id, ob);
      });
    }
    return { record, obligations };
  };

  const enforceBuilt = toRecord(enforce);
  const monitorBuilt = toRecord(monitor);

  let enforceSet: LoadedSet = managedSet;
  if (Object.keys(enforceBuilt.record).length > 0) {
    const setId = `tenant:${tenantDbName}:enforce`;
    const res = preparsePolicySet(setId, { ...MANAGED_POLICIES, ...enforceBuilt.record });
    if (!res.ok) throw new Error(`tenant policy set failed to load: ${res.errors.map((e) => e.message).join('; ')}`);
    enforceSet = { setId, obligations: enforceBuilt.obligations };
  }

  let monitorSet: LoadedSet | null = null;
  if (Object.keys(monitorBuilt.record).length > 0) {
    const setId = `tenant:${tenantDbName}:monitor`;
    const res = preparsePolicySet(setId, {
      ...MANAGED_POLICIES,
      ...enforceBuilt.record,
      ...monitorBuilt.record,
    });
    if (!res.ok) throw new Error(`tenant monitor policy set failed to load: ${res.errors.map((e) => e.message).join('; ')}`);
    monitorSet = {
      setId,
      obligations: new Map([...enforceBuilt.obligations, ...monitorBuilt.obligations]),
    };
  }

  metrics.setReloads++;
  return {
    version,
    enforce: enforceSet,
    monitor: monitorSet,
    customEnforce: Object.keys(enforceBuilt.record).length,
    customMonitor: Object.keys(monitorBuilt.record).length,
    skipped,
    checkedAt: Date.now(),
  };
}

const pendingLoads = new Map<string, Promise<TenantState>>();
/** Bumped by every invalidation; a refresh that started before one must not store its result. */
const generations = new Map<string, number>();

/** Resolve (and refresh when due) the tenant's policy sets. Throws only when no set was ever loaded. */
async function getTenantState(tenantDbName: string): Promise<TenantState> {
  const existing = tenantStates.get(tenantDbName);
  if (existing && Date.now() - existing.checkedAt < config.versionCheckMs) return existing;
  const inflight = pendingLoads.get(tenantDbName);
  if (inflight) return inflight;

  const generation = generations.get(tenantDbName) ?? 0;
  const load = (async (): Promise<TenantState> => {
    try {
      if (existing) {
        const version = await getPolicyVersion(tenantDbName);
        if (version === existing.version) {
          existing.checkedAt = Date.now();
          return existing;
        }
      }
      const built = await buildTenantState(tenantDbName);
      if ((generations.get(tenantDbName) ?? 0) === generation) tenantStates.set(tenantDbName, built);
      return built;
    } catch (error) {
      metrics.setLoadFailures++;
      if (existing) {
        // Fail static: keep serving the last good set and retry after the interval.
        existing.checkedAt = Date.now();
        logger.warn('Policy refresh failed; keeping the previous policy set', {
          tenantDbName,
          error: error instanceof Error ? error.message : String(error),
        });
        return existing;
      }
      throw error;
    } finally {
      pendingLoads.delete(tenantDbName);
    }
  })();
  pendingLoads.set(tenantDbName, load);
  return load;
}

/** Drop a tenant's cached state so the next decision reloads it (policy write on this node). */
export function invalidateTenantPolicySet(tenantDbName: string): void {
  generations.set(tenantDbName, (generations.get(tenantDbName) ?? 0) + 1);
  tenantStates.delete(tenantDbName);
  pendingLoads.delete(tenantDbName);
}

onIamInvalidation((event) => {
  if (event.kind === 'tenant-policies') invalidateTenantPolicySet(event.tenantDbName);
});

/** Test seam. */
export function resetIamEngineForTests(): void {
  tenantStates.clear();
  pendingLoads.clear();
  generations.clear();
  managedLoaded = false;
  resetIamEngineStatsForTests();
}

/** Introspection for UIs/tests: what is loaded for a tenant (loads it if needed). */
export async function describeTenantPolicySet(tenant: IamTenantRef): Promise<{
  version: number;
  customEnforce: number;
  customMonitor: number;
  skipped: string[];
  setId: string;
}> {
  const state = await getTenantState(normalizeTenant(tenant));
  return {
    version: state.version,
    customEnforce: state.customEnforce,
    customMonitor: state.customMonitor,
    skipped: state.skipped,
    setId: state.enforce.setId,
  };
}

// ── evaluation ───────────────────────────────────────────────────────────

let catalogIndex: { hash: string; byId: Map<string, ActionDefinition> } | null = null;

function lookupAction(actionId: string): ActionDefinition | undefined {
  const schema = getIamSchema();
  if (!catalogIndex || catalogIndex.hash !== schema.hash) {
    catalogIndex = { hash: schema.hash, byId: indexCatalog(schema.catalog) };
  }
  return catalogIndex.byId.get(actionId);
}

function mergeObligations(set: LoadedSet, reasons: string[]): Record<string, unknown> {
  if (set.obligations.size === 0) return {};
  const out: Record<string, unknown> = {};
  for (const reason of [...reasons].sort()) {
    const ob = set.obligations.get(reason);
    if (!ob) continue;
    for (const [key, value] of Object.entries(ob)) {
      if (!(key in out)) out[key] = value;
    }
  }
  return out;
}

function failure(errors: string[], started: number): AuthorizeResult {
  const durationUs = Math.round((performance.now() - started) * 1000);
  recordDecision(false, true, durationUs);
  return { allowed: false, reasons: [], errors, obligations: {}, durationUs, failed: true };
}

export async function authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
  const started = performance.now();
  try {
    const tenantDbName = normalizeTenant(input.tenant);
    const state = await getTenantState(tenantDbName);

    if (config.validateRequests) {
      const schemaResult = ensureSchemaPreparsed();
      if (!schemaResult.ok) return failure(schemaResult.errors, started);
    }

    const action = lookupAction(input.action);
    const principal = principalEntities(input.principal);
    const resource = resourceEntities(input.resource, tenantDbName);
    const entities = [
      ...principal.entities,
      ...resource.entities,
      ...actionEntities(input.action, action?.level ?? null),
    ];

    const call: CedarAuthorizeInput = {
      principal: principal.uid,
      action: { type: 'Action', id: input.action },
      resource: resource.uid,
      context: input.context ?? {},
      entities,
      policySetId: state.enforce.setId,
      schemaName: PREPARSED_SCHEMA_NAME,
      validateRequest: config.validateRequests,
    };

    const decision: CedarDecision = statefulIsAuthorized(call);
    if (!decision.ok) return failure(decision.errors, started);

    const result: AuthorizeResult = {
      allowed: decision.allowed,
      reasons: decision.reasons,
      errors: decision.errors,
      obligations: decision.allowed ? mergeObligations(state.enforce, decision.reasons) : {},
      durationUs: 0,
    };

    if (state.monitor) {
      const mon = statefulIsAuthorized({ ...call, policySetId: state.monitor.setId });
      if (mon.ok) {
        result.monitor = {
          allowed: mon.allowed,
          reasons: mon.reasons,
          differs: mon.allowed !== decision.allowed,
        };
      } else {
        result.errors.push(...mon.errors.map((e) => `monitor: ${e}`));
      }
    }

    result.durationUs = Math.round((performance.now() - started) * 1000);
    recordDecision(result.allowed, false, result.durationUs);
    return result;
  } catch (error) {
    return failure([error instanceof Error ? error.message : String(error)], started);
  }
}

export interface AuthorizeGateInput {
  tenant: IamTenantRef;
  principal: IamPrincipal;
  /** A PermissionService id (what getPermissionServiceForPath returned). */
  service: string;
  /** HTTP method of the request. */
  method: string;
  /**
   * Required level of the route when it is not the method-derived one (route
   * declaration `{ kind: 'service', level }`). Action `<service>.<level>`.
   */
  level?: 'read' | 'write' | 'admin';
  context?: Record<string, string>;
}

/**
 * The HTTP gate decision: may `principal` call `method` on `service`?
 * GET/HEAD/OPTIONS -> `<service>.read`, everything else -> `<service>.write`
 * (the adminService escalation lives in the managed Write policies).
 */
export async function authorizeGate(input: AuthorizeGateInput): Promise<AuthorizeResult> {
  const started = performance.now();
  let action: string;
  try {
    // Throws for a malformed method/service; that must become a deny, not a throw.
    action = input.level ? serviceActionId(input.service, input.level) : gateActionIdFor(input.service, input.method);
  } catch (error) {
    return failure([error instanceof Error ? error.message : String(error)], started);
  }
  return authorize({
    tenant: input.tenant,
    principal: input.principal,
    action,
    resource: { kind: 'service', service: input.service },
    context: input.context,
  });
}

/** Map Cedar reasons back to store policy ids (managed ids are dropped). */
export function customPolicyIdsOf(reasons: string[]): string[] {
  return [...new Set(reasons.map(policyIdFromCedarId).filter((id): id is string => !!id))];
}
