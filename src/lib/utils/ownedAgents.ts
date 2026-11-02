/**
 * Hidden agents owned by another module (today: a flow node). An owned agent is created and managed by its
 * owner and never shows up in agent lists, pickers, portals, channels or discovery surfaces; it runs on the
 * normal agent engine. Pure helpers, safe for server and client code.
 */
import type { IAgentOwner } from '@/lib/database/provider/types.domain';

/** True for an agent that something else owns (lenient on purpose: anything owned by a flow stays out of lists). */
export function isOwnedAgent(agent: unknown): agent is { owner: IAgentOwner } {
  const owner = (agent as { owner?: Partial<IAgentOwner> | null } | null | undefined)?.owner;
  return Boolean(owner && typeof owner === 'object' && owner.kind === 'flow');
}

/** Drops owned agents from a list (a defensive filter: the API already leaves them out). */
export function withoutOwnedAgents<T>(agents: readonly T[]): T[] {
  return agents.filter((agent) => !isOwnedAgent(agent));
}
