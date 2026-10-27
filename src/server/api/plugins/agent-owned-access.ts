/**
 * Who may use an agent through the dashboard's `/api/agents/:agentId/...` routes
 * when the agent is a hidden one owned by a flow node.
 *
 * An ordinary agent is governed by the `agents` service. An owned agent is
 * governed by its OWNING FLOW instead: reading it, its sessions and its action
 * list needs `flows` read; changing its config, chatting with it in the
 * playground and resolving its pending approvals needs `flows` write. The
 * agent routes declare `authz.serviceAnyOf(['agents', 'flows'])`, so the gate
 * lets a holder of either service in, and this module asks the service the
 * agent actually belongs to (the gate may have admitted the caller on the other
 * one).
 *
 * Publishing and deleting an owned agent directly are refused (409
 * `owned_by_flow`): that happens only through the flow.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IAgent, IAgentOwner } from '@/lib/database';
import { isOwnedAgent } from '@/lib/utils/ownedAgents';
import { getFlowsHost } from '@/enterprise/flows';
import type { PermissionService } from '@/lib/security/rbac';
import {
  authorizeServiceForRequest,
  serviceOffRefusal,
  serviceRefusalError,
} from '../fastify-utils';

export interface AgentAccessOptions {
  /** `refuse`: the route is not available for an owned agent (409 `owned_by_flow`). Default `allow`. */
  owned?: 'allow' | 'refuse';
}

export const OWNED_BY_FLOW_BODY = {
  error: 'This agent belongs to a flow and is managed through it',
  type: 'owned_by_flow',
  code: 'owned_by_flow',
} as const;

/** The service an agent is governed by. */
export function serviceOfAgent(agent: Pick<IAgent, 'owner'>): PermissionService {
  return isOwnedAgent(agent) ? 'flows' : 'agents';
}

/** Does the flow the agent belongs to exist in this project? An orphan is not addressable. */
async function owningFlowExists(tenantDbName: string, tenantId: string, projectId: string, owner: IAgentOwner): Promise<boolean> {
  try {
    return Boolean(await getFlowsHost()?.describeFlow({ tenantDbName, tenantId, projectId }, { id: owner.flowId }));
  } catch {
    return false;
  }
}

/**
 * Authorizes the caller for `agent` against the service it belongs to. Throws
 * the gate's refusal (403 / 503 / `service_disabled`) when not allowed; sends
 * the 409 / 404 itself and returns false for a refused owned agent.
 */
export async function guardAgentAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  agent: IAgent,
  scope: { tenantDbName: string; tenantId: string; projectId: string },
  options: AgentAccessOptions = {},
): Promise<boolean> {
  const service = serviceOfAgent(agent);
  if (service === 'flows') {
    if (options.owned === 'refuse') {
      void reply.code(409).send(OWNED_BY_FLOW_BODY);
      return false;
    }
    if (!(await owningFlowExists(scope.tenantDbName, scope.tenantId, scope.projectId, agent.owner!))) {
      void reply.code(404).send({ error: 'Agent not found' });
      return false;
    }
  }
  if (request.iamGateService === service) {
    // The gate already decided this service at the method's level; a service switched off is still checked.
    const off = await serviceOffRefusal(request, service, { method: request.method });
    if (off) throw serviceRefusalError(request, off);
    return true;
  }
  // An ordinary agent on a route the gate did not run for (nothing to add); an owned agent is always asked.
  if (request.iamGateService === undefined && service === 'agents') return true;
  const result = await authorizeServiceForRequest(request, service, { method: request.method });
  if (!result.allowed) throw serviceRefusalError(request, result);
  request.iamGateService = service;
  return true;
}
