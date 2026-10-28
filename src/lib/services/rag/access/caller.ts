/**
 * Who is reading a knowledge base, as the server knows it.
 *
 * A `KbCaller` is built from what the SERVER stamped (the session, the API
 * token context, the runtime context of a run), never from anything a client
 * sent. It decides which principal keys the caller holds (identity.ts):
 *
 *  - person:    a console user (a session, a delegated token call, a run a
 *               person started). Holds their user, e-mail, groups and the
 *               external identities matched to them.
 *  - token:     an API token without a person. Holds only `everyone` and the
 *               token's own key; nothing of the token's owner.
 *  - anonymous: no person at all (a trigger run, a public endpoint, a synthetic
 *               actor). Holds only `everyone`.
 *  - system:    internal jobs (ingest, re-index, connector sync). Reads every
 *               document. Never built from a request.
 *
 * Deliberately NOT `consoleIdentityCallerOf`: that helper falls back to the
 * accountable user (a trigger's owner, a token's owner) so an upstream can be
 * billed or audited; for document access that fallback would hand a run the
 * owner's permissions.
 */

import type { ConsoleIdentityCaller } from '@/lib/iam/consoleIdentity';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';
import { isSyntheticActor } from '@/lib/services/agents/syntheticActor';

export type KbAnonymousReason = 'trigger' | 'public' | 'synthetic' | 'unknown';

export type KbCaller =
  | { kind: 'person'; userId: string; tokenId?: string; delegated?: boolean }
  | { kind: 'token'; tokenId: string; ownerUserId?: string }
  | { kind: 'anonymous'; reason: KbAnonymousReason }
  | { kind: 'system' };

/** Ingest, re-index and connector sync: every document. Never use for a request. */
export const KB_SYSTEM_CALLER: KbCaller = Object.freeze({ kind: 'system' }) as KbCaller;

export function anonymousKbCaller(reason: KbAnonymousReason = 'unknown'): KbCaller {
  return { kind: 'anonymous', reason };
}

function realUserId(userId: unknown): string | null {
  if (typeof userId !== 'string') return null;
  const id = userId.trim();
  if (!id || id === 'system' || isSyntheticActor(id)) return null;
  return id;
}

/** A dashboard session. */
export function kbCallerFromSession(session: { userId?: string | null } | null | undefined): KbCaller {
  const userId = realUserId(session?.userId);
  return userId ? { kind: 'person', userId } : anonymousKbCaller('unknown');
}

/**
 * A client-API call. With an active delegation the call acts for the person a
 * trusted issuer vouched for; otherwise it is the token alone.
 */
export function kbCallerFromApiToken(ctx: Pick<ApiTokenContext, 'tokenRecord' | 'user' | 'delegation'> | null | undefined): KbCaller {
  if (!ctx) return anonymousKbCaller('unknown');
  const tokenId = ctx.tokenRecord?._id ? String(ctx.tokenRecord._id) : undefined;
  if (ctx.delegation?.state === 'active') {
    const userId = realUserId(ctx.user?._id ? String(ctx.user._id) : undefined);
    return userId ? { kind: 'person', userId, tokenId, delegated: true } : anonymousKbCaller('unknown');
  }
  // A refused delegation is answered with an error before any handler runs; never fall back to the owner.
  if (ctx.delegation) return anonymousKbCaller('unknown');
  if (!tokenId) return anonymousKbCaller('unknown');
  const owner = ctx.tokenRecord?.userId ? String(ctx.tokenRecord.userId) : undefined;
  return { kind: 'token', tokenId, ...(owner ? { ownerUserId: owner } : {}) };
}

/**
 * The runtime context of a run (agents, MCP, realtime, portal, messaging,
 * reminders, queued runs). A run a trigger started has no person, whoever owns
 * the trigger.
 */
export function kbCallerFromRuntime(
  ctx: Pick<AgentRuntimeContext, 'userId' | 'tokenId' | 'source' | 'via'> | null | undefined,
): KbCaller {
  if (!ctx) return anonymousKbCaller('unknown');
  if (ctx.source === 'trigger') return anonymousKbCaller('trigger');
  const userId = realUserId(ctx.userId);
  if (!userId) {
    if (typeof ctx.userId === 'string' && ctx.userId.trim()) return anonymousKbCaller('synthetic');
    return ctx.tokenId ? { kind: 'token', tokenId: String(ctx.tokenId) } : anonymousKbCaller('unknown');
  }
  const tokenId = ctx.tokenId ? String(ctx.tokenId) : undefined;
  const delegated = ctx.via?.kind === 'delegated';
  // A token call that is not delegated is the application, not the owner the run is stamped with.
  if (tokenId && !delegated) return { kind: 'token', tokenId, ownerUserId: userId };
  return { kind: 'person', userId, ...(tokenId ? { tokenId } : {}), ...(delegated ? { delegated: true } : {}) };
}

/** The caller of an internal MCP provider call (same rules as a runtime context). */
export function kbCallerFromIdentity(caller: ConsoleIdentityCaller | null | undefined): KbCaller {
  if (!caller) return anonymousKbCaller('unknown');
  if (caller.source === 'trigger') return anonymousKbCaller('trigger');
  const userId = realUserId(caller.userId);
  if (!userId) {
    if (typeof caller.userId === 'string' && caller.userId.trim()) return anonymousKbCaller('synthetic');
    return caller.tokenId ? { kind: 'token', tokenId: String(caller.tokenId) } : anonymousKbCaller('unknown');
  }
  const tokenId = caller.tokenId ? String(caller.tokenId) : undefined;
  if (tokenId && caller.delegated !== true) return { kind: 'token', tokenId, ownerUserId: userId };
  return { kind: 'person', userId, ...(tokenId ? { tokenId } : {}), ...(caller.delegated ? { delegated: true } : {}) };
}

/** A short, secret-free description for logs. */
export function describeKbCaller(caller: KbCaller): string {
  switch (caller.kind) {
    case 'person': return caller.delegated ? 'person(delegated)' : caller.tokenId ? 'person(token)' : 'person';
    case 'token': return 'token';
    case 'anonymous': return `anonymous(${caller.reason})`;
    case 'system': return 'system';
    default: return 'unknown';
  }
}
