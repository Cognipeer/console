/**
 * Which resource actions something actually asks the engine about in THIS build.
 *
 * The HTTP gates ask about whole services. Some resource actions are asked by a
 * runtime instead (actions.ts, RUNTIME_ENFORCED_ACTIONS):
 *
 *  - opening a portal and running an agent through one, by the portal runtime
 *    (resourceAuthz.ts) - an enterprise feature: the `portal` channel exists only
 *    where the overlay registered the portal resolver (@/enterprise/iam-portal);
 *  - answering an approval, and looking at / acting on a session somebody else
 *    started, by the agent routes of the dashboard and the API - community code,
 *    always there; their `portal` channel (approvals) is the portal runtime's and
 *    follows the portal rule.
 *
 * Where a channel does not exist, a rule about the action in it would look like
 * protection and be none, so the policy compiler and the raw-Cedar check keep
 * refusing a deny rule that can only meet it there, exactly as they do for every
 * other resource action.
 *
 * Server only (it reads that registration). The static table is actions.ts.
 */

import { hasIamPortalResolver } from '@/enterprise/iam-portal';
import { RUNTIME_ENFORCED_ACTIONS } from './actions';
import type { IamChannel } from './context';

/** The channels `actionId` is decided in by a runtime of this build (empty: none). */
export function enforcedChannelsOf(actionId: string): IamChannel[] {
  const channels = RUNTIME_ENFORCED_ACTIONS[actionId];
  if (!channels) return [];
  const portal = hasIamPortalResolver();
  return channels.filter((channel) => channel !== 'portal' || portal);
}

/**
 * Is a request in `channel` (null = any channel) ever decided on `actionId` by a
 * runtime in this build? Service actions are the gates' and are not asked here.
 */
export function isRuntimeEnforced(actionId: string, channel: IamChannel | null = null): boolean {
  const channels = enforcedChannelsOf(actionId);
  return channel === null ? channels.length > 0 : channels.includes(channel);
}
