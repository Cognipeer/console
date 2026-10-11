/**
 * Which session a stored file belongs to, for the routes that serve files without being session routes (the
 * Document Store, the client Files API).
 *
 * A file a session holds is a normal file in a bucket, marked `purpose: 'conversation'` with the id of its
 * conversation. Whoever may read or change that session may read or change the file; the Files API asks the
 * same question the session routes do (agent-session-access.ts) instead of treating the file as nobody's.
 */

/** The conversation id a file record belongs to, or null for any other file. */
export function sessionOfFile(record: { purpose?: string | null; conversationId?: string | null } | null | undefined): string | null {
  if (!record || record.purpose !== 'conversation') return null;
  return typeof record.conversationId === 'string' && record.conversationId ? record.conversationId : null;
}
