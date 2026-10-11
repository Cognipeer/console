/**
 * The Agent entity of the SESSION actions: approving a pending tool call (`agent.approve`,
 * appointed: the managed rule names the session's owner and whoever the agent accepts, allow
 * rules appoint more) and looking at / acting on a session somebody else started
 * (`agent.session_view_others`, `agent.session_manage_others`). Answering a QUESTION is the
 * second kind of action on the session, not an approval.
 *
 * Nothing is stored for them. A session belongs to the people who started it, so the
 * agent is described together with the session being asked about:
 *
 *   owners     Set<User>   whoever started the session (`conversation.createdBy`, and the
 *                          person whose turn raised the request, `action.createdBy`)
 *   approvers  String      the agent's own setting - `owner`, `owner_or_admin` (default),
 *                          `project_members` - which the managed rule (managedPolicies.ts)
 *                          reads as its input; Studio's "who can approve" stays the one place
 *                          that changes it
 *
 * The agent is built from the SESSION's own project (never the agent row's): an agent stored
 * without a project is tenant-wide and would otherwise have no Project parent, and
 * `resource in principal.projects` is how the rule asks "is this person on the project".
 *
 * `createdBy` is not always a user: `a2a-public`, `system:agent-scheduler`, `evaluation`,
 * `redteam` ... are written there too. They become references to Users that do not exist,
 * which no real person ever equals - sessions of that traffic are everybody else's. Cedar
 * accepts such dangling references (the portal's `allowedUsers` are the same).
 *
 * Pure and synchronous, like portalEntities.ts.
 */

import { resourceEntityTypeName } from './actions';
import type { IamResource } from './entities';
import { portalCedarEntity, type PortalAccessInput, type PortalRequester } from './portalEntities';

export type AgentApprovers = 'owner' | 'owner_or_admin' | 'project_members';

/** What the agent's `humanInTheLoop.approvers` means when it is not set (agentHumanInTheLoop.ts has the same default). */
export const DEFAULT_AGENT_APPROVERS: AgentApprovers = 'owner_or_admin';

export const AGENT_APPROVERS: readonly AgentApprovers[] = ['owner', 'owner_or_admin', 'project_members'];

export function isAgentApprovers(value: unknown): value is AgentApprovers {
  return typeof value === 'string' && (AGENT_APPROVERS as readonly string[]).includes(value);
}

const AGENT_TYPE = 'agent';
const AGENT_SERVICE = 'agents';

/** At most this many owners ride along (a session has one or two; a loop must not make a huge entity). */
const MAX_OWNERS = 20;

export interface AgentSessionSubject {
  /** The agent's resource id (the registry id, the same one `agent.get` is asked about). */
  id: string;
  key?: string;
  /** The project of the SESSION. */
  projectId?: string | null;
  /** Who started the session (user ids; anything else is simply nobody's). */
  ownerIds: ReadonlyArray<string | null | undefined>;
  /** The agent's accepted answerers; default `owner_or_admin`. */
  approvers?: AgentApprovers | string | null;
}

const entityRef = (type: string, id: string) => ({ __entity: { type, id } });

/** The distinct, non-empty owner ids (strings), in order. */
function ownerIdsOf(ids: AgentSessionSubject['ownerIds']): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const text = typeof id === 'string' ? id.trim() : '';
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= MAX_OWNERS) break;
  }
  return out;
}

function sessionAttrs(subject: AgentSessionSubject): Record<string, unknown> {
  return {
    approvers: isAgentApprovers(subject.approvers) ? subject.approvers : DEFAULT_AGENT_APPROVERS,
    owners: ownerIdsOf(subject.ownerIds).map((id) => entityRef('User', id)),
  };
}

/** The resource of a session action in the dashboard or API channel: the agent, with the session's owners and approvers. */
export function agentSessionResource(subject: AgentSessionSubject): IamResource {
  return {
    kind: 'resource',
    type: AGENT_TYPE,
    id: subject.id,
    service: AGENT_SERVICE,
    projectId: subject.projectId ?? null,
    ...(subject.key ? { key: subject.key } : {}),
    attrs: sessionAttrs(subject),
  };
}

/**
 * The resource of `agent.approve` in the portal channel: the same agent, `in` the portal it is run
 * through and naming it, with the portal (and its access list) sent along, so the portal's own
 * boundary (managed:portal:agent-boundary) applies on top of the approval rule.
 */
export function portalAgentSessionResource(
  subject: AgentSessionSubject,
  portal: { id: string; access: PortalAccessInput },
  requester?: PortalRequester,
): IamResource {
  const portalType = resourceEntityTypeName('portal');
  return {
    kind: 'resource',
    type: AGENT_TYPE,
    id: subject.id,
    service: AGENT_SERVICE,
    projectId: subject.projectId ?? null,
    ...(subject.key ? { key: subject.key } : {}),
    parents: [{ type: portalType, id: portal.id }],
    attrs: { ...sessionAttrs(subject), portal: entityRef(portalType, portal.id) },
    extra: [portalCedarEntity(portal.id, portal.access, requester)],
  };
}
