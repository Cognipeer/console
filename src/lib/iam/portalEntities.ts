/**
 * Entities of the portal rules: a Portal that carries its ACCESS LIST, and an
 * Agent that is run through one.
 *
 * Nothing is stored per portal. The managed portal policies (managedPolicies.ts)
 * read three attributes of the Portal entity,
 *
 *   mode          'all' (everyone in the workspace) | 'selected'
 *   allowedUsers  Set<User>   the people named on the list
 *   allowedGroups Set<Group>  the groups named on the list
 *
 * and an Agent run through the portal is `in` it and names it in `portal`, so a
 * custom rule can say `resource in Portal::"<id>"` and cover both opening the
 * portal and running its agents. Two more settings travel the same way: the embed
 * setting (`embedAccess`, set only for 'any_verified') and the network boundary
 * (`networkMode` and the numbered ranges, portalNetworks.ts). Pure and synchronous: reading the list from the
 * portal feature is the resolver seam (@/enterprise/iam-portal) or the caller's.
 *
 * Every list member is a TYPED entity reference, never a plain string: the managed
 * rules test `principal in resource.allowedUsers`, which Cedar refuses to evaluate
 * over strings. A rule that errors does not decide anything, so the builders never
 * let a value of the wrong shape through (an entry that is not a text is left out).
 *
 * Large lists: Cedar's cost grows with the number of entries (~7 µs each; measured
 * with these builders, a whole decision takes 0.3 ms for 2 entries, 1.7 ms for 200
 * and 15 ms for 2,000). The managed rules only ever ask whether the REQUESTER is on
 * the list, so above PORTAL_ENTITY_SLICE_THRESHOLD entries and when the requester is
 * known, the entity carries just the requester's slice of the list - the same
 * decision (0.3-0.5 ms at any size), a fraction of the work. (A custom rule that looks at OTHER members of `allowedUsers` sees the
 * slice, not the whole list; the Access check, which has no requester slice to
 * build, always evaluates the whole list.)
 */

import type { IamPortalAccessFacts } from '@/enterprise/iam-portal';
import { resourceEntityTypeName } from './actions';
import type { CedarEntity } from './cedar';
import { resourceEntities, type IamResource } from './entities';
import { portalNetworkAttrs } from './portalNetworks';

/** Above this many entries (people + groups) a request carries only the requester's slice of the list. */
export const PORTAL_ENTITY_SLICE_THRESHOLD = 200;

const PORTAL_TYPE = 'portal';
const PORTAL_SERVICE = 'portals';
const AGENT_TYPE = 'agent';
const AGENT_SERVICE = 'agents';

/** Whoever asks: enough to cut a list down to what concerns them. */
export interface PortalRequester {
  userId: string;
  groupIds: readonly string[];
}

export type PortalAccessInput = Pick<IamPortalAccessFacts, 'mode' | 'userIds' | 'groupIds'> & Partial<Pick<IamPortalAccessFacts, 'networks' | 'embedded'>>;

const entityRef = (type: string, id: string) => ({ __entity: { type, id } });

const texts = (values: readonly unknown[] | null | undefined): string[] =>
  (Array.isArray(values) ? values : []).filter((v): v is string => typeof v === 'string' && v !== '');

/** The access list as Portal attributes, cut down to the requester's slice when that is what the size calls for. */
function accessAttrs(access: PortalAccessInput, requester?: PortalRequester): Record<string, unknown> {
  // Anything that is not exactly 'all' is 'selected': a list we cannot read admits only who it names.
  const mode = access?.mode === 'all' ? 'all' : 'selected';
  let userIds = texts(access?.userIds);
  let groupIds = texts(access?.groupIds);
  if (requester && userIds.length + groupIds.length > PORTAL_ENTITY_SLICE_THRESHOLD) {
    const mine = new Set(requester.groupIds.map(String));
    userIds = userIds.includes(String(requester.userId)) ? [String(requester.userId)] : [];
    groupIds = groupIds.filter((id) => mine.has(id));
  }
  return {
    mode,
    allowedUsers: userIds.map((id) => entityRef('User', id)),
    allowedGroups: groupIds.map((id) => entityRef('Group', id)),
    // Only an explicit 'any_verified' opens the door; anything else (absent, unknown) is the access list alone.
    ...(access?.embedded === 'any_verified' ? { embedAccess: 'any_verified' } : {}),
    // The network boundary is opt-in: a portal that never listed networks carries no network attribute.
    ...portalNetworkAttrs(access?.networks),
  };
}

export interface PortalSubject {
  id: string;
  key?: string;
  access: PortalAccessInput;
}

/** The Portal as a Cedar entity (what an agent resource sends along as `extra`). */
export function portalCedarEntity(portalId: string, access: PortalAccessInput, requester?: PortalRequester): CedarEntity {
  const { entities } = resourceEntities({
    kind: 'resource',
    type: PORTAL_TYPE,
    id: portalId,
    service: PORTAL_SERVICE,
    attrs: accessAttrs(access, requester),
  });
  return entities[0];
}

/** The resource of `portal.use`: the portal, with its access list. */
export function portalResource(portal: PortalSubject, requester?: PortalRequester): IamResource {
  return {
    kind: 'resource',
    type: PORTAL_TYPE,
    id: portal.id,
    service: PORTAL_SERVICE,
    ...(portal.key ? { key: portal.key } : {}),
    attrs: accessAttrs(portal.access, requester),
  };
}

export interface PortalAgentSubject {
  /** The agent's resource id (the registry id, the same one `agent.get` is asked about). */
  id: string;
  key?: string;
  projectId?: string | null;
}

/**
 * The resource of `agent.invoke` in the portal channel: the agent, `in` the portal
 * it is run through and naming it, with the portal (and its access list) sent along.
 */
export function portalAgentResource(
  agent: PortalAgentSubject,
  portal: Pick<PortalSubject, 'id' | 'access'>,
  requester?: PortalRequester,
): IamResource {
  const portalType = resourceEntityTypeName(PORTAL_TYPE);
  return {
    kind: 'resource',
    type: AGENT_TYPE,
    id: agent.id,
    service: AGENT_SERVICE,
    projectId: agent.projectId ?? null,
    ...(agent.key ? { key: agent.key } : {}),
    parents: [{ type: portalType, id: portal.id }],
    attrs: { portal: entityRef(portalType, portal.id) },
    extra: [portalCedarEntity(portal.id, portal.access, requester)],
  };
}
