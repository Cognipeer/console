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

/** Every managed policy a tenant policy set starts with: the RBAC permits + the boundary forbids. */
export const ALL_MANAGED_POLICIES: Readonly<Record<string, string>> = Object.freeze({
  ...MANAGED_POLICIES,
  ...BOUNDARY_POLICIES,
});

export function isManagedPolicyId(id: string): boolean {
  return id.startsWith('managed:');
}

export type ManagedPolicyGroup = 'rbac' | 'boundary';

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
    group: id.startsWith('managed:boundary:') ? 'boundary' : 'rbac',
    effect: cedar.replace(/^(?:@\w+\([^)]*\)\s*)+/, '').trimStart().startsWith('forbid') ? 'forbid' : 'permit',
    cedar,
  }));
}
