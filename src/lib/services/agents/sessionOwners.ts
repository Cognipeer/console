/**
 * Who started a session, as a row of the Sessions table shows it.
 *
 * `conversation.createdBy` is a free string (agentService.ts `createConversation`): a console user's id for a
 * session started in Studio, the token OWNER's id for API traffic, and - for traffic that no person started -
 * `a2a-public`, `system:routine:<routineId>`, `evaluation`, `redteam`. A person gets their name; the rest get a
 * kind the table words itself (so it can be localized), never a made-up name.
 *
 * Session ownership is a permission (`agent.session_view_others` / `agent.session_manage_others`); the owner is
 * what the Sessions table shows next to each row so a person with the wide view can tell whose it is.
 */

import { getDatabase } from '@/lib/database';

export type SessionOwnerKind = 'user' | 'routine' | 'public_a2a' | 'evaluation' | 'redteam' | 'system' | 'unknown';

export interface SessionOwner {
  /** The stored `createdBy`. */
  id: string;
  kind: SessionOwnerKind;
  /** A person's display name (their email when they have no name); absent for anything else. */
  name?: string;
  email?: string;
}

/** The kind of owner an id stands for when it is not a person (null: it should be a person's id). */
export function nonUserOwnerKind(id: string): SessionOwnerKind | null {
  if (id === 'a2a-public') return 'public_a2a';
  if (id.startsWith('system:routine:')) return 'routine';
  if (id === 'evaluation') return 'evaluation';
  if (id === 'redteam') return 'redteam';
  if (id.startsWith('system:')) return 'system';
  return null;
}

/** At most this many distinct creators are looked up for one list (a page has few; a runaway would be capped). */
const MAX_LOOKUPS = 50;

/**
 * The owners of `ids` (distinct, order kept in the map). One lookup per distinct person, in parallel; a person
 * who cannot be found (deleted) stays a `user` without a name - the table shows the id.
 */
export async function resolveSessionOwners(ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, SessionOwner>> {
  const out = new Map<string, SessionOwner>();
  const people: string[] = [];
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw : '';
    if (!id || out.has(id)) continue;
    const kind = nonUserOwnerKind(id);
    if (kind) {
      out.set(id, { id, kind });
    } else {
      out.set(id, { id, kind: 'user' });
      people.push(id);
    }
  }
  if (people.length === 0) return out;
  const db = await getDatabase();
  await Promise.all(people.slice(0, MAX_LOOKUPS).map(async (id) => {
    try {
      const user = await db.findUserById(id);
      if (!user) return;
      const name = typeof user.name === 'string' && user.name.trim() ? user.name.trim() : undefined;
      out.set(id, { id, kind: 'user', ...(name ? { name } : {}), ...(user.email ? { email: user.email } : {}) });
    } catch {
      // An id that is not a user id at all stays what it is.
    }
  }));
  return out;
}
