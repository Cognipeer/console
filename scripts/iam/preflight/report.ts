/**
 * The shape of the report (the JSON file) and the totals across workspaces.
 */

import type { AccessChange } from './access';
import type { AccessReport, TenantAggregate, TenantIntegrity } from './accumulate';
import type { Census } from './census';
import type { Cause } from './model';

export const REPORT_VERSION = 1;

export interface SkippedPrincipal {
  label: string;
  kind: 'user' | 'token';
  /** Why authentication refuses it before any authorization question is asked. */
  reason: string;
}

export interface TenantReport extends TenantAggregate {
  slug: string;
  dbName: string;
  activation: {
    /** ISO instant from which an explicit "No access" saved earlier is ignored. */
    since: string;
    /** `stored`: the workspace already had one (an engine build ran against it); `option`: --since; `run-time`: the time of this run. */
    origin: 'stored' | 'option' | 'run-time';
  };
  customPolicies: { inForce: number; skipped: number };
  principals: {
    users: number;
    tokens: number;
    totalUsers: number;
    totalTokens: number;
    /** --max-principals cut the list: the figures cover the evaluated part only. */
    truncated: boolean;
    skipped: SkippedPrincipal[];
  };
  projectAccess: AccessReport;
  census: Census;
}

export interface CauseTotals {
  decisions: number;
  tighten: number;
  loosen: number;
  principals: number;
}

export interface ReportTotals {
  tenants: number;
  users: number;
  tokens: number;
  contexts: number;
  decisions: number;
  same: number;
  masked: number;
  differs: number;
  tighten: number;
  loosen: number;
  principalsChanged: { users: number; tokens: number };
  byCause: Partial<Record<Cause, CauseTotals>>;
  integrity: TenantIntegrity;
  deferred: { principals: number; entries: number };
  newlyGated: Array<{ id: string; title: string; edition: 'community' | 'enterprise'; principals: number }>;
  projectAccess: Partial<Record<AccessChange, number>>;
  scopedTokens: number;
}

export interface PreflightReport {
  reportVersion: typeof REPORT_VERSION;
  generatedAt: string;
  source: { provider: 'sqlite' | 'mongodb'; location: string };
  redacted: boolean;
  options: {
    tenants: string[];
    maxPrincipals: number | null;
    verifyAll: boolean;
    noMemo: boolean;
    summaryOnly: boolean;
  };
  services: { compared: number; addedWithEngine: string[] };
  totals: ReportTotals;
  tenants: TenantReport[];
}

export function buildTotals(tenants: readonly TenantReport[]): ReportTotals {
  const totals: ReportTotals = {
    tenants: tenants.length,
    users: 0,
    tokens: 0,
    contexts: 0,
    decisions: 0,
    same: 0,
    masked: 0,
    differs: 0,
    tighten: 0,
    loosen: 0,
    principalsChanged: { users: 0, tokens: 0 },
    byCause: {},
    integrity: { engineFailures: 0, oracleMismatches: 0, parityMismatches: 0, unexplained: 0 },
    deferred: { principals: 0, entries: 0 },
    newlyGated: [],
    projectAccess: {},
    scopedTokens: 0,
  };
  const surfaces = new Map<string, ReportTotals['newlyGated'][number]>();

  for (const t of tenants) {
    totals.users += t.principals.users;
    totals.tokens += t.principals.tokens;
    totals.contexts += t.contexts;
    totals.decisions += t.decisions;
    totals.same += t.same;
    totals.masked += t.masked;
    totals.differs += t.differs;
    totals.tighten += t.tighten;
    totals.loosen += t.loosen;
    totals.principalsChanged.users += t.principalsChanged.users;
    totals.principalsChanged.tokens += t.principalsChanged.tokens;
    for (const [cause, v] of Object.entries(t.byCause) as Array<[Cause, NonNullable<TenantAggregate['byCause'][Cause]>]>) {
      const sum = totals.byCause[cause] ?? { decisions: 0, tighten: 0, loosen: 0, principals: 0 };
      sum.decisions += v.decisions;
      sum.tighten += v.tighten;
      sum.loosen += v.loosen;
      sum.principals += v.principals;
      totals.byCause[cause] = sum;
    }
    totals.integrity.engineFailures += t.integrity.engineFailures;
    totals.integrity.oracleMismatches += t.integrity.oracleMismatches;
    totals.integrity.parityMismatches += t.integrity.parityMismatches;
    totals.integrity.unexplained += t.integrity.unexplained;
    totals.deferred.principals += t.deferred.principals;
    totals.deferred.entries += t.deferred.entries;
    for (const s of t.newlyGated) {
      const sum = surfaces.get(s.id) ?? { id: s.id, title: s.title, edition: s.edition, principals: 0 };
      sum.principals += s.count;
      surfaces.set(s.id, sum);
    }
    for (const [change, n] of Object.entries(t.projectAccess.summary) as Array<[AccessChange, number]>) {
      totals.projectAccess[change] = (totals.projectAccess[change] ?? 0) + n;
    }
    totals.scopedTokens += t.metricsExport.count;
  }
  totals.newlyGated = [...surfaces.values()];
  return totals;
}

export function integrityProblem(integrity: TenantIntegrity): boolean {
  return integrity.engineFailures + integrity.oracleMismatches + integrity.parityMismatches + integrity.unexplained > 0;
}
