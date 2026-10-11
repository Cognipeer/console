'use client';

/**
 * The agent session a trace thread belongs to, for drawing the pictures its
 * recorded messages name by reference (`session-file://<id>`).
 *
 * A thread that is not an agent session of this project (an API caller's own
 * thread id, another project's) has none, and so does a lookup that fails: the
 * inspector then lists those pictures by name, as it always did. Nothing here
 * decides what the viewer may open — the session's content route does.
 */

import { useEffect, useState } from 'react';
import type { TraceSessionFiles } from './messageImages';

export function traceSessionUrl(threadId: string): string {
  return `/api/tracing/threads/${encodeURIComponent(threadId)}/session`;
}

/** The body of `GET /api/tracing/threads/:threadId/session`, or null when it does not name a session. */
export function parseTraceSession(body: unknown): TraceSessionFiles | null {
  if (!body || typeof body !== 'object') return null;
  const { agentId, sessionId } = body as { agentId?: unknown; sessionId?: unknown };
  return typeof agentId === 'string' && agentId && typeof sessionId === 'string' && sessionId
    ? { agentId, sessionId }
    : null;
}

export function useTraceSessionFiles(threadId: string | null | undefined): TraceSessionFiles | null {
  const [found, setFound] = useState<{ threadId: string; session: TraceSessionFiles | null } | null>(null);

  useEffect(() => {
    if (!threadId) return undefined;
    let cancelled = false;
    (async () => {
      let session: TraceSessionFiles | null = null;
      try {
        const response = await fetch(traceSessionUrl(threadId), { cache: 'no-store' });
        if (response.ok) session = parseTraceSession(await response.json());
      } catch {
        // No session to draw from: the pictures stay named chips.
      }
      if (!cancelled) setFound({ threadId, session });
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // An answer that belongs to an earlier thread is not this thread's.
  return found && found.threadId === threadId ? found.session : null;
}
