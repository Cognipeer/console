/**
 * Who evaluation work reads a knowledge base as.
 *
 * A suite run (and a dataset generated from a knowledge base) acts for the
 * person who started it. When the actor is the placeholder evaluation uses
 * where nobody started the work, or any other id that is not a user row, it
 * reads as no one in particular: only what a knowledge base with access control
 * opens to everyone.
 */

import { anonymousKbCaller, kbCallerFromSession, type KbCaller } from '@/lib/services/rag/access/caller';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';

/**
 * Placeholders evaluation and red-team work is stamped with where nobody started it (`adapters.ts` stamps
 * 'evaluation'; a client API call without a token owner, 'api-token'). None is a user row.
 */
const PLACEHOLDER_ACTORS = new Set(['evaluation', 'redteam', 'api-token']);

/**
 * `tokenId`: the work was started through the client API with this token. It reads as the token, never as the
 * token's owner (a token holds only `everyone` and its own key, see rag/access/caller.ts).
 */
export function kbCallerForActor(userId: string | null | undefined, tokenId?: string | null): KbCaller {
  const id = typeof userId === 'string' ? userId.trim() : undefined;
  if (tokenId) return { kind: 'token', tokenId: String(tokenId), ...(id && !PLACEHOLDER_ACTORS.has(id) ? { ownerUserId: id } : {}) };
  if (!id || PLACEHOLDER_ACTORS.has(id)) return anonymousKbCaller('synthetic');
  const caller = kbCallerFromSession({ userId: id });
  return caller.kind === 'person' ? caller : anonymousKbCaller('synthetic');
}

/**
 * The runtime context an agent run of evaluation or red-team work carries, so its knowledge tools read as
 * `kbCallerForActor` says (none: nobody in particular).
 */
export function runtimeContextForActor(
  userId: string | null | undefined,
  tokenId: string | null | undefined,
  source: 'evaluation' | 'redteam',
): AgentRuntimeContext | undefined {
  const caller = kbCallerForActor(userId, tokenId);
  if (caller.kind === 'person') return { userId: caller.userId, source };
  if (caller.kind === 'token' && caller.ownerUserId) return { userId: caller.ownerUserId, tokenId: caller.tokenId, source };
  return undefined;
}
