/**
 * Which resource actions something actually asks the engine about in THIS build.
 *
 * The HTTP gates ask about whole services. Opening a portal and running an agent
 * through one are asked by the portal runtime, with `channel: 'portal'`
 * (resourceAuthz.ts) - but that runtime is an enterprise feature. Where it does not
 * exist, a rule about these actions would look like protection and be none, so the
 * policy compiler and the raw-Cedar check keep refusing a deny rule about them,
 * exactly as they do for every other resource action. The enterprise overlay
 * announces the runtime by registering the portal resolver (@/enterprise/iam-portal).
 *
 * Server only (it reads that registration). The static table is actions.ts.
 */

import { hasIamPortalResolver } from '@/enterprise/iam-portal';
import { RUNTIME_ENFORCED_ACTIONS } from './actions';
import type { IamChannel } from './context';

/**
 * Is a request in `channel` (null = any channel) ever decided on `actionId` by a
 * runtime in this build? Service actions are the gates' and are not asked here.
 */
export function isRuntimeEnforced(actionId: string, channel: IamChannel | null = null): boolean {
  const channels = RUNTIME_ENFORCED_ACTIONS[actionId];
  if (!channels || !hasIamPortalResolver()) return false;
  return channel === null ? channels.length > 0 : channels.includes(channel);
}

/** The channels `actionId` is decided in by a runtime of this build (empty: none). */
export function enforcedChannelsOf(actionId: string): IamChannel[] {
  const channels = RUNTIME_ENFORCED_ACTIONS[actionId];
  return channels && hasIamPortalResolver() ? [...channels] : [];
}
