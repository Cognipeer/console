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

export function isManagedPolicyId(id: string): boolean {
  return id.startsWith('managed:');
}
