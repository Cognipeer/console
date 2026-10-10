/**
 * Managed policies: the six attribute-driven Cedar policies that reproduce the
 * CURRENT RBAC decision (rbac.ts authorizeServiceRequest) exactly.
 *
 * They contain no per-user and no per-group rule. All the arithmetic that Cedar
 * cannot do — role defaults, explicit user overrides that may LOWER a default,
 * group grants that only RAISE, owner short-circuit — is done by the entity
 * builder (entities.ts) with the real rbac.ts functions and handed over as the
 * principal's `readSvcs / writeSvcs / adminSvcs` sets. What is left for policy:
 *
 *   Read   : service in readSvcs
 *   Write  : service in writeSvcs AND (service is not adminService OR service in adminSvcs)
 *            (getRequiredPermissionLevel: mutations on adminService services need admin)
 *   Admin  : service in adminSvcs
 *   ApiToken: the owner's sets AND the token cap (scope can only narrow; `scoped`
 *            false = unscoped token = inherits the owner unchanged; scope {} =
 *            scoped with empty caps = deny every mapped service)
 *
 * Tenant independent and immutable at runtime: every tenant set starts with
 * these, custom policies are layered on top. Ids are `managed:rbac:*` and every
 * policy carries `@managed("rbac")` so a UI can tell them apart and the store
 * can refuse custom policies that try to claim the annotation.
 *
 * BOUNDARIES (A2) - `managed:boundary:*`, `@managed("boundary")`: six forbids that
 * sit in every evaluation next to the permits above. Cedar's forbid always wins,
 * so whatever a CUSTOM permit says, it can never exceed
 *
 *   - the scope of an API token (a scoped token is forbidden for an action whose
 *     level group's cap set lacks the service), nor
 *   - the project narrowing of the request (the services the active project's
 *     explicit settings deny at that level, `principal.projDenyRead/Write/Admin`;
 *     for a token the owner's).
 *
 * With zero custom policies they never change a decision (the permits above
 * already require both), which the parity fuzz proves. The Write rules mirror
 * the Write permits: a mutation on an adminService service additionally needs the
 * Admin level, so the cap / project denial of Admin applies to it as well.
 *
 * PORTALS - `managed:portal:*`, `@managed("portal")`: who may open a portal and run
 * its agents is decided by the portal's ACCESS LIST, which is the portal's built-in
 * policy. The list is not stored as Cedar: the Portal entity carries it as
 * attributes (`mode`, `allowedUsers`, `allowedGroups`, see portalEntities.ts) and
 * these four policies read them, so editing a portal's list never touches a policy.
 *
 *   portal:use / portal:agent                the list GRANTS `portal.use` on the portal and
 *                                            `agent.invoke` on an agent run through it
 *                                            (channel `portal`), to people (never tokens)
 *   portal:use-boundary / portal:agent-boundary
 *                                            forbid everyone the list does not name, so no RBAC
 *                                            level and no custom permit can open a portal the
 *                                            list does not (an owner who is not on the list is
 *                                            not let in either)
 *
 * Custom forbids still restrict on top: a rule that blocks a person, a group or one
 * agent wins over the list like it wins over any permit.
 *
 * Written so that they cannot error: every attribute read is behind `has`, the list
 * members are typed entity references (portalEntities.ts), and a managed forbid
 * that nevertheless errors fails the decision instead of being skipped (engine.ts).
 */

export const MANAGED_ANNOTATION = 'managed';

export const MANAGED_POLICY_IDS = {
  userRead: 'managed:rbac:user-read',
  userWrite: 'managed:rbac:user-write',
  userAdmin: 'managed:rbac:user-admin',
  tokenRead: 'managed:rbac:token-read',
  tokenWrite: 'managed:rbac:token-write',
  tokenAdmin: 'managed:rbac:token-admin',
} as const;

export const MANAGED_POLICIES: Readonly<Record<string, string>> = Object.freeze({
  [MANAGED_POLICY_IDS.userRead]:
    '@managed("rbac") permit(principal is User, action in Action::"Read", resource) when { principal.readSvcs.contains(resource.service) };',
  [MANAGED_POLICY_IDS.userWrite]:
    '@managed("rbac") permit(principal is User, action in Action::"Write", resource) when { principal.writeSvcs.contains(resource.service) && (!resource.adminService || principal.adminSvcs.contains(resource.service)) };',
  [MANAGED_POLICY_IDS.userAdmin]:
    '@managed("rbac") permit(principal is User, action in Action::"Admin", resource) when { principal.adminSvcs.contains(resource.service) };',
  [MANAGED_POLICY_IDS.tokenRead]:
    '@managed("rbac") permit(principal is ApiToken, action in Action::"Read", resource) when { principal.owner.readSvcs.contains(resource.service) && (!principal.scoped || principal.capRead.contains(resource.service)) };',
  [MANAGED_POLICY_IDS.tokenWrite]:
    '@managed("rbac") permit(principal is ApiToken, action in Action::"Write", resource) when { principal.owner.writeSvcs.contains(resource.service) && (!principal.scoped || principal.capWrite.contains(resource.service)) && (!resource.adminService || (principal.owner.adminSvcs.contains(resource.service) && (!principal.scoped || principal.capAdmin.contains(resource.service)))) };',
  [MANAGED_POLICY_IDS.tokenAdmin]:
    '@managed("rbac") permit(principal is ApiToken, action in Action::"Admin", resource) when { principal.owner.adminSvcs.contains(resource.service) && (!principal.scoped || principal.capAdmin.contains(resource.service)) };',
});

export const BOUNDARY_ANNOTATION_VALUE = 'boundary';

export const BOUNDARY_POLICY_IDS = {
  tokenCapRead: 'managed:boundary:token-cap-read',
  tokenCapWrite: 'managed:boundary:token-cap-write',
  tokenCapAdmin: 'managed:boundary:token-cap-admin',
  projectRead: 'managed:boundary:project-read',
  projectWrite: 'managed:boundary:project-write',
  projectAdmin: 'managed:boundary:project-admin',
} as const;

export const BOUNDARY_POLICIES: Readonly<Record<string, string>> = Object.freeze({
  [BOUNDARY_POLICY_IDS.tokenCapRead]:
    '@managed("boundary") forbid(principal is ApiToken, action in Action::"Read", resource) when { principal.scoped && !principal.capRead.contains(resource.service) };',
  [BOUNDARY_POLICY_IDS.tokenCapWrite]:
    '@managed("boundary") forbid(principal is ApiToken, action in Action::"Write", resource) when { principal.scoped && (!principal.capWrite.contains(resource.service) || (resource.adminService && !principal.capAdmin.contains(resource.service))) };',
  [BOUNDARY_POLICY_IDS.tokenCapAdmin]:
    '@managed("boundary") forbid(principal is ApiToken, action in Action::"Admin", resource) when { principal.scoped && !principal.capAdmin.contains(resource.service) };',
  [BOUNDARY_POLICY_IDS.projectRead]:
    '@managed("boundary") forbid(principal, action in Action::"Read", resource) when { (principal is User && principal.projDenyRead.contains(resource.service)) || (principal is ApiToken && principal.owner.projDenyRead.contains(resource.service)) };',
  [BOUNDARY_POLICY_IDS.projectWrite]:
    '@managed("boundary") forbid(principal, action in Action::"Write", resource) when { (principal is User && (principal.projDenyWrite.contains(resource.service) || (resource.adminService && principal.projDenyAdmin.contains(resource.service)))) || (principal is ApiToken && (principal.owner.projDenyWrite.contains(resource.service) || (resource.adminService && principal.owner.projDenyAdmin.contains(resource.service)))) };',
  [BOUNDARY_POLICY_IDS.projectAdmin]:
    '@managed("boundary") forbid(principal, action in Action::"Admin", resource) when { (principal is User && principal.projDenyAdmin.contains(resource.service)) || (principal is ApiToken && principal.owner.projDenyAdmin.contains(resource.service)) };',
});

export const PORTAL_POLICY_IDS = {
  use: 'managed:portal:use',
  useBoundary: 'managed:portal:use-boundary',
  agent: 'managed:portal:agent',
  agentBoundary: 'managed:portal:agent-boundary',
} as const;

/** "The requester is on this portal's access list", for a Portal entity expression `x` (`resource`, `resource.portal`), laid out for reading. */
function onAccessList(x: string, indent: string): string {
  return [
    `${x} has mode && (`,
    `${indent}  ${x}.mode == "all"`,
    `${indent}  || (${x} has allowedUsers && principal in ${x}.allowedUsers)`,
    `${indent}  || (${x} has allowedGroups && principal in ${x}.allowedGroups)`,
    `${indent})`,
  ].join('\n');
}

export const PORTAL_POLICIES: Readonly<Record<string, string>> = Object.freeze({
  [PORTAL_POLICY_IDS.use]: `@managed("portal")
permit (principal is User, action == Action::"portal.use", resource is Portal)
when {
  ${onAccessList('resource', '  ')}
};`,
  [PORTAL_POLICY_IDS.useBoundary]: `@managed("portal")
forbid (principal, action == Action::"portal.use", resource is Portal)
unless {
  principal is User
  && ${onAccessList('resource', '  ')}
};`,
  [PORTAL_POLICY_IDS.agent]: `@managed("portal")
permit (principal is User, action == Action::"agent.invoke", resource is Agent)
when {
  context has channel && context.channel == "portal"
  && resource has portal
  && ${onAccessList('resource.portal', '  ')}
};`,
  [PORTAL_POLICY_IDS.agentBoundary]: `@managed("portal")
forbid (principal, action == Action::"agent.invoke", resource is Agent)
when { context has channel && context.channel == "portal" }
unless {
  principal is User
  && resource has portal
  && ${onAccessList('resource.portal', '  ')}
};`,
});

/** Every managed policy a tenant policy set starts with: the RBAC permits, the boundary forbids and the portal access rules. */
export const ALL_MANAGED_POLICIES: Readonly<Record<string, string>> = Object.freeze({
  ...MANAGED_POLICIES,
  ...BOUNDARY_POLICIES,
  ...PORTAL_POLICIES,
});

export function isManagedPolicyId(id: string): boolean {
  return id.startsWith('managed:');
}

export type ManagedPolicyGroup = 'rbac' | 'boundary' | 'portal';

export interface ManagedPolicyInfo {
  /** Cedar policy id (`managed:rbac:user-read`). */
  id: string;
  group: ManagedPolicyGroup;
  effect: 'permit' | 'forbid';
  /** The Cedar source, as evaluated. */
  cedar: string;
}

/** Managed policies in a stable order, for display. */
export function listManagedPolicies(): ManagedPolicyInfo[] {
  return Object.entries(ALL_MANAGED_POLICIES).map(([id, cedar]) => ({
    id,
    group: managedGroupOf(id),
    effect: managedEffectOf(cedar),
    cedar,
  }));
}

function managedGroupOf(id: string): ManagedPolicyGroup {
  if (id.startsWith('managed:boundary:')) return 'boundary';
  if (id.startsWith('managed:portal:')) return 'portal';
  return 'rbac';
}

function managedEffectOf(cedar: string): 'permit' | 'forbid' {
  return cedar.replace(/^(?:@\w+\([^)]*\)\s*)+/, '').trimStart().startsWith('forbid') ? 'forbid' : 'permit';
}

/** Cedar ids of the managed policies that FORBID: a forbid that errors must never be skipped (engine.ts). */
export const MANAGED_FORBID_IDS: ReadonlySet<string> = new Set(
  Object.entries(ALL_MANAGED_POLICIES).filter(([, cedar]) => managedEffectOf(cedar) === 'forbid').map(([id]) => id),
);
