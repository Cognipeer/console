/**
 * Folds the per-decision observations of one workspace into the figures and
 * lists of the report. Pure: the runner feeds it, nothing here touches the
 * database or the engine.
 */

import type { AccessChange, AccessOutcome, AccessScenario } from './access';
import {
  CHECK_IDS,
  directionOf,
  directionOfLevels,
  levelOfChecks,
  mergeCauses,
  type Cause,
  type CheckId,
  type Checks,
  type Direction,
  type Level,
} from './model';
import { NEWLY_GATED_SURFACES, surfaceAllowed, type GatedSurface } from './surfaces';

export type PrincipalKind = 'user' | 'token';

export interface PrincipalInfo {
  /** Unique within the workspace (the user id or the token id). */
  key: string;
  /** What the report prints (already redacted when asked). */
  label: string;
  kind: PrincipalKind;
  role: string;
  /** Tokens: who owns it. */
  owner?: string;
  programmatic?: boolean;
}

export interface ServiceObservation {
  service: string;
  adminService: boolean;
  /** The previous release's answers. */
  before: Checks;
  /** The engine's answers. */
  after: Checks;
  /** Cause per check (always set for a check that differs; set for the others when everything is verified). */
  causes: Partial<Record<CheckId, Cause>>;
  /** The answers once every explicit "No access" of rows saved before the upgrade counts. Only set when the context has such rows. */
  deferred?: Checks;
}

export interface ContextObservation {
  principal: PrincipalInfo;
  projectLabel: string;
  services: readonly ServiceObservation[];
}

// ── report shapes ────────────────────────────────────────────────────────

export interface ServiceChange {
  service: string;
  before: Level;
  after: Level;
  direction: Direction;
  cause: Cause;
  projects: string[];
}

export interface PrincipalChange {
  principal: string;
  kind: PrincipalKind;
  role: string;
  owner?: string;
  causes: Cause[];
  changes: ServiceChange[];
}

export interface CauseSummary {
  decisions: number;
  tighten: number;
  loosen: number;
  principals: number;
  /** Distinct (principal, service) pairs. */
  principalServicePairs: number;
  services: string[];
}

export interface DeferredChange {
  principal: string;
  kind: PrincipalKind;
  role: string;
  owner?: string;
  changes: Array<{ service: string; from: Level; to: Level; projects: string[] }>;
}

export interface SurfaceSummary {
  id: string;
  title: string;
  edition: GatedSurface['edition'];
  service: string;
  level: 'read' | 'write';
  routes: readonly string[];
  /** How many people stop reaching it. */
  count: number;
  /** Who they are (left out of the JSON with --summary-only). */
  principals: Array<{ principal: string; role: string; projects: string[] }>;
}

export interface AccessReport {
  members: number;
  scenarios: number;
  summary: Partial<Record<AccessChange, number>>;
  changes: Array<{
    user: string;
    role: string;
    scenarios: Array<{ cookie: string; before: string; after: string; change: AccessChange }>;
  }>;
}

export interface ProjectRollup {
  principals: number;
  services: number;
  tighten: number;
  loosen: number;
}

export interface ServiceRollup {
  principals: number;
  projects: number;
  tighten: number;
  loosen: number;
}

export interface TenantIntegrity {
  engineFailures: number;
  oracleMismatches: number;
  parityMismatches: number;
  unexplained: number;
}

/** A decision where the engine and the independent arithmetic disagree (kept for the bug report). */
export interface IntegrityExample {
  principal: string;
  project: string;
  service: string;
  check: CheckId;
  engine: boolean;
  independent: boolean;
}

const MAX_INTEGRITY_EXAMPLES = 10;

export interface TenantAggregate {
  contexts: number;
  decisions: number;
  same: number;
  masked: number;
  differs: number;
  tighten: number;
  loosen: number;
  /** Distinct (principal, project, service) whose level changes. */
  serviceChanges: number;
  principalsChanged: { users: number; tokens: number };
  byCause: Partial<Record<Cause, CauseSummary>>;
  principalChanges: PrincipalChange[];
  byProject: Record<string, ProjectRollup>;
  byService: Record<string, ServiceRollup>;
  deferred: { principals: number; entries: number; list: DeferredChange[] };
  newlyGated: SurfaceSummary[];
  metricsExport: { count: number; tokens: Array<{ token: string; owner: string }> };
  integrity: TenantIntegrity;
  integrityExamples: IntegrityExample[];
}

// ── accumulator ──────────────────────────────────────────────────────────

interface ChangeAgg {
  service: string;
  before: Level;
  after: Level;
  direction: Direction;
  cause: Cause;
  projects: Set<string>;
}

interface PrincipalAgg {
  info: PrincipalInfo;
  causes: Set<Cause>;
  changes: Map<string, ChangeAgg>;
  deferred: Map<string, { service: string; from: Level; to: Level; projects: Set<string> }>;
}

interface Bucket {
  decisions: number;
  tighten: number;
  loosen: number;
  principals: Set<string>;
  pairs: Set<string>;
  services: Set<string>;
}

const newBucket = (): Bucket => ({ decisions: 0, tighten: 0, loosen: 0, principals: new Set(), pairs: new Set(), services: new Set() });

export interface AccumulatorOptions {
  /** The workspace has custom policies in force: an unexplained difference is attributed to them. */
  customPolicies: boolean;
  surfaces?: readonly GatedSurface[];
}

export class TenantAccumulator {
  private readonly customPolicies: boolean;
  private readonly surfaces: readonly GatedSurface[];
  private contexts = 0;
  private decisions = 0;
  private same = 0;
  private masked = 0;
  private tighten = 0;
  private loosen = 0;
  private readonly buckets = new Map<Cause, Bucket>();
  private readonly principals = new Map<string, PrincipalAgg>();
  private readonly surfaceHits = new Map<string, Map<string, { principal: string; role: string; projects: Set<string> }>>();
  private readonly integrity: TenantIntegrity = { engineFailures: 0, oracleMismatches: 0, parityMismatches: 0, unexplained: 0 };
  private readonly accessSummary: Partial<Record<AccessChange, number>> = {};
  private accessScenarios = 0;
  private accessMembers = 0;
  private readonly accessChanges: AccessReport['changes'] = [];
  private readonly scopedTokens: Array<{ token: string; owner: string }> = [];
  private readonly integrityExamples: IntegrityExample[] = [];

  constructor(options: AccumulatorOptions) {
    this.customPolicies = options.customPolicies;
    this.surfaces = options.surfaces ?? NEWLY_GATED_SURFACES;
  }

  private bucket(cause: Cause): Bucket {
    let b = this.buckets.get(cause);
    if (!b) {
      b = newBucket();
      this.buckets.set(cause, b);
    }
    return b;
  }

  private principal(info: PrincipalInfo): PrincipalAgg {
    let p = this.principals.get(info.key);
    if (!p) {
      p = { info, causes: new Set(), changes: new Map(), deferred: new Map() };
      this.principals.set(info.key, p);
    }
    return p;
  }

  recordEngineFailures(n: number): void {
    this.integrity.engineFailures += n;
  }

  recordOracleMismatch(example: IntegrityExample): void {
    this.integrity.oracleMismatches++;
    if (this.integrityExamples.length < MAX_INTEGRITY_EXAMPLES) this.integrityExamples.push(example);
  }

  recordScopedToken(token: string, owner: string): void {
    this.scopedTokens.push({ token, owner });
  }

  addContext(obs: ContextObservation): void {
    this.contexts++;
    const agg = this.principal(obs.principal);
    const answers = new Map<string, Checks>();

    for (const s of obs.services) {
      answers.set(s.service, s.after);
      const checkCauses: Cause[] = [];
      let allowedBefore = 0;
      let allowedAfter = 0;
      let anyDiffers = false;

      for (const id of CHECK_IDS) {
        const before = s.before[id];
        const after = s.after[id];
        if (before) allowedBefore++;
        if (after) allowedAfter++;
        const differs = before !== after;
        const cause: Cause = s.causes[id] ?? (differs ? (this.customPolicies ? 'custom-policies' : 'unexplained') : 'same');
        checkCauses.push(cause);
        this.decisions++;
        if (cause === 'same') {
          this.same++;
          continue;
        }
        if (cause === 'masked') {
          this.masked++;
          continue;
        }
        anyDiffers = anyDiffers || differs;
        const direction = directionOf(before, after);
        const b = this.bucket(cause);
        b.decisions++;
        if (direction === 'tighten') {
          b.tighten++;
          this.tighten++;
        } else if (direction === 'loosen') {
          b.loosen++;
          this.loosen++;
        }
        b.principals.add(obs.principal.key);
        b.pairs.add(`${obs.principal.key}|${s.service}`);
        b.services.add(s.service);
        agg.causes.add(cause);
        if (cause === 'parity-mismatch') this.integrity.parityMismatches++;
        if (cause === 'unexplained') this.integrity.unexplained++;
      }

      if (anyDiffers) {
        const beforeLevel = levelOfChecks(s.before);
        const afterLevel = levelOfChecks(s.after);
        let direction = directionOfLevels(beforeLevel, afterLevel);
        if (direction === 'none') direction = allowedAfter > allowedBefore ? 'loosen' : 'tighten';
        const cause = mergeCauses(checkCauses);
        const key = `${s.service}|${beforeLevel}|${afterLevel}|${cause}`;
        let change = agg.changes.get(key);
        if (!change) {
          change = { service: s.service, before: beforeLevel, after: afterLevel, direction, cause, projects: new Set() };
          agg.changes.set(key, change);
        }
        change.projects.add(obs.projectLabel);
      }

      if (s.deferred) {
        const afterLevel = levelOfChecks(s.after);
        const deferredLevel = levelOfChecks(s.deferred);
        if (directionOfLevels(afterLevel, deferredLevel) === 'tighten') {
          const key = `${s.service}|${afterLevel}|${deferredLevel}`;
          let d = agg.deferred.get(key);
          if (!d) {
            d = { service: s.service, from: afterLevel, to: deferredLevel, projects: new Set() };
            agg.deferred.set(key, d);
          }
          d.projects.add(obs.projectLabel);
        }
      }
    }

    if (obs.principal.kind === 'user') {
      for (const surface of this.surfaces) {
        if (surfaceAllowed(surface, answers)) continue;
        let hits = this.surfaceHits.get(surface.id);
        if (!hits) {
          hits = new Map();
          this.surfaceHits.set(surface.id, hits);
        }
        let hit = hits.get(obs.principal.key);
        if (!hit) {
          hit = { principal: obs.principal.label, role: obs.principal.role, projects: new Set() };
          hits.set(obs.principal.key, hit);
        }
        hit.projects.add(obs.projectLabel);
      }
    }
  }

  /** Project access of one member: the scenarios whose outcome differs are kept, the rest are only counted. */
  addAccess(member: { label: string; role: string }, scenarios: readonly AccessScenario[], labelOf: (projectId: string | null) => string): void {
    this.accessMembers++;
    const changed: AccessReport['changes'][number]['scenarios'] = [];
    for (const sc of scenarios) {
      this.accessScenarios++;
      this.accessSummary[sc.change] = (this.accessSummary[sc.change] ?? 0) + 1;
      if (sc.change === 'same') continue;
      changed.push({
        cookie: sc.cookie === null ? '(none)' : labelOf(sc.cookie),
        before: describeOutcome(sc.before, labelOf),
        after: describeOutcome(sc.after, labelOf),
        change: sc.change,
      });
    }
    if (changed.length > 0) this.accessChanges.push({ user: member.label, role: member.role, scenarios: changed });
  }

  finish(): TenantAggregate {
    const byCause: TenantAggregate['byCause'] = {};
    for (const [cause, b] of this.buckets) {
      byCause[cause] = {
        decisions: b.decisions,
        tighten: b.tighten,
        loosen: b.loosen,
        principals: b.principals.size,
        principalServicePairs: b.pairs.size,
        services: [...b.services].sort(),
      };
    }

    const principalChanges: PrincipalChange[] = [];
    const deferredList: DeferredChange[] = [];
    const byProject = new Map<string, { principals: Set<string>; services: Set<string>; tighten: number; loosen: number }>();
    const byService = new Map<string, { principals: Set<string>; projects: Set<string>; tighten: number; loosen: number }>();
    let serviceChanges = 0;
    const changedUsers = new Set<string>();
    const changedTokens = new Set<string>();
    let deferredEntries = 0;

    for (const [key, p] of this.principals) {
      if (p.changes.size > 0) {
        const changes: ServiceChange[] = [...p.changes.values()]
          .map((c) => ({ service: c.service, before: c.before, after: c.after, direction: c.direction, cause: c.cause, projects: [...c.projects].sort() }))
          .sort((a, b) => a.service.localeCompare(b.service) || a.after.localeCompare(b.after));
        principalChanges.push({
          principal: p.info.label,
          kind: p.info.kind,
          role: p.info.role,
          ...(p.info.owner ? { owner: p.info.owner } : {}),
          causes: [...p.causes].filter((c) => c !== 'same' && c !== 'masked').sort(),
          changes,
        });
        (p.info.kind === 'user' ? changedUsers : changedTokens).add(key);
        for (const c of changes) {
          serviceChanges += c.projects.length;
          for (const project of c.projects) {
            const bp = byProject.get(project) ?? { principals: new Set<string>(), services: new Set<string>(), tighten: 0, loosen: 0 };
            bp.principals.add(key);
            bp.services.add(c.service);
            if (c.direction === 'tighten') bp.tighten++;
            else bp.loosen++;
            byProject.set(project, bp);
            const bs = byService.get(c.service) ?? { principals: new Set<string>(), projects: new Set<string>(), tighten: 0, loosen: 0 };
            bs.principals.add(key);
            bs.projects.add(project);
            if (c.direction === 'tighten') bs.tighten++;
            else bs.loosen++;
            byService.set(c.service, bs);
          }
        }
      }
      if (p.deferred.size > 0) {
        const changes = [...p.deferred.values()]
          .map((d) => ({ service: d.service, from: d.from, to: d.to, projects: [...d.projects].sort() }))
          .sort((a, b) => a.service.localeCompare(b.service));
        deferredEntries += changes.length;
        deferredList.push({
          principal: p.info.label,
          kind: p.info.kind,
          role: p.info.role,
          ...(p.info.owner ? { owner: p.info.owner } : {}),
          changes,
        });
      }
    }
    principalChanges.sort((a, b) => a.principal.localeCompare(b.principal));
    deferredList.sort((a, b) => a.principal.localeCompare(b.principal));

    const newlyGated: SurfaceSummary[] = this.surfaces.map((surface) => {
      const hits = this.surfaceHits.get(surface.id);
      return {
        id: surface.id,
        title: surface.title,
        edition: surface.edition,
        service: surface.service,
        level: surface.level,
        routes: surface.routes,
        count: hits ? hits.size : 0,
        principals: hits
          ? [...hits.values()]
            .map((h) => ({ principal: h.principal, role: h.role, projects: [...h.projects].sort() }))
            .sort((a, b) => a.principal.localeCompare(b.principal))
          : [],
      };
    });

    const sortedEntries = <T,>(map: Map<string, T>): Array<[string, T]> =>
      [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const projectRollup: Record<string, ProjectRollup> = {};
    for (const [name, v] of sortedEntries(byProject)) {
      projectRollup[name] = { principals: v.principals.size, services: v.services.size, tighten: v.tighten, loosen: v.loosen };
    }
    const serviceRollup: Record<string, ServiceRollup> = {};
    for (const [name, v] of sortedEntries(byService)) {
      serviceRollup[name] = { principals: v.principals.size, projects: v.projects.size, tighten: v.tighten, loosen: v.loosen };
    }

    return {
      contexts: this.contexts,
      decisions: this.decisions,
      same: this.same,
      masked: this.masked,
      differs: this.decisions - this.same - this.masked,
      tighten: this.tighten,
      loosen: this.loosen,
      serviceChanges,
      principalsChanged: { users: changedUsers.size, tokens: changedTokens.size },
      byCause,
      principalChanges,
      byProject: projectRollup,
      byService: serviceRollup,
      deferred: { principals: deferredList.length, entries: deferredEntries, list: deferredList },
      newlyGated,
      metricsExport: { count: this.scopedTokens.length, tokens: this.scopedTokens },
      integrity: { ...this.integrity },
      integrityExamples: this.integrityExamples,
    };
  }

  accessReport(): AccessReport {
    return {
      members: this.accessMembers,
      scenarios: this.accessScenarios,
      summary: { ...this.accessSummary },
      changes: [...this.accessChanges].sort((a, b) => a.user.localeCompare(b.user)),
    };
  }
}

function describeOutcome(outcome: AccessOutcome, labelOf: (projectId: string | null) => string): string {
  return outcome.ok ? labelOf(outcome.projectId) : `${outcome.status} ${outcome.error}`;
}
