/**
 * Which session a stored file belongs to, for the routes that serve files without being session routes (the
 * Document Store, the client Files API).
 *
 * A file a session holds is a normal file in a bucket, marked `purpose: 'conversation'` with the id of its
 * conversation. Whoever may read or change that session may read or change the file; the Files API asks the
 * same question the session routes do (agent-session-access.ts) instead of treating the file as nobody's.
 *
 * The session also shows in the bucket's FOLDER view: its files sit in `<folder>/<agentKey>/<sessionId>/`, so
 * that sub-folder is a row of the listing of `<folder>/<agentKey>/` - and a row that names a session (by its
 * id) is no more the business of somebody who may not view that session than its files are.
 */

import type { FastifyRequest } from 'fastify';
import { getDatabase } from '@/lib/database';
import { chooseRelativeFileKey } from '@/lib/services/files';
import {
  pageOfVisibleRows,
  refuseSessionLinked,
  sessionActorOf,
  type SessionActor,
  type SessionRefusal,
} from './agent-session-access';

/** The conversation id a file record belongs to, or null for any other file. */
export function sessionOfFile(record: { purpose?: string | null; conversationId?: string | null } | null | undefined): string | null {
  if (!record || record.purpose !== 'conversation') return null;
  return typeof record.conversationId === 'string' && record.conversationId ? record.conversationId : null;
}

/**
 * The conversation id a sub-folder of a bucket listing stands for, or null for any other folder. A session's files
 * are stored under `<folder>/<agentKey>/<sessionId>/<unique name>` (sessionFileObjectKey), so the folder row of a
 * session is a path of at least two segments whose last one is its id; whether that id names a session of this
 * project is for the lookup to say (an ordinary folder names none).
 */
export function sessionOfFolder(folder: string | null | undefined): string | null {
  if (!folder) return null;
  const segments = folder.split('/').filter((segment) => segment.length > 0);
  return segments.length >= 2 ? segments[segments.length - 1] : null;
}

/**
 * One page of a bucket's object list for a caller who may not view every session: the files of somebody else's
 * session they may not view are left out - and so are the sub-folders of the listing that are the folder of such a
 * session (`sessionOfFolder`), so the folder view does not even name a session the caller may not open. The page
 * is FILLED from the following reads (a cursor continues after a whole read, so each asks for exactly what is
 * missing) instead of coming back short with the cursor already past what was dropped; a folder counts as an entry
 * of the page, as it does in the read itself. The scope behind both is decided once per request. The default
 * caller gets one plain read and no lookup.
 *
 * `read(cursor, size)` lists the unfiltered objects from `cursor` (absent: the start), at most `size` entries
 * (folders and files together).
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
  type Entry = { folder: string } | { item: R['items'][number] };
  let folderListing = false;
  let prefix: string | undefined;
  const page = await pageOfVisibleRows<Entry, string | undefined>(request, {
    start: input.cursor,
    limit: input.limit,
    threadIdOf: (entry) => ('folder' in entry ? sessionOfFolder(entry.folder) : sessionOfFile(entry.item)),
    ...(input.actor ? { actor: input.actor } : {}),
    fetchPage: async (position, size) => {
      const result = await input.read(position, size);
      if (result.folders) folderListing = true;
      if (result.prefix !== undefined) prefix = result.prefix;
      const rows: Entry[] = [
        ...(result.folders ?? []).map((folder): Entry => ({ folder })),
        ...result.items.map((item): Entry => ({ item })),
      ];
      return { rows, after: () => result.nextCursor ?? null };
    },
  });
  const items = page.rows.flatMap((entry) => ('item' in entry ? [entry.item] : []));
  const folders = [...new Set(page.rows.flatMap((entry) => ('folder' in entry ? [entry.folder] : [])))];
  return {
    items,
    ...(folderListing ? { folders } : {}),
    ...(prefix !== undefined ? { prefix } : {}),
    ...(page.next ? { nextCursor: page.next } : {}),
  };
}

/**
 * The first refusal among the sessions whose files an upload under this exact key would write over. Bytes written under
 * the key of a file a session holds change that session's file, like converting or deleting it: its owner always may,
 * anybody else needs `agent.session_manage_others`. A key that names a folder (or no key) gets a generated name of its
 * own, so nothing is there to write over. `null`: the key holds no session file, or the caller may manage its session.
 *
 * Every route that takes an upload asks this before it spends a quota or writes a byte: the Document Store (the
 * signed-in person) and the client Files API (the token's owner, passed as `actor`).
 *
 * The hint is already in the spelling the drivers store (`composeUploadKeyHint`: backslashes read as slashes, runs of
 * slashes collapsed), so the key looked up here is the key the object lands on.
 */
export async function sessionRefusedForUpload(
  request: FastifyRequest,
  input: {
    tenantDbName: string;
    projectId: string;
    bucket: { providerKey: string; key: string };
    keyHint: string | undefined;
    fileName: string;
    /** Who the upload acts for when the route already resolved them (a token's owner); default: the signed-in session. */
    actor?: SessionActor;
  },
): Promise<Exclude<SessionRefusal, { status: 404 }> | null> {
  const { keyHint } = input;
  if (!keyHint || keyHint.endsWith('/')) return null;
  const key = chooseRelativeFileKey(keyHint, input.fileName);
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);
  const occupants = await db.listFileRecordsByKeys({
    providerKey: input.bucket.providerKey,
    bucketKey: input.bucket.key,
    projectId: input.projectId,
    keys: [key],
  });
  const sessions = [...new Set(occupants.map((record) => sessionOfFile(record)).filter((id): id is string => id !== null))];
  if (sessions.length === 0) return null;

  const actor = input.actor ?? await sessionActorOf(request);
  for (const conversationId of sessions) {
    const denial = await refuseSessionLinked(request, conversationId, 'manage', { actor });
    if (denial) return denial;
  }
  return null;
}
