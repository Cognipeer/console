/**
 * Which session a stored file belongs to, for the routes that serve files without being session routes (the
 * Document Store, the client Files API).
 *
 * A file a session holds is a normal file in a bucket, marked `purpose: 'conversation'` with the id of its
 * conversation. Whoever may read or change that session may read or change the file; the Files API asks the
 * same question the session routes do (agent-session-access.ts) instead of treating the file as nobody's.
 */

import type { FastifyRequest } from 'fastify';
import { pageOfVisibleRows, type SessionActor } from './agent-session-access';

/** The conversation id a file record belongs to, or null for any other file. */
export function sessionOfFile(record: { purpose?: string | null; conversationId?: string | null } | null | undefined): string | null {
  if (!record || record.purpose !== 'conversation') return null;
  return typeof record.conversationId === 'string' && record.conversationId ? record.conversationId : null;
}

/**
 * One page of a bucket's object list for a caller who may not view every session: the files of somebody else's
 * session they may not view are left out, and the page is FILLED from the following reads (a cursor continues
 * after a whole read, so each asks for exactly what is missing) instead of coming back short with the cursor
 * already past what was dropped. The default caller gets one plain read.
 *
 * `read(cursor, size)` lists the unfiltered objects from `cursor` (absent: the start), at most `size`.
 */
export async function listVisibleFiles<R extends { items: Array<{ purpose?: string | null; conversationId?: string | null }>; folders?: string[]; prefix?: string; nextCursor?: string }>(
  request: FastifyRequest,
  input: {
    cursor: string | undefined;
    limit: number;
    read: (cursor: string | undefined, size: number) => Promise<R>;
    actor?: SessionActor;
  },
): Promise<{ items: R['items']; folders?: string[]; prefix?: string; nextCursor?: string }> {
  let folders: string[] | undefined;
  let prefix: string | undefined;
  const page = await pageOfVisibleRows<R['items'][number], string | undefined>(request, {
    start: input.cursor,
    limit: input.limit,
    threadIdOf: sessionOfFile,
    ...(input.actor ? { actor: input.actor } : {}),
    fetchPage: async (position, size) => {
      const result = await input.read(position, size);
      if (result.folders) folders = [...new Set([...(folders ?? []), ...result.folders])];
      if (result.prefix !== undefined) prefix = result.prefix;
      return { rows: result.items, after: () => result.nextCursor ?? null };
    },
  });
  return {
    items: page.rows,
    ...(folders ? { folders } : {}),
    ...(prefix !== undefined ? { prefix } : {}),
    ...(page.next ? { nextCursor: page.next } : {}),
  };
}
