/**
 * "View as": what would a person - or everybody in a group - meet at this portal?
 *
 * One read-only answer for the portal administrator's "View as" picker: can the audience open the
 * portal, and which of the portal's agents could they run. It asks the SAME engine, with the same
 * managed rules and custom policies, that the portal runtime asks (`portal.use` once, `agent.invoke`
 * per agent, in the portal channel, the person built without a project), so the answer is what that
 * audience would get. Nothing is recorded, nothing runs, and nobody is impersonated: there is no
 * session, no conversation and no token behind a view, only decisions.
 *
 * The audience is a PERSON (their groups, role and grants as they are) or a GROUP (a plain member of
 * it and nothing else - principals.ts `loadGroupAudience`). `ip` lets the administrator ask "from this
 * network?" against a network boundary, and `embedded` "as somebody who arrived through the embed?"
 * against the portal's embed setting. A test session is not part of a view: it is a way in for the
 * administrator themselves, not an audience.
 *
 * At most MAX_VIEW_AGENTS agents are decided; `truncated` says when the portal offers more.
 */

import { resolveIamPortal } from '@/enterprise/iam-portal';
import { normalizeIp } from './context';
import { authorize } from './engine';
import { loadEvaluationPrincipal, loadGroupAudience, PrincipalError, type EvaluationPrincipal, type IamTenant } from './principals';
import { portalAgentResource, portalResource } from './portalEntities';
import { explainReasons, SimulateInputError, type SimulateReason } from './simulate';
import { listPolicies } from './store';

export const MAX_VIEW_AGENTS = 50;

export interface PortalViewInput {
  portalId: string;
  audience: { type: 'user' | 'group'; id: string };
  /** The address the audience would come from (a network boundary is checked against it). */
  ip?: string;
  /** As somebody who arrived through the portal's embed with a verified host identity. */
  embedded?: boolean;
}

export interface PortalViewDecision {
  allowed: boolean;
  /** Denied because nothing allowed it (no rule matched), not because a rule forbade it. */
  defaultDeny: boolean;
  reasons: SimulateReason[];
}

export interface PortalViewAgent extends PortalViewDecision {
  agentId: string;
  key: string | null;
  name: string | null;
}

export interface PortalViewResult {
  portal: {
    id: string;
    key: string;
    name: string;
    status: 'enabled' | 'disabled';
    networks: { mode: 'any' | 'allow_list'; count: number };
    embedded: 'access_list' | 'any_verified';
  };
  audience: { type: 'user' | 'group'; id: string; label: string; disabled: boolean };
  /** Could they open the portal? (A disabled portal shows nobody anything; `portal.status` says so.) */
  canOpen: PortalViewDecision;
  /** One decision per agent the portal offers, in the portal's order. */
  agents: PortalViewAgent[];
  /** Agents the audience could run (only meaningful when `canOpen.allowed`). */
  runnableAgentIds: string[];
  truncated: boolean;
  /** Problems the engine met while evaluating; the decisions above already account for them. */
  errors?: string[];
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

export function parsePortalViewInput(input: unknown): PortalViewInput {
  const bad = (message: string, field: string): never => {
    throw new SimulateInputError('validation', message, 400, [{ message, field }]);
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('The request body must be an object', 'body');
  const i = input as Record<string, unknown>;
  if (!isText(i.portalId)) bad('portalId is required', 'portalId');
  const audience = i.audience as Record<string, unknown> | undefined;
  if (!audience || typeof audience !== 'object' || (audience.type !== 'user' && audience.type !== 'group') || !isText(audience.id)) {
    bad('audience must be { type: "user" | "group", id }', 'audience');
  }
  let ip: string | undefined;
  if (i.ip !== undefined && i.ip !== null && i.ip !== '') {
    const normalized = normalizeIp(i.ip);
    if (!normalized) bad('ip is not a valid IP address', 'ip');
    else ip = normalized;
  }
  if (i.embedded !== undefined && i.embedded !== null && typeof i.embedded !== 'boolean') bad('embedded must be true or false', 'embedded');
  return {
    portalId: i.portalId as string,
    audience: { type: (audience as { type: 'user' | 'group' }).type, id: (audience as { id: string }).id },
    ...(ip ? { ip } : {}),
    ...(i.embedded === true ? { embedded: true } : {}),
  };
}

/** What the audience would meet at the portal. Throws `SimulateInputError` for a portal or audience that does not exist. */
export async function simulatePortalView(tenant: IamTenant, rawInput: unknown): Promise<PortalViewResult> {
  const input = parsePortalViewInput(rawInput);

  const facts = await resolveIamPortal(tenant, input.portalId);
  if (!facts) throw new SimulateInputError('resource_not_found', `The portal "${input.portalId}" does not exist in this workspace`, 404);

  let audience: EvaluationPrincipal;
  try {
    audience = input.audience.type === 'group'
      ? await loadGroupAudience(tenant, input.audience.id)
      // A portal has no project: the person is read at workspace level, like the portal runtime reads them.
      : await loadEvaluationPrincipal(tenant, { type: 'user', id: input.audience.id }, null, { workspaceLevel: true });
  } catch (error) {
    if (error instanceof PrincipalError) throw new SimulateInputError('principal_not_found', error.message, 404);
    throw error;
  }

  const policies = await listPolicies(tenant.tenantDbName);
  const errors: string[] = [];
  const context = {
    channel: 'portal',
    ip: input.ip,
    ...(input.embedded ? { embedded: true } : {}),
  };
  const decide = async (action: string, resource: Parameters<typeof authorize>[0]['resource']): Promise<PortalViewDecision> => {
    const result = await authorize({ tenant: tenant.tenantDbName, principal: audience.principal, action, resource, context });
    if (result.failed) throw new SimulateInputError('engine_unavailable', 'The policy engine is not available on this server', 503);
    for (const e of result.errors.slice(0, 5)) if (!errors.includes(e)) errors.push(e);
    return {
      allowed: result.allowed,
      defaultDeny: !result.allowed && result.reasons.length === 0,
      reasons: explainReasons(result.reasons, policies),
    };
  };

  const requester = { userId: audience.principal.userId, groupIds: audience.principal.groupIds };
  const canOpen = await decide('portal.use', portalResource({ id: facts.id, key: facts.key, access: facts.access }, requester));

  const agentIds = facts.agentIds.slice(0, MAX_VIEW_AGENTS);
  const { getResource } = await import('@/lib/resources/service');
  const agents: PortalViewAgent[] = [];
  for (const agentId of agentIds) {
    let detail: Awaited<ReturnType<typeof getResource>> = null;
    try {
      detail = await getResource({ tenantDbName: tenant.tenantDbName, tenantId: tenant.tenantId, type: 'agent', id: agentId });
    } catch {
      // The name is a nicety; the decision does not need the project to be known.
    }
    const decision = await decide(
      'agent.invoke',
      portalAgentResource({ id: agentId, key: detail?.key ?? undefined, projectId: detail?.projectId ?? null }, { id: facts.id, access: facts.access }, requester),
    );
    agents.push({ agentId, key: detail?.key ?? null, name: detail?.name ?? null, ...decision });
  }

  const networks = facts.access.networks;
  return {
    portal: {
      id: facts.id,
      key: facts.key,
      name: facts.name,
      status: facts.status,
      networks: { mode: networks?.mode === 'allow_list' ? 'allow_list' : 'any', count: networks?.mode === 'allow_list' ? networks.cidrs.length : 0 },
      embedded: facts.access.embedded === 'any_verified' ? 'any_verified' : 'access_list',
    },
    audience: { type: input.audience.type, id: input.audience.id, label: audience.label, disabled: audience.accountDisabled },
    canOpen,
    agents,
    runnableAgentIds: agents.filter((a) => a.allowed).map((a) => a.agentId),
    truncated: facts.agentIds.length > MAX_VIEW_AGENTS,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
