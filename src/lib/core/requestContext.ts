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

export interface RequestContext {
  requestId: string;
  tenantId?: string;
  tenantSlug?: string;
  userId?: string;
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
    startedAt: partial.startedAt ?? Date.now(),
  };
  return storage.run(ctx, fn);
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
