/**
 * Shared vocabulary of the pre-upgrade access report (scripts/iam/preflight-diff.ts):
 * levels, the three checks every service is asked, and how a pair of answers
 * (before / after) is turned into a cause.
 *
 * Pure: no database, no engine. Everything here is covered by
 * src/__tests__/unit/iam-preflight.test.ts.
 */

import { RBAC_SERVICE_DEFINITIONS, type PermissionService, type ServicePermissionLevel } from '@/lib/security/rbac';

export type Level = ServicePermissionLevel;

export const RANK: Readonly<Record<Level, number>> = { none: 0, read: 1, write: 2, admin: 3 };

// ── the three questions asked per service ─────────────────────────────────

export type CheckId = 'read' | 'write' | 'admin';

export interface CheckSpec {
  id: CheckId;
  /** The HTTP method a gate would see; decides the required level unless `level` is set. */
  method: 'GET' | 'POST';
  /** An explicit required level (what a handler-level `admin` check asks). */
  level?: 'admin';
}

/**
 * read  = a GET on the service
 * write = a POST on the service (a mutation: `admin` on administration services)
 * admin = an explicit admin-level check
 */
export const CHECKS: readonly CheckSpec[] = [
  { id: 'read', method: 'GET' },
  { id: 'write', method: 'POST' },
  { id: 'admin', method: 'POST', level: 'admin' },
];

export const CHECK_IDS: readonly CheckId[] = CHECKS.map((c) => c.id);

export type Checks = Record<CheckId, boolean>;

export const noChecks = (): Checks => ({ read: false, write: false, admin: false });

/** The highest level whose check (and every lower one) is allowed. */
export function levelOfChecks(checks: Checks): Level {
  if (!checks.read) return 'none';
  if (!checks.write) return 'read';
  if (!checks.admin) return 'write';
  return 'admin';
}

export function sameChecks(a: Checks, b: Checks): boolean {
  return a.read === b.read && a.write === b.write && a.admin === b.admin;
}

export type Direction = 'none' | 'tighten' | 'loosen';

export function directionOf(before: boolean, after: boolean): Direction {
  if (before === after) return 'none';
  return before ? 'tighten' : 'loosen';
}

export function directionOfLevels(before: Level, after: Level): Direction {
  if (RANK[before] === RANK[after]) return 'none';
  return RANK[after] < RANK[before] ? 'tighten' : 'loosen';
}

// ── services ──────────────────────────────────────────────────────────────

/**
 * Services that did not exist before the policy engine shipped. There was no
 * rule for them, so there is no "before" to compare: they are counted, not
 * reported as changes. (All four are administration services: owner and admin
 * only unless granted. `webhooks` arrived in the same release as the engine.)
 */
export const SERVICES_ADDED_WITH_ENGINE: ReadonlySet<string> = new Set(['portals', 'resources', 'iam', 'webhooks']);

export interface ComparedService {
  id: PermissionService;
  label: string;
  adminService: boolean;
}

/**
 * The services the report compares: everything with a route, minus the ones the
 * engine introduced (nothing to compare against) and the retired aliases
 * (nothing routes to them).
 */
export function comparedServices(): ComparedService[] {
  return RBAC_SERVICE_DEFINITIONS
    .filter((d) => !d.deprecated && !SERVICES_ADDED_WITH_ENGINE.has(d.id))
    .map((d) => ({ id: d.id, label: d.label, adminService: !!d.adminService }));
}

export function addedServices(): PermissionService[] {
  return RBAC_SERVICE_DEFINITIONS
    .filter((d) => !d.deprecated && SERVICES_ADDED_WITH_ENGINE.has(d.id))
    .map((d) => d.id);
}

// ── causes ────────────────────────────────────────────────────────────────

/**
 * Why an answer changes.
 *
 *  project-narrowing               a project-level service permission now caps the workspace level
 *  token-groups                    an API token now also gets the group grants of its owner
 *  token-groups+project-narrowing  both, on different answers of the same service
 *  masked                          two effects cancel out (the answer is the same)
 *  custom-policies                 the copy holds custom policies; they move the answer
 *  parity-mismatch                 INTEGRITY: the engine, fed the previous inputs, disagrees with the previous rules
 *  unexplained                     INTEGRITY: the engine disagrees with the new tenant-level rules without project levels
 */
export type Cause =
  | 'same'
  | 'masked'
  | 'project-narrowing'
  | 'token-groups'
  | 'token-groups+project-narrowing'
  | 'custom-policies'
  | 'parity-mismatch'
  | 'unexplained';

/** Causes that mean the report itself cannot be trusted (the exit code says so). */
export const INTEGRITY_CAUSES: ReadonlySet<Cause> = new Set<Cause>(['parity-mismatch', 'unexplained']);

/** Causes that are changes an operator has to decide about (everything but "same", "masked" and the integrity ones). */
export const CHANGE_CAUSES: readonly Cause[] = [
  'project-narrowing',
  'token-groups',
  'token-groups+project-narrowing',
  'custom-policies',
];

export interface CheckObservation {
  /** The workspace-level rules of the previous release (rbac.ts arithmetic). */
  before: boolean;
  /** The engine, asked the way the request gates ask it. */
  after: boolean;
  /**
   * Attribution inputs. The runner computes them when `after !== before` (and
   * for every check with --verify-all); without them an unchanged answer is
   * simply "same".
   */
  attribution?: {
    /** The engine fed the PREVIOUS inputs (no token groups, no project levels). */
    engineWithPreviousInputs: boolean;
    /** The engine with the new tenant-level rules (token groups) but without project levels. */
    engineWithoutProjectLevels: boolean;
    /** The arithmetic with the token owner's groups (equal to `before` for a session). */
    arithmeticWithOwnerGroups: boolean;
  };
  /** The copy holds custom policies in force: they can move any answer. */
  customPolicies: boolean;
}

export function classifyCheck(o: CheckObservation): Cause {
  const a = o.attribution;
  if (!a) return o.after === o.before ? 'same' : (o.customPolicies ? 'custom-policies' : 'unexplained');
  if (a.engineWithPreviousInputs !== o.before) return o.customPolicies ? 'custom-policies' : 'parity-mismatch';
  if (a.engineWithoutProjectLevels !== a.arithmeticWithOwnerGroups) return o.customPolicies ? 'custom-policies' : 'unexplained';
  const groupsChange = a.engineWithoutProjectLevels !== a.engineWithPreviousInputs;
  const narrowChange = o.after !== a.engineWithoutProjectLevels;
  if (!groupsChange && !narrowChange) return 'same';
  // One check has two answers: when both rules flip it, the second flip undoes the first.
  if (groupsChange && narrowChange) return 'masked';
  return groupsChange ? 'token-groups' : 'project-narrowing';
}

/** One cause for a service out of the causes of its (up to three) differing checks. */
export function mergeCauses(causes: readonly Cause[]): Cause {
  const relevant = causes.filter((c) => c !== 'same' && c !== 'masked');
  if (relevant.length === 0) return causes.includes('masked') ? 'masked' : 'same';
  if (relevant.includes('parity-mismatch')) return 'parity-mismatch';
  if (relevant.includes('unexplained')) return 'unexplained';
  if (relevant.includes('custom-policies')) return 'custom-policies';
  const groups = relevant.some((c) => c === 'token-groups' || c === 'token-groups+project-narrowing');
  const narrowing = relevant.some((c) => c === 'project-narrowing' || c === 'token-groups+project-narrowing');
  if (groups && narrowing) return 'token-groups+project-narrowing';
  return groups ? 'token-groups' : 'project-narrowing';
}

export const CAUSE_TITLES: Readonly<Record<Cause, string>> = {
  same: 'Unchanged',
  masked: 'Two effects cancel out',
  'project-narrowing': 'Project permissions now apply',
  'token-groups': 'API tokens now include the owner\'s group grants',
  'token-groups+project-narrowing': 'Token group grants and project permissions together',
  'custom-policies': 'Custom policies in the copy',
  'parity-mismatch': 'INTEGRITY: engine disagrees with the previous rules',
  unexplained: 'INTEGRITY: engine disagrees with the new workspace rules',
};

export const CAUSE_EXPLANATIONS: Readonly<Record<Cause, string>> = {
  same: 'The engine gives the same answer as the workspace-level rules of the previous release.',
  masked: 'A token-group grant and a project permission move the answer in opposite directions; the result equals the previous one.',
  'project-narrowing':
    'A project membership (a person\'s own or a group\'s) carries a service level. From the first request the effective level is the lower of the workspace level and the project level. '
    + 'A "No access" saved before the upgrade is ignored (see "Deferred" below); levels of Read, Write and Admin apply.',
  'token-groups':
    'Until now an API token took only its owner\'s own workspace level. From the first request it also gets the owner\'s group grants (the token scope remains a cap).',
  'token-groups+project-narrowing': 'Both rules apply to this token: some of the service\'s answers change because of the group grants, others because of the project permissions.',
  'custom-policies': 'The copy contains custom policies in force; the difference may come from them rather than from the built-in rules.',
  'parity-mismatch': 'Report this to support: the engine fed with the previous inputs does not reproduce the previous rules, so this report is not reliable.',
  unexplained: 'Report this to support: the engine does not match the documented rules, so this report is not reliable.',
};
