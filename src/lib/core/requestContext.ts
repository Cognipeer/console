/**
 * Request Context — AsyncLocalStorage-based per-request context.
 *
 * Automatically propagated through the entire async call chain.
 * Logger, quota, services all read from this context transparently.
 *
 * Usage:
 *   import { getRequestContext, runWithRequestContext } from '@/lib/core/requestContext';
 *
 *   // In middleware / route entry:
 *   runWithRequestContext({ requestId, tenantId, userId }, async () => { ... });
 *
 *   // Anywhere downstream:
 *   const ctx = getRequestContext();   // { requestId, tenantId, ... } or undefined
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export type RequestActorType = 'user' | 'api_token' | 'system';
export type RequestSource = 'api' | 'dashboard' | 'system';

export interface RequestContext {
  requestId: string;
  tenantId?: string;
  tenantSlug?: string;
  userId?: string;
  projectId?: string;
  apiTokenId?: string;
  actorType?: RequestActorType;
  source?: RequestSource;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run a function within a request context.
 * All async operations spawned inside inherit the context automatically.
 */
export function runWithRequestContext<T>(
  partial: Partial<RequestContext>,
  fn: () => T,
): T {
  const ctx: RequestContext = {
    requestId: partial.requestId ?? randomUUID(),
    tenantId: partial.tenantId,
    tenantSlug: partial.tenantSlug,
    userId: partial.userId,
    projectId: partial.projectId,
    apiTokenId: partial.apiTokenId,
    actorType: partial.actorType,
    source: partial.source,
    startedAt: partial.startedAt ?? Date.now(),
  };
  return storage.run(ctx, fn);
}

/**
 * Merge fields into the CURRENT context in place, visible to the rest of the
 * scope. Used by handlers that resolve identity facets after the wrapper
 * opened the scope (e.g. session routes resolving the active project).
 */
export function patchRequestContext(patch: Partial<RequestContext>): void {
  const ctx = storage.getStore();
  if (ctx) {
    Object.assign(ctx, patch);
  }
}

/**
 * Snapshot the current context for deferred/queued work. Fire-and-forget jobs
 * (asyncTask, runners) lose the AsyncLocalStorage scope — capture a snapshot at
 * enqueue time and reopen it with `runWithRequestContext(snapshot, fn)` when
 * the job executes.
 */
export function captureRequestContext(): Partial<RequestContext> | undefined {
  const ctx = storage.getStore();
  return ctx ? { ...ctx } : undefined;
}

/**
 * Get the current request context (if any).
 * Returns undefined outside of a request context.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Convenience to get just the requestId (or generate one as fallback).
 */
export function getRequestId(): string {
  return storage.getStore()?.requestId ?? randomUUID();
}
