/**
 * Authorizers (`ApprovalAuthorizer`, agentActionResolution.ts) for people who answer through something that is
 * not an HTTP route of the console, so there is no request to take a principal from: the enterprise portal
 * runtime, which asks `agent.approve` in the `portal` channel on behalf of the portal's person.
 *
 * The routes of the dashboard and the API build theirs from the request (server/api/plugins/agent-approval-authz.ts).
 * Both ask the same question of the same engine: who started the session, which answerers the agent accepts, and -
 * for a portal - the portal's own access list on top.
 */

import type { RbacUserLike } from '@/lib/security/rbac';
import { portalAgentSessionResource } from '@/lib/iam/agentEntities';
import type { PortalAccessInput } from '@/lib/iam/portalEntities';
import { authorizeResourceAccess, type ResourceAuthzClient } from '@/lib/iam/resourceAuthz';
import type { ApprovalAuthorizer } from './agentActionResolution';

/** The engine could not decide: nobody is refused or allowed, the caller answers "try again" (503), never an allow. */
export class ApprovalUnavailableError extends Error {
    readonly code = 'authorization_unavailable';
    constructor(readonly decisionId: string | undefined) {
        super('Authorization is temporarily unavailable');
        this.name = 'ApprovalUnavailableError';
    }
}

export interface PortalApprovalInput {
    tenantDbName: string;
    tenantId: string;
    /** The portal's person. */
    userId: string;
    user?: RbacUserLike & { projectIds?: string[] };
    portal: { id: string; key?: string; name?: string; access: PortalAccessInput };
    /** The agent the portal runs: its registry id (what `agent.get` is asked about) and key. */
    agent: { id: string; key?: string };
    client?: ResourceAuthzClient;
}

/**
 * May this portal person answer the pending request? `agent.approve` in the portal channel: the approval rule
 * (the session's owner, the agent's setting) AND the portal's access list. Resolves a refusal as
 * `{ allowed: false, decisionId }`; throws `ApprovalUnavailableError` when the engine cannot decide.
 */
export function portalApprovalAuthorizer(input: PortalApprovalInput): ApprovalAuthorizer {
    return async ({ conversation, action, approvers }) => {
        const result = await authorizeResourceAccess({
            tenantDbName: input.tenantDbName,
            tenantId: input.tenantId,
            userId: input.userId,
            ...(input.user ? { user: input.user } : {}),
            channel: 'portal',
            action: 'agent.approve',
            resource: (requester) => portalAgentSessionResource(
                {
                    id: input.agent.id,
                    key: input.agent.key ?? conversation.agentKey,
                    projectId: conversation.projectId,
                    ownerIds: [String(conversation.createdBy ?? ''), action.createdBy],
                    approvers,
                },
                { id: input.portal.id, access: input.portal.access },
                requester,
            ),
            subject: {
                portalId: input.portal.id,
                ...(input.portal.key ? { portalKey: input.portal.key } : {}),
                resourceName: input.portal.name ?? input.agent.key ?? conversation.agentKey,
            },
            ...(input.client ? { client: input.client } : {}),
        });
        if (result.allowed) return { allowed: true };
        if (result.unavailable) throw new ApprovalUnavailableError(result.decisionId);
        return { allowed: false, ...(result.decisionId ? { decisionId: result.decisionId } : {}) };
    };
}
