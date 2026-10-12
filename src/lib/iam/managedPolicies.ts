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
 *            (getRequiredPermissionLevel: mutations on adminService services need admin),
 *            for every action of the group EXCEPT `agent.approve`, which is appointed (see AGENTS)
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
 * the first four policies below read them, so editing a portal's list never touches a policy.
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
 * Three more settings of the portal are read the same way (attributes of the Portal entity,
 * flags of the request context), each opt-in so a portal that never turned one on behaves as before:
 *
 *   portal:network-boundary / portal:agent-network-boundary
 *                                            when the portal lists the networks it may be used from
 *                                            (`networkMode == "allow_list"`, ranges `net0` ... `net31`),
 *                                            forbid every request whose `context.ip` is in none of
 *                                            them - opening the portal, running its agents, answering
 *                                            its approvals; a request with no usable address is
 *                                            refused too. Nothing overrides it, test sessions and
 *                                            embedded sessions included
 *   portal:test-use / portal:test-agent      a workspace owner or admin may open the portal and run its
 *                                            agents in a TEST SESSION (`context.test`, set by the portal
 *                                            runtime for that button only) although the access list does
 *                                            not name them; the access list's boundary lets that session
 *                                            through too, the network boundary does not
 *   (the access list itself)                 a portal that takes people signed in through its embed
 *                                            (`embedAccess == "any_verified"`) also admits a request the
 *                                            runtime marks `context.embedded`: the host application vouched
 *                                            for that person with a signed token the portal verified
 *
 * AGENTS - `managed:agent:*`, `@managed("agent")`: who may answer a pending TOOL APPROVAL
 * (`agent.approve`: allow, deny, edit the arguments, remember for the session - and, as a side
 * effect, cancel somebody's open request) is decided by the SESSION the answer is about. The
 * Agent entity carries the people who started it (`owners`) and the agent's own `approvers`
 * setting (`owner`, `owner_or_admin`, `project_members`, agentEntities.ts); these two policies
 * read them, so nothing is stored per agent or per session.
 *
 *   agent:approve / agent:approve-token      the rule GRANTS `agent.approve` to a person, and to
 *                                            a token on behalf of its owner: whoever started the
 *                                            session; a project admin or a workspace owner / admin
 *                                            when the agent accepts admins; any member of the
 *                                            project when it accepts them
 *
 * `agent.approve` is APPOINTABLE: the generic RBAC Write permits above leave it out
 * (`action != Action::"agent.approve"`), so holding `agents:write` alone no longer answers
 * somebody else's request. The two rules above reproduce the agent's `approvers` setting exactly,
 * and a custom allow rule in IAM Center may name more approvers (a compliance group, say). There
 * is deliberately NO boundary forbid on the action: custom deny rules narrow, the token-scope and
 * project-narrowing boundaries (it is in the Write group) and the portal's access list (below)
 * still apply on top. Answering an agent's QUESTION is not an approval: it follows the ownership
 * of the session (`agent.session_manage_others`, agentEntities.ts).
 *
 * Written so that they cannot error: every attribute read is behind `has`, the list
 * members are typed entity references (portalEntities.ts), and a managed forbid
 * that nevertheless errors fails the decision instead of being skipped (engine.ts).
 */

import { PORTAL_NETWORK_SLOTS } from './portalNetworks';

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
    '@managed("rbac") permit(principal is User, action in Action::"Write", resource) when { action != Action::"agent.approve" && principal.writeSvcs.contains(resource.service) && (!resource.adminService || principal.adminSvcs.contains(resource.service)) };',
  [MANAGED_POLICY_IDS.userAdmin]:
    '@managed("rbac") permit(principal is User, action in Action::"Admin", resource) when { principal.adminSvcs.contains(resource.service) };',
  [MANAGED_POLICY_IDS.tokenRead]:
    '@managed("rbac") permit(principal is ApiToken, action in Action::"Read", resource) when { principal.owner.readSvcs.contains(resource.service) && (!principal.scoped || principal.capRead.contains(resource.service)) };',
  [MANAGED_POLICY_IDS.tokenWrite]:
    '@managed("rbac") permit(principal is ApiToken, action in Action::"Write", resource) when { action != Action::"agent.approve" && principal.owner.writeSvcs.contains(resource.service) && (!principal.scoped || principal.capWrite.contains(resource.service)) && (!resource.adminService || (principal.owner.adminSvcs.contains(resource.service) && (!principal.scoped || principal.capAdmin.contains(resource.service)))) };',
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
  networkBoundary: 'managed:portal:network-boundary',
  agentNetworkBoundary: 'managed:portal:agent-network-boundary',
  testUse: 'managed:portal:test-use',
  testAgent: 'managed:portal:test-agent',
} as const;

/**
 * "The requester is on this portal's access list", for a Portal entity expression `x` (`resource`, `resource.portal`), laid out for reading.
 * The last line is the embed setting: a portal that takes `any_verified` embedded people admits a request the runtime marks `context.embedded`.
 */
function onAccessList(x: string, indent: string): string {
  return [
    `${x} has mode && (`,
    `${indent}  ${x}.mode == "all"`,
    `${indent}  || (${x} has allowedUsers && principal in ${x}.allowedUsers)`,
    `${indent}  || (${x} has allowedGroups && principal in ${x}.allowedGroups)`,
    `${indent}  || (${x} has embedAccess && ${x}.embedAccess == "any_verified" && context has channel && context.channel == "portal" && context has embedded && context.embedded == true)`,
    `${indent})`,
  ].join('\n');
}

/** "A workspace owner or admin is trying the portal out": the runtime marks the request `context.test`; the role is checked here, not trusted. */
function testSession(indent: string): string {
  return [
    `context has channel && context.channel == "portal"`,
    `${indent}&& context has test && context.test == true`,
    `${indent}&& (principal.role == "owner" || principal.role == "admin")`,
  ].join('\n');
}

/** "The request comes from one of the portal's listed networks", for a Portal entity expression `x`: one line per slot of ranges. */
function inListedNetwork(x: string, indent: string): string {
  return [
    'context has ip && (',
    ...PORTAL_NETWORK_SLOTS.map((slot, i) => `${indent}  ${i === 0 ? '  ' : '||'} (${x} has ${slot} && context.ip.isInRange(${x}.${slot}))`),
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
  && (
    ${onAccessList('resource', '    ')}
    || (${testSession('      ')})
  )
};`,
  [PORTAL_POLICY_IDS.agent]: `@managed("portal")
permit (principal is User, action == Action::"agent.invoke", resource is Agent)
when {
  context has channel && context.channel == "portal"
  && resource has portal
  && ${onAccessList('resource.portal', '  ')}
};`,
  // Running an agent in a portal AND answering its pending requests there: both are open to the access list only
  // (and to an administrator's test session).
  [PORTAL_POLICY_IDS.agentBoundary]: `@managed("portal")
forbid (principal, action in [Action::"agent.invoke", Action::"agent.approve"], resource is Agent)
when { context has channel && context.channel == "portal" }
unless {
  principal is User
  && resource has portal
  && (
    ${onAccessList('resource.portal', '    ')}
    || (${testSession('      ')})
  )
};`,
  // The network boundary: a portal that lists its networks is reachable from those only. Opt-in per portal.
  [PORTAL_POLICY_IDS.networkBoundary]: `@managed("portal")
forbid (principal, action == Action::"portal.use", resource is Portal)
when { resource has networkMode && resource.networkMode == "allow_list" }
unless {
  ${inListedNetwork('resource', '  ')}
};`,
  [PORTAL_POLICY_IDS.agentNetworkBoundary]: `@managed("portal")
forbid (principal, action in [Action::"agent.invoke", Action::"agent.approve"], resource is Agent)
when {
  context has channel && context.channel == "portal"
  && resource has portal
  && resource.portal has networkMode
  && resource.portal.networkMode == "allow_list"
}
unless {
  ${inListedNetwork('resource.portal', '  ')}
};`,
  // A workspace owner or admin may try a portal out although the access list does not name them.
  [PORTAL_POLICY_IDS.testUse]: `@managed("portal")
permit (principal is User, action == Action::"portal.use", resource is Portal)
when {
  ${testSession('  ')}
};`,
  [PORTAL_POLICY_IDS.testAgent]: `@managed("portal")
permit (principal is User, action == Action::"agent.invoke", resource is Agent)
when {
  resource has portal
  && ${testSession('  ')}
};`,
});

export const AGENT_POLICY_IDS = {
  approve: 'managed:agent:approve',
  approveToken: 'managed:agent:approve-token',
  useModel: 'managed:agent:use-model',
} as const;

/**
 * "`who` may answer the pending tool approvals of this session", for a User entity expression `who`
 * (`principal`, or `principal.owner` for a token), laid out for reading. One predicate, written
 * once for the user permit and the token permit, so they cannot drift apart.
 *
 *   - whoever started the session always may (the agent's setting never takes that away);
 *   - `project_members`: anybody who belongs to the agent's project;
 *   - `owner_or_admin` (the default): a project admin of the agent's project, a workspace owner
 *     or admin, and the legacy tenant role `project_admin` inside the projects they belong to.
 */
function mayApprove(who: string, indent: string): string {
  return [
    `resource has approvers && (`,
    `${indent}  (resource has owners && resource.owners.contains(${who}))`,
    `${indent}  || (resource.approvers == "project_members" && resource in ${who}.projects)`,
    `${indent}  || (resource.approvers == "owner_or_admin" && (`,
    `${indent}    ${who}.role == "owner" || ${who}.role == "admin"`,
    `${indent}    || resource in ${who}.adminProjects`,
    `${indent}    || (${who}.role == "project_admin" && resource in ${who}.projects)`,
    `${indent}  ))`,
    `${indent})`,
  ].join('\n');
}

export const AGENT_POLICIES: Readonly<Record<string, string>> = Object.freeze({
  [AGENT_POLICY_IDS.approve]: `@managed("agent")
permit (principal is User, action == Action::"agent.approve", resource is Agent)
when {
  ${mayApprove('principal', '  ')}
};`,
  [AGENT_POLICY_IDS.approveToken]: `@managed("agent")
permit (principal is ApiToken, action == Action::"agent.approve", resource is Agent)
when {
  ${mayApprove('principal.owner', '  ')}
};`,
  // Running an agent on one of its additional models. The agent's own list bounds the choice; this rule only keeps the
  // default "usable by everyone who reaches the run" so that nothing changes until an administrator writes a forbid on
  // `context.model`. It names ONE action: it grants nothing else, and the main model is never asked about.
  [AGENT_POLICY_IDS.useModel]: `@managed("agent")
permit (principal, action == Action::"agent.use_model", resource is Agent);`,
});

/** Every managed policy a tenant policy set starts with: the RBAC permits, the boundary forbids, the portal access rules and the agent approval rules. */
export const ALL_MANAGED_POLICIES: Readonly<Record<string, string>> = Object.freeze({
  ...MANAGED_POLICIES,
  ...BOUNDARY_POLICIES,
  ...PORTAL_POLICIES,
  ...AGENT_POLICIES,
});

export function isManagedPolicyId(id: string): boolean {
  return id.startsWith('managed:');
}

export type ManagedPolicyGroup = 'rbac' | 'boundary' | 'portal' | 'agent';

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
  if (id.startsWith('managed:agent:')) return 'agent';
  return 'rbac';
}

function managedEffectOf(cedar: string): 'permit' | 'forbid' {
  return cedar.replace(/^(?:@\w+\([^)]*\)\s*)+/, '').trimStart().startsWith('forbid') ? 'forbid' : 'permit';
}

/** Cedar ids of the managed policies that FORBID: a forbid that errors must never be skipped (engine.ts). */
export const MANAGED_FORBID_IDS: ReadonlySet<string> = new Set(
  Object.entries(ALL_MANAGED_POLICIES).filter(([, cedar]) => managedEffectOf(cedar) === 'forbid').map(([id]) => id),
);
