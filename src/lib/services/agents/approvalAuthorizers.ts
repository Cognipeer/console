/**
 * Authorizers (`ApprovalAuthorizer`, agentActionResolution.ts) for people who answer through something that is
 * not an HTTP route of the console, so there is no request to take a principal from: the enterprise portal
 * runtime, which asks `agent.approve` in the `portal` channel on behalf of the portal's person.
 *
 * The routes of the dashboard and the API build theirs from the request (server/api/plugins/agent-approval-authz.ts).
 * Both ask the same question of the same engine: who started the session, which answerers the agent accepts, and -
 * for a portal - the portal's own access list on top.
 *
 * A QUESTION is not an approval: it follows the ownership of the session (the person who started it always may), so
 * a portal never asks `agent.approve` about one - the portal person is the owner by construction (the portal
 * backend loads only their own conversations) and the portal's access list already ran as `agent.invoke` before the
 * answer.
 *
 * EE seam: `resolveAgentPendingAction` / `checkAgentPendingActionResolution` take `authorize` (use
 * `portalApprovalAuthorizer`) and report a new outcome `{ kind: 'unavailable', decisionId? }` when the engine could
 * not decide; the portal answers it 503 `AUTHORIZATION_UNAVAILABLE`, like its message path does, instead of the
 * generic 502 its `default` branch would give. `ResolveActor` is unchanged.
 */

import type { RbacUserLike } from '@/lib/security/rbac';
import { portalAgentSessionResource } from '@/lib/iam/agentEntities';
import type { PortalAccessInput } from '@/lib/iam/portalEntities';
import { authorizeResourceAccess, type ResourceAuthzClient } from '@/lib/iam/resourceAuthz';
import type { ApprovalAuthorizer } from './agentActionResolution';

/**
 * The engine could not decide: nobody is refused or allowed, the caller answers "try again" (503), never an allow.
 * An authorizer may throw this instead of returning an `unavailable` verdict; the resolve service reads both the same way.
 */
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
    /**
     * The agent the portal runs: its registry id (what `agent.get` is asked about), key and, when the caller has it,
     * display name (what an audit row calls the agent; the key otherwise).
     */
    agent: { id: string; key?: string; name?: string };
    client?: ResourceAuthzClient;
}

/**
 * May this portal person answer the pending request? A tool approval asks `agent.approve` in the portal channel:
 * the approval rule (the session's owner, the agent's setting) AND the portal's access list. Resolves a refusal
 * as `{ allowed: false, decisionId }`, and an engine that cannot decide as `{ allowed: false, unavailable: true,
 * decisionId }` (the resolve outcome is then `unavailable`).
 */
export function portalApprovalAuthorizer(input: PortalApprovalInput): ApprovalAuthorizer {
    return async ({ conversation, action, approvers }) => {
        if (action.kind === 'user_question') {
            const owns = [String(conversation.createdBy ?? ''), action.createdBy].some((id) => !!id && id === input.userId);
            return owns ? { allowed: true } : { allowed: false };
        }
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
                // The thing asked about is the AGENT's session: the row names the agent (the portal is named apart,
                // `portalName`), so the feed reads "approving a tool call of agent X in portal Y" and not the other way round.
                resourceName: input.agent.name ?? input.agent.key ?? conversation.agentKey,
                ...(input.portal.name ? { portalName: input.portal.name } : {}),
            },
            ...(input.client ? { client: input.client } : {}),
        });
        if (result.allowed) return { allowed: true };
        if (result.unavailable) return { allowed: false, unavailable: true, ...(result.decisionId ? { decisionId: result.decisionId } : {}) };
        return { allowed: false, ...(result.decisionId ? { decisionId: result.decisionId } : {}) };
    };
}
