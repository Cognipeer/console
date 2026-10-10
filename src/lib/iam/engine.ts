/**
 * Authorization engine.
 *
 * `authorize()` evaluates one (principal, action, resource, context) request
 * against the tenant's policy set - the managed RBAC policies plus the tenant's
 * enabled custom policies - and ALWAYS returns a result: any failure (WASM
 * unavailable, store unreadable, entity build error, Cedar error) becomes
 * `allowed: false` with the reason in `errors` and `failed: true`. It never
 * throws. The request gates answer a `failed` result with 503 "authorization
 * unavailable" (enforce.ts): a failure is never turned into an allow, and never
 * into a guess made by some other rule set.
 *
 * Policy sets
 * -----------
 * One preparsed (WASM-side) set per tenant, under a stable id that is simply
 * overwritten when the tenant's policy version changes:
 *   tenant:<tenantDbName>:policies   managed + the tenant's enabled custom policies
 * A tenant without enabled custom policies shares the global `managed:rbac`
 * set, so an idle tenant costs no WASM memory.
 *
 * A custom statement that no longer loads (it parsed when it was saved, so this
 * means corrupt data or a Cedar upgrade) is skipped and reported in `skipped`
 * instead of taking the whole workspace's decisions down with it.
 *
 * Freshness: the tenant's `policy_version` counter (iam_meta) is compared at
 * most every VERSION_CHECK_MS (5 s) on the hot path, and a local policy write
 * triggers an immediate reload through events.ts. A load that such a write
 * overtook (it read its policy list before the write) is thrown away before it
 * touches the preparsed set - the set lives under one id per workspace, so an
 * older load that finished last would bring the older rules back for every
 * decision until the next write - and its callers load again.
 *
 * Boundaries: the managed set also carries the boundary forbids (managedPolicies.ts),
 * so no custom permit can exceed an API token's scope or the project narrowing.
 * Actions outside the catalog are denied before evaluation for the same reason:
 * a permissive custom policy must not be able to open what no boundary governs.
 *
 * Context: the request context (context.ts) is turned into Cedar values per
 * decision, never cached with the policy set; `now` is filled in when absent.
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
import { buildCedarContext, type IamRequestContext } from './context';
import { onIamInvalidation } from './events';
import { ALL_MANAGED_POLICIES } from './managedPolicies';
import { getPrincipalCacheStats } from './principalCache';
import { ensureSchemaPreparsed, getIamSchema, PREPARSED_SCHEMA_NAME } from './schemaState';
import { customCedarIds, getPolicyVersion, listPolicies, policyIdFromCedarId, type IIamPolicy } from './store';

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
  /** Optional request context (see context.ts / IAM_CONTEXT_ATTRS). */
  context?: IamRequestContext;
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
   * deny is not a verdict: the gates answer 503, not 403.
   */
  failed?: boolean;
  obligations: Record<string, unknown>;
  durationUs: number;
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
  /** Custom statements, over every loaded workspace, that could not be loaded and are not applied. */
  skippedStatements: number;
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
    skippedStatements: [...tenantStates.values()].reduce((sum, state) => sum + state.skipped.length, 0),
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
  set: LoadedSet;
  /** Custom statements in the loaded set. */
  custom: number;
  /** Cedar ids of custom statements that failed to load and were skipped. */
  skipped: string[];
  checkedAt: number;
}

const tenantStates = new Map<string, TenantState>();
let managedLoaded = false;
const managedSet: LoadedSet = { setId: MANAGED_SET_ID, obligations: new Map() };

function ensureManagedSet(): string | null {
  if (managedLoaded) return null;
  const res = preparsePolicySet(MANAGED_SET_ID, { ...ALL_MANAGED_POLICIES });
  if (!res.ok) return `managed policy set failed to load: ${res.errors.map((e) => e.message).join('; ')}`;
  managedLoaded = true;
  return null;
}

/**
 * Load (and cache in the WASM instance) the managed policy set. The boot
 * self-test calls this so a process that cannot load Cedar never starts serving.
 */
export function ensureManagedPolicySet(): { ok: true; setId: string } | { ok: false; error: string } {
  const error = ensureManagedSet();
  return error ? { ok: false, error } : { ok: true, setId: MANAGED_SET_ID };
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

/**
 * Cedar records of a list of stored policies (`custom:<id>[#n]` -> statement)
 * plus the obligations of each statement. A policy whose text no longer parses
 * is skipped (and reported through `onSkip`), never fatal.
 */
export function buildPolicyRecord(
  list: ReadonlyArray<Pick<IIamPolicy, 'policyId' | 'cedar'>>,
  onSkip?: (cedarId: string) => void,
): { record: Record<string, string>; obligations: Map<string, Record<string, unknown>> } {
  const record: Record<string, string> = {};
  const obligations = new Map<string, Record<string, unknown>>();
  for (const policy of list) {
    const parts = splitPolicyText(policy.cedar);
    if (!parts.ok) {
      onSkip?.(`custom:${policy.policyId}`);
      continue;
    }
    customCedarIds(policy.policyId, parts.policies.length).forEach((id, i) => {
      record[id] = parts.policies[i];
      const ob = obligationsOf(parts.policies[i]);
      if (ob) obligations.set(id, ob);
    });
  }
  return { record, obligations };
}

/** Fixed id the statements are probed under one by one (Cedar cannot free a set, so never a fresh id per probe). */
const PROBE_SET_ID = 'probe:statement';

/**
 * Preparse the tenant's set. If the whole set does not load, find the
 * statements that do not (each one alone) and load the rest: one bad statement
 * must not make every request of the workspace unanswerable.
 */
function loadCustomRecord(
  setId: string,
  built: { record: Record<string, string>; obligations: Map<string, Record<string, unknown>> },
  skipped: string[],
): LoadedSet {
  const whole = preparsePolicySet(setId, { ...ALL_MANAGED_POLICIES, ...built.record });
  if (whole.ok) return { setId, obligations: built.obligations };

  const good: Record<string, string> = {};
  for (const [id, statement] of Object.entries(built.record)) {
    if (preparsePolicySet(PROBE_SET_ID, { [id]: statement }).ok) good[id] = statement;
    else skipped.push(id);
  }
  const retry = preparsePolicySet(setId, { ...ALL_MANAGED_POLICIES, ...good });
  if (!retry.ok) {
    throw new Error(`tenant policy set failed to load: ${retry.errors.map((e) => e.message).join('; ')}`);
  }
  logger.error('Custom policy statements could not be loaded and are not applied', { setId, skipped: skipped.slice(0, 20) });
  const obligations = new Map([...built.obligations].filter(([id]) => id in good));
  return { setId, obligations };
}

/** A load that a policy write on this node overtook: nothing of it may be applied, stored or answered with. */
class StaleLoad extends Error {
  constructor() {
    super('policy set load was overtaken by a policy change');
    this.name = 'StaleLoad';
  }
}

/** Attempts a decision makes when the load it waits on keeps being overtaken (a burst of policy writes) before it is refused. */
const MAX_STALE_LOADS = 5;

async function buildTenantState(tenantDbName: string, isCurrent: () => boolean): Promise<TenantState> {
  const loadError = ensureManagedSet();
  if (loadError) throw new Error(loadError);

  const version = await getPolicyVersion(tenantDbName);
  const policies = version === 0 ? [] : (await listPolicies(tenantDbName, { enabled: true }));

  const skipped: string[] = [];
  const built = buildPolicyRecord(policies, (id) => skipped.push(id));

  let set: LoadedSet = managedSet;
  let custom = 0;
  if (Object.keys(built.record).length > 0) {
    // The preparsed set of a workspace lives under ONE id, so writing it is shared state. Nothing awaits between
    // this check and the preparse, so a load that passes it is the newest one to write.
    if (!isCurrent()) throw new StaleLoad();
    set = loadCustomRecord(`tenant:${tenantDbName}:policies`, built, skipped);
    custom = Object.keys(built.record).length - skipped.filter((id) => id in built.record).length;
  }

  metrics.setReloads++;
  return { version, set, custom, skipped, checkedAt: Date.now() };
}

const pendingLoads = new Map<string, Promise<TenantState>>();
/** Bumped by every invalidation; a load that started before one is overtaken and must not be applied or stored. */
const generations = new Map<string, number>();

/** One attempt at resolving (and refreshing when due) the tenant's policy sets. Rejects with StaleLoad when a policy write overtook the load. */
async function loadTenantState(tenantDbName: string): Promise<TenantState> {
  const existing = tenantStates.get(tenantDbName);
  if (existing && Date.now() - existing.checkedAt < config.versionCheckMs) return existing;
  const inflight = pendingLoads.get(tenantDbName);
  if (inflight) return inflight;

  const generation = generations.get(tenantDbName) ?? 0;
  const isCurrent = () => (generations.get(tenantDbName) ?? 0) === generation;
  const load: Promise<TenantState> = (async () => {
    try {
      if (existing) {
        const version = await getPolicyVersion(tenantDbName);
        if (version === existing.version) {
          existing.checkedAt = Date.now();
          return existing;
        }
      }
      const built = await buildTenantState(tenantDbName, isCurrent);
      if (!isCurrent()) throw new StaleLoad();
      tenantStates.set(tenantDbName, built);
      return built;
    } catch (error) {
      // Neither a failure nor a reason to keep serving `existing`: the caller loads again.
      if (error instanceof StaleLoad) throw error;
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
    }
  })();
  pendingLoads.set(tenantDbName, load);
  // Forget it once it is over - but only its own entry: an invalidation may have replaced it with the load of a
  // newer policy list. (Registered before anyone else can wait on `load`, so it runs before they continue.)
  const forget = () => {
    if (pendingLoads.get(tenantDbName) === load) pendingLoads.delete(tenantDbName);
  };
  load.then(forget, forget);
  return load;
}

/**
 * Resolve (and refresh when due) the tenant's policy sets. Throws only when no set was ever loaded, or when
 * the policies changed faster than they could be loaded (see MAX_STALE_LOADS).
 */
async function getTenantState(tenantDbName: string): Promise<TenantState> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await loadTenantState(tenantDbName);
    } catch (error) {
      if (!(error instanceof StaleLoad)) throw error;
      // The load this decision waited on was overtaken by a newer policy write: load again (which joins the newer
      // load when one is already running). Policy writes in a row can overtake it again, but not without end.
      if (attempt >= MAX_STALE_LOADS) {
        logger.warn('Policy set kept changing while it was loading', { tenantDbName, attempts: attempt });
        throw new Error('policy set kept changing while it was loading');
      }
    }
  }
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
  /** Custom statements in force (0 = the managed rules alone decide). */
  custom: number;
  /** Cedar ids of custom statements that could not be loaded and are not applied. */
  skipped: string[];
  setId: string;
}> {
  const state = await getTenantState(normalizeTenant(tenant));
  return {
    version: state.version,
    custom: state.custom,
    skipped: state.skipped,
    setId: state.set.setId,
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

/**
 * Everything a Cedar request needs except the policy set: principal, action,
 * resource, entities and the context. Shared by `authorize` and the preview /
 * simulation code, which evaluate the SAME request against other policy sets.
 * Throws for malformed input (callers turn that into a deny).
 */
export function buildAuthorizeCall(
  input: AuthorizeInput,
  tenantDbName: string,
): { call: Omit<CedarAuthorizeInput, 'policySetId'>; action: ActionDefinition | undefined } {
  const action = lookupAction(input.action);
  const principal = principalEntities(input.principal);
  const resource = resourceEntities(input.resource, tenantDbName);
  const entities = [
    ...principal.entities,
    ...resource.entities,
    ...actionEntities(input.action, action?.level ?? null),
  ];
  return {
    action,
    call: {
      principal: principal.uid,
      action: { type: 'Action', id: input.action },
      resource: resource.uid,
      context: buildCedarContext(input.context),
      entities,
      schemaName: PREPARSED_SCHEMA_NAME,
      validateRequest: config.validateRequests,
    },
  };
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

    const { call: baseCall, action } = buildAuthorizeCall(input, tenantDbName);
    if (!action) {
      // Not a catalog action. The managed policies are written against the level
      // groups, so nothing governs it - and a permissive custom policy must not
      // be able to open it past the boundaries. A deny, not a failure: the
      // engine did decide.
      const durationUs = Math.round((performance.now() - started) * 1000);
      recordDecision(false, false, durationUs);
      return {
        allowed: false,
        reasons: [],
        errors: [`unknown action "${String(input.action)}"`],
        obligations: {},
        durationUs,
      };
    }

    const call: CedarAuthorizeInput = { ...baseCall, policySetId: state.set.setId };

    const decision: CedarDecision = statefulIsAuthorized(call);
    if (!decision.ok) return failure(decision.errors, started);

    const result: AuthorizeResult = {
      allowed: decision.allowed,
      reasons: decision.reasons,
      errors: decision.errors,
      obligations: decision.allowed ? mergeObligations(state.set, decision.reasons) : {},
      durationUs: 0,
    };

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
  context?: IamRequestContext;
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
