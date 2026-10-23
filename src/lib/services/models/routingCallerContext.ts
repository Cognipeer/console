/**
 * Caller identity for Dynamic LLM routing rules: WHO is asking and through
 * WHICH door, as opposed to what the request contains. Every field is
 * optional — a rule that references a field the caller did not supply simply
 * does not match (see `evaluateCondition`).
 *
 * Callers either pass `callerContext` to `handleChatCompletion` explicitly or
 * open a scope with `runWithRoutingCaller` (agent runs do this), which every
 * model call downstream inherits through AsyncLocalStorage.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type RoutingChannel =
  | 'dashboard'
  | 'portal'
  | 'messaging'
  | 'api'
  | 'embed'
  | 'a2a'
  | 'schedule'
  | 'playground';

export const ROUTING_CHANNELS: readonly RoutingChannel[] = [
  'dashboard',
  'portal',
  'messaging',
  'api',
  'embed',
  'a2a',
  'schedule',
  'playground',
];

/**
 * The agent run a model call is made for, stamped on the call's usage row so
 * every call's tokens and cost are attributable the moment it settles — whatever
 * becomes of the run. Shared by reference through the scope and filled in as the
 * run learns it (`noteRoutingRun`): the turn id once the turn is open, the trace
 * session once its first event is stored.
 */
export interface RoutingRunAttribution {
  conversationId?: string;
  turnId?: string;
  runId?: string;
  traceSessionId?: string;
}

export interface RoutingCallerContext {
  channel?: RoutingChannel;
  userId?: string;
  /** Resolved lazily from `userId` when a rule references groups and this is absent. */
  groupIds?: string[];
  agentKey?: string;
  portalKey?: string;
  apiTokenId?: string;
  projectId?: string;
  run?: RoutingRunAttribution;
}

const storage = new AsyncLocalStorage<RoutingCallerContext>();

export function runWithRoutingCaller<T>(context: RoutingCallerContext, fn: () => T): T {
  // Inner scopes refine, they do not erase: a portal run keeps its channel
  // while the agent layer adds the agent key.
  return storage.run({ ...(storage.getStore() ?? {}), ...stripUndefined(context) }, fn);
}

export function getRoutingCaller(): RoutingCallerContext | undefined {
  return storage.getStore();
}

/**
 * Fills in what the ambient scope's run attribution has learned. A no-op outside
 * a run scope (a scope opened without `run` is not a run).
 */
export function noteRoutingRun(fields: RoutingRunAttribution): void {
  const run = storage.getStore()?.run;
  if (!run) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (run as Record<string, unknown>)[key] = value;
  }
}

/** Explicit context wins over the ambient one, field by field. */
export function mergeRoutingCaller(explicit?: RoutingCallerContext): RoutingCallerContext | undefined {
  const ambient = storage.getStore();
  if (!ambient && !explicit) return undefined;
  return { ...(ambient ?? {}), ...stripUndefined(explicit ?? {}) };
}

function stripUndefined(context: RoutingCallerContext): RoutingCallerContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as RoutingCallerContext;
}

/** Maps an agent run's origin (runtimeContext.source / request source) to a channel. */
export function channelFromSource(source: string | undefined): RoutingChannel | undefined {
  switch (source) {
    case 'portal':
    case 'messaging':
    case 'a2a':
    case 'playground':
    case 'api':
    case 'embed':
    case 'dashboard':
    case 'schedule':
      return source;
    case 'realtime':
    case 'mcp':
      return 'api';
    default:
      return undefined;
  }
}
