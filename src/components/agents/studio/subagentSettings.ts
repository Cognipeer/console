/**
 * The pure half of Configure → Sub-agents: which delegation settings Save stores.
 */

import type { IAgentSubagent, IAgentSubagentPolicy } from '@/lib/database/provider/types.domain';

/**
 * The `subagentPolicy` to store. It is kept while the roster is not empty, and
 * also for an empty roster whenever delegation is not switched off: the policy
 * (mode, depth, limits) is set up before the first sub-agent is added, and a
 * Save in between must not throw it away. Only a switched-off policy with no
 * roster is nothing worth keeping.
 */
export function subagentPolicyToStore(
    subagents: readonly IAgentSubagent[],
    policy: IAgentSubagentPolicy | undefined,
): IAgentSubagentPolicy | undefined {
    if (!policy) return undefined;
    if (subagents.length > 0) return policy;
    return policy.mode === 'off' ? undefined : policy;
}
