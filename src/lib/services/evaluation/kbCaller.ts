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

/** The actor `adapters.ts` stamps on agent runs that have no person behind them. */
const EVALUATION_ACTOR = 'evaluation';

export function kbCallerForActor(userId: string | null | undefined): KbCaller {
  const id = typeof userId === 'string' ? userId.trim() : undefined;
  if (id === EVALUATION_ACTOR) return anonymousKbCaller('synthetic');
  const caller = kbCallerFromSession({ userId: id });
  return caller.kind === 'person' ? caller : anonymousKbCaller('synthetic');
}
