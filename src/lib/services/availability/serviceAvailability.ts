/**
 * Whether a service is on for a tenant.
 *
 * Two switches, both optional and both only ever turn things OFF:
 *
 *   environment  CONSOLE_DISABLED_SERVICES turns the listed services off for the
 *                whole deployment; CONSOLE_ENABLED_SERVICES, when set, keeps
 *                only the listed ones on. A ceiling: a license cannot turn a
 *                service back on.
 *   license      the tenant license's `services` claim: `allow` keeps only the
 *                listed services on, `deny` turns the listed ones off. A license
 *                without the claim (every license issued before it existed)
 *                changes nothing, and neither does an expired one — the tenant
 *                falls back to the free tier, which has no claim.
 *
 * A service whose required service is off is off too (`SERVICE_REQUIRES`).
 * The always-on administration services are never off.
 *
 * Callers ask `assertServiceEnabled` at the point where the service does its
 * work (the API gate, a queue consumer, a scheduler, an agent tool binding), so
 * a switched-off service stops on every entry point, not only in the UI.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getRequestContext } from '@/lib/core/requestContext';
import { getDatabase } from '@/lib/database';
import type { LicenseServiceClaim } from '@/lib/license/license-manager';
import { resolveLiveLicenseForTenant } from '@/lib/license/tenantLicense';
import {
  isAlwaysOnService,
  isKnownService,
  listSwitchableServices,
  SERVICE_REQUIRES,
} from './catalog';

const logger = createLogger('service-availability');

export type ServiceSwitchSource = 'env' | 'license';

export interface ServiceOff {
  service: string;
  source: ServiceSwitchSource;
  /** Set when the service is off only because a service it requires is off. */
  via?: string;
}

export interface ServiceSwitchInput {
  env: { disabled: readonly string[]; enabled: readonly string[] };
  license?: LicenseServiceClaim | null;
}

const NOTHING_OFF: ReadonlyMap<string, ServiceOff> = new Map();

/**
 * The pure decision: which services are off, and why. Exported for tests and
 * for the license page, which shows the outcome of a claim.
 */
export function computeDisabledServices(input: ServiceSwitchInput): ReadonlyMap<string, ServiceOff> {
  const { env, license } = input;
  const envAllow = env.enabled.length > 0 ? new Set(env.enabled) : null;
  const envDeny = new Set(env.disabled);
  const licenseAllow = license?.allow ? new Set(license.allow) : null;
  const licenseDeny = new Set(license?.deny ?? []);
  if (!envAllow && envDeny.size === 0 && !licenseAllow && licenseDeny.size === 0) return NOTHING_OFF;

  const off = new Map<string, ServiceOff>();
  const services = listSwitchableServices();
  for (const service of services) {
    if ((envAllow && !envAllow.has(service)) || envDeny.has(service)) {
      off.set(service, { service, source: 'env' });
    } else if ((licenseAllow && !licenseAllow.has(service)) || licenseDeny.has(service)) {
      off.set(service, { service, source: 'license' });
    }
  }

  // Off with what it requires, to any depth (portals → agents → models).
  for (let changed = true; changed;) {
    changed = false;
    for (const service of services) {
      if (off.has(service)) continue;
      const missing = (SERVICE_REQUIRES[service] ?? []).find((required) => off.has(required));
      if (missing) {
        off.set(service, { service, source: off.get(missing)!.source, via: missing });
        changed = true;
      }
    }
  }
  return off;
}

const NO_ENV_SWITCHES: ServiceSwitchInput['env'] = { disabled: [], enabled: [] };

function envSwitches(): ServiceSwitchInput['env'] {
  // Absent only in a hand-built config (a test's partial mock): nothing is off.
  return getConfig().services ?? NO_ENV_SWITCHES;
}

/**
 * Config errors for the boot check (see validateConfig in bootstrap): an
 * unknown or always-on id in the environment is a typo or a misunderstanding,
 * and silently ignoring it would leave a service on that the operator believes
 * is off.
 */
export function validateServiceSwitchConfig(env: ServiceSwitchInput['env']): Array<{ key: string; message: string }> {
  const errors: Array<{ key: string; message: string }> = [];
  for (const [key, ids] of [['CONSOLE_DISABLED_SERVICES', env.disabled], ['CONSOLE_ENABLED_SERVICES', env.enabled]] as const) {
    const unknown = ids.filter((id) => !isKnownService(id));
    if (unknown.length > 0) {
      errors.push({ key, message: `Unknown service id(s): ${unknown.join(', ')}. Known: ${listSwitchableServices().join(', ')}` });
    }
  }
  const alwaysOn = env.disabled.filter((id) => isAlwaysOnService(id));
  if (alwaysOn.length > 0) {
    errors.push({ key: 'CONSOLE_DISABLED_SERVICES', message: `These services cannot be switched off: ${alwaysOn.join(', ')}` });
  }
  return errors;
}

/**
 * Service ids in a license claim this build does not know. They are ignored —
 * a license issued for a newer release must not break an older one — but the
 * activation reports them.
 */
export function unknownLicenseServiceIds(claim: LicenseServiceClaim | null | undefined): string[] {
  const ids = [...(claim?.allow ?? []), ...(claim?.deny ?? [])];
  return [...new Set(ids.filter((id) => !isKnownService(id)))];
}

// A short local memo on top of the shared 30 s license cache: the API gate and
// the model runtime ask on every call, and the shared cache is a network hop.
// The license endpoints clear it on this node; other nodes follow within MEMO_MS.
const MEMO_MS = 3_000;
const memo = new Map<string, { at: number; off: ReadonlyMap<string, ServiceOff> }>();

export function clearServiceAvailabilityMemo(tenantId?: string): void {
  if (tenantId) memo.delete(tenantId);
  else memo.clear();
}

/** The services that are off for this tenant (empty when nothing is switched off). */
export async function getDisabledServices(tenantId: string): Promise<ReadonlyMap<string, ServiceOff>> {
  const cached = memo.get(tenantId);
  if (cached && Date.now() - cached.at < MEMO_MS) return cached.off;
  let claim: LicenseServiceClaim | null = null;
  try {
    claim = (await resolveLiveLicenseForTenant(tenantId)).services ?? null;
  } catch (error) {
    // An unreadable license must not take every service down: the environment
    // still applies, and the next lookup (after the memo) tries the license again.
    logger.warn('Could not read the tenant license for service switches', {
      tenantId, error: error instanceof Error ? error.message : String(error),
    });
  }
  const off = computeDisabledServices({ env: envSwitches(), license: claim });
  memo.set(tenantId, { at: Date.now(), off });
  return off;
}

/** True when the environment alone switches nothing off and no tenant lookup is needed to know it. */
function envSwitchesNothing(): boolean {
  const env = envSwitches();
  return env.disabled.length === 0 && env.enabled.length === 0;
}

const DB_NAME_TTL_MS = 60_000;
let tenantIdsByDbName: { at: number; map: Map<string, string> } | null = null;

async function tenantIdForDbName(tenantDbName: string): Promise<string | null> {
  if (!tenantIdsByDbName || Date.now() - tenantIdsByDbName.at > DB_NAME_TTL_MS || !tenantIdsByDbName.map.has(tenantDbName)) {
    const tenants = await (await getDatabase()).listTenants().catch(() => []);
    const map = new Map<string, string>();
    for (const tenant of tenants) {
      if (tenant.dbName && tenant._id) map.set(tenant.dbName, String(tenant._id));
    }
    tenantIdsByDbName = { at: Date.now(), map };
  }
  return tenantIdsByDbName.map.get(tenantDbName) ?? null;
}

/** Who is asking: a tenant id, else its database name (queue jobs and services often carry only that). */
export interface ServiceScope {
  tenantId?: string | null;
  tenantDbName?: string | null;
}

/** The tenant id a scope stands for (the id itself, the request's, or looked up from its database name). */
export async function resolveTenantId(scope: ServiceScope): Promise<string | null> {
  if (scope.tenantId) return String(scope.tenantId);
  const fromContext = getRequestContext()?.tenantId;
  if (fromContext) return fromContext;
  return scope.tenantDbName ? tenantIdForDbName(scope.tenantDbName) : null;
}

/** Why `service` is off for this tenant, or null when it is on. */
export async function serviceOffReason(scope: ServiceScope, service: string): Promise<ServiceOff | null> {
  if (isAlwaysOnService(service)) return null;
  const tenantId = await resolveTenantId(scope);
  if (!tenantId) {
    // No tenant to read a license for: only the environment can decide.
    if (envSwitchesNothing()) return null;
    return computeDisabledServices({ env: envSwitches() }).get(service) ?? null;
  }
  return (await getDisabledServices(tenantId)).get(service) ?? null;
}

export async function isServiceEnabled(scope: ServiceScope, service: string): Promise<boolean> {
  return (await serviceOffReason(scope, service)) === null;
}

/**
 * A request for a switched-off service. 403 `service_disabled` when the
 * environment switched it off, 402 `service_not_licensed` when the tenant's
 * license does not include it. `statusCode` is set too, so a handler that only
 * rethrows still answers with the right status.
 */
export class ServiceDisabledError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly code: 'service_disabled' | 'service_not_licensed';
  readonly service: string;
  readonly source: ServiceSwitchSource;
  readonly via?: string;
  /** Read by the queue providers: running the job again cannot make the service available. */
  readonly retryable = false;

  constructor(off: ServiceOff) {
    const reason = off.source === 'env'
      ? 'is switched off on this deployment'
      : 'is not included in this workspace\'s license';
    const message = off.via
      ? `The "${off.service}" service is unavailable because the "${off.via}" service ${reason}.`
      : `The "${off.service}" service ${reason}.`;
    super(message);
    this.name = 'ServiceDisabledError';
    this.status = off.source === 'env' ? 403 : 402;
    this.statusCode = this.status;
    this.code = off.source === 'env' ? 'service_disabled' : 'service_not_licensed';
    this.service = off.service;
    this.source = off.source;
    this.via = off.via;
  }

  /** The JSON body every API surface sends (the client dialects embed `code` in their envelope). */
  toBody(): Record<string, unknown> {
    return {
      error: this.message,
      code: this.code,
      service: this.service,
      source: this.source,
      ...(this.via ? { via: this.via } : {}),
    };
  }
}

export async function assertServiceEnabled(scope: ServiceScope, service: string): Promise<void> {
  const off = await serviceOffReason(scope, service);
  if (off) throw new ServiceDisabledError(off);
}

export function isServiceDisabledError(error: unknown): error is ServiceDisabledError {
  return error instanceof ServiceDisabledError;
}

/**
 * Logged once per tenant and service per process when a guardrail or PII check
 * is skipped because its service is off: the operator chose to let traffic
 * through unchecked, and the log is the record of it. Returns true only for the
 * first report, which is also when `safetyCheckSkipped` writes its audit event.
 */
const reportedSkips = new Set<string>();
export function reportSkippedSafetyCheck(tenantKey: string, service: string, detail: Record<string, unknown> = {}): boolean {
  const key = `${tenantKey}:${service}`;
  if (reportedSkips.has(key)) return false;
  reportedSkips.add(key);
  logger.warn('Safety check skipped: its service is switched off', { tenant: tenantKey, service, ...detail });
  return true;
}

/** Test hook: forget which skips were already reported. */
export function resetReportedSafetyCheckSkipsForTests(): void {
  reportedSkips.clear();
}
