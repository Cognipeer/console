/**
 * Who may see, mint, edit and revoke whose API tokens.
 *
 * A token authorises as its owner, so the rule is "never upward": the workspace
 * owner touches everyone's, an admin everyone's but the owner's, a project_admin
 * only those of login-disabled accounts (the service-account pattern), a user
 * only their own. Reading follows the same rule as writing - a list must never
 * show what opening that person by id would refuse.
 *
 * The pure predicates come first (the dashboard routes, the people policy and the
 * client API share them); the lookups that need the database follow.
 */

import { createLogger } from '@/lib/core/logger';
import type { DatabaseProvider, IApiToken, IUser } from '@/lib/database';

const logger = createLogger('service:api-tokens:governance');

type TokenDatabase = Pick<DatabaseProvider, 'findUserById' | 'listProjectApiTokens'>;

/** What the rules need to know about the person a token belongs to. */
export interface TokenOwnerFacts {
  role?: string | null;
  canLogin?: boolean | null;
}

/** The signed-in caller of a token route. */
export interface TokenActor {
  userId: string;
  userRole: string;
  tenantId: string;
}

/**
 * Whether `actorRole` may act on (mint for, list, edit or delete the tokens of)
 * `target`.
 *
 * A token minted in someone's name authorises as that someone, so the rule is
 * "never upward": nobody but the owner touches the owner, and a project_admin
 * - whose own `tokens` permission is only `write` - is confined to the one case
 * the mint-for-others feature exists for: a login-disabled `user`-role account
 * (a service account) that can never reach the token endpoints with a session of
 * its own. Self-service is always allowed and is decided before this is consulted.
 */
export function canActOnTokensOf(
  actorRole: string,
  target: TokenOwnerFacts,
): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return target.role !== 'owner';
  if (actorRole === 'project_admin') {
    return target.role === 'user' && target.canLogin === false;
  }
  return false;
}

/** Roles that may ask for the project-wide listing (`GET /tokens?scope=project`). */
export function canListProjectTokens(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Whether the session may see, edit and delete `token`.
 *
 * A token is its owner's, so the owner always can. Anyone else follows the
 * never-upward rule, judged on the token owner's current account; `owner` is
 * null when that account cannot be resolved (it is gone, its id is unreadable, or
 * the lookup failed), which only the owner role - it dominates every other - still
 * reaches.
 */
export function canManageToken(
  session: Pick<TokenActor, 'userId' | 'userRole'>,
  token: Pick<IApiToken, 'userId'>,
  owner: TokenOwnerFacts | null,
): boolean {
  if (String(token.userId) === String(session.userId)) return true;
  if (session.userRole === 'owner') return true;
  return owner !== null && canActOnTokensOf(session.userRole, owner);
}

/**
 * The tenant's account that owns tokens (a token's owner, or the `?userId=` /
 * `userId` an endpoint was asked about), or null when there is none.
 *
 * The one guarded lookup every token endpoint resolves such an account with: an
 * id the provider cannot even parse (Mongo's ObjectId constructor throws on it,
 * SQLite just finds nothing) is "no such account" on both backends.
 */
export async function findTokenOwner(
  db: Pick<DatabaseProvider, 'findUserById'>,
  userId: string,
  tenantId: string,
): Promise<IUser | null> {
  try {
    const user = await db.findUserById(userId);
    return user && String(user.tenantId) === String(tenantId) ? user : null;
  } catch (error) {
    // The id can come straight from a request, so only a bounded copy of it and
    // the error's message are logged (and under `accountId`, which would
    // otherwise shadow the acting user's `userId` on the log line).
    logger.warn('Could not look up an account by id', {
      accountId: String(userId).slice(0, 64),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Resolve the accounts behind a set of tokens once each (the caller's own is skipped). */
async function resolveOwners(
  db: Pick<DatabaseProvider, 'findUserById'>,
  session: Pick<TokenActor, 'tenantId' | 'userId'>,
  tokens: readonly Pick<IApiToken, 'userId'>[],
): Promise<Map<string, IUser | null>> {
  const ownerIds = [...new Set(tokens.map((token) => String(token.userId)))]
    .filter((id) => id !== String(session.userId));
  return new Map(
    await Promise.all(
      ownerIds.map(async (id) => [id, await findTokenOwner(db, id, session.tenantId)] as const),
    ),
  );
}

/**
 * The tokens among `tokens` that the session may manage. The owner gets them all;
 * anyone else gets the list minus the tokens of accounts `canActOnTokensOf`
 * refuses (and of accounts that cannot be resolved), so a listing built from this
 * can never show what `?userId=<that account>` would refuse. Every route that
 * lists a project's tokens goes through it.
 */
export async function filterManageableTokens(
  db: Pick<DatabaseProvider, 'findUserById'>,
  session: Pick<TokenActor, 'tenantId' | 'userId' | 'userRole'>,
  tokens: IApiToken[],
): Promise<IApiToken[]> {
  if (session.userRole === 'owner') return tokens;
  const owners = await resolveOwners(db, session, tokens);
  return tokens.filter((token) =>
    canManageToken(session, token, owners.get(String(token.userId)) ?? null),
  );
}

/** Outcome of looking up a token for deletion. */
export type ManageableToken =
  | { ok: true; token: IApiToken }
  | { ok: false; reason: 'forbidden' | 'not_found' };

/** Decide on a token that is already loaded: the owner's account is only looked up when it can matter. */
async function judgeToken(
  db: Pick<DatabaseProvider, 'findUserById'>,
  session: Pick<TokenActor, 'tenantId' | 'userId' | 'userRole'>,
  token: IApiToken,
): Promise<ManageableToken> {
  // The owner role needs no lookup, and a token of the caller's own is theirs to delete.
  const needsOwner =
    session.userRole !== 'owner' && String(token.userId) !== String(session.userId);
  const owner = needsOwner
    ? await findTokenOwner(db, String(token.userId), session.tenantId)
    : null;
  return canManageToken(session, token, owner)
    ? { ok: true, token }
    : { ok: false, reason: 'forbidden' };
}

/**
 * The token `tokenId` of the project, if it exists there and the session may
 * delete it: the token's own user always, the owner role any, anyone else under
 * the never-upward rule. The token is matched against the project's own tokens
 * first, so an id of another project, another tenant, or no token at all is
 * `not_found` without reaching the provider's delete.
 */
export async function resolveManageableProjectToken(
  db: TokenDatabase,
  session: Pick<TokenActor, 'tenantId' | 'userId' | 'userRole'>,
  projectId: string,
  tokenId: string,
): Promise<ManageableToken> {
  const projectTokens = await db.listProjectApiTokens(session.tenantId, projectId);
  const token = projectTokens.find((item) => String(item._id) === String(tokenId));
  if (!token) return { ok: false, reason: 'not_found' };
  return judgeToken(db, session, token);
}

/**
 * The token `tokenId` of the workspace (any project, or none), if it exists and the
 * session may revoke it - same rule as `resolveManageableProjectToken`, found by id
 * alone. A token of another tenant, an id no token has and an id the provider cannot
 * parse are all `not_found`.
 */
export async function resolveManageableToken(
  db: Pick<DatabaseProvider, 'findUserById' | 'findApiTokenById'>,
  session: Pick<TokenActor, 'tenantId' | 'userId' | 'userRole'>,
  tokenId: string,
): Promise<ManageableToken> {
  let token: IApiToken | null = null;
  try {
    token = await db.findApiTokenById(tokenId, session.tenantId);
  } catch (error) {
    logger.warn('Could not look up an API token by id', {
      tokenId: String(tokenId).slice(0, 64),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!token || String(token.tenantId) !== String(session.tenantId)) return { ok: false, reason: 'not_found' };
  return judgeToken(db, session, token);
}

/** Whose tokens a viewer of the directory may see (applied inside the query, so paging stays consistent). */
export type TokenVisibility =
  | { mode: 'all' }
  | { mode: 'exclude'; excludeUserIds: string[] }
  | { mode: 'own'; userIds: string[] };

/**
 * The owner role sees every token; an admin every token but the owner's; anyone
 * else - a delegate who may read the directory, a project_admin - only their own.
 */
export async function tokenVisibilityFor(
  db: Pick<DatabaseProvider, 'iamListUsers'>,
  viewer: { id: string; role: string },
  tenantId: string,
): Promise<TokenVisibility> {
  if (viewer.role === 'owner') return { mode: 'all' };
  if (viewer.role === 'admin') {
    const owners = await db.iamListUsers({ tenantId, roles: ['owner'], limit: 200 });
    return { mode: 'exclude', excludeUserIds: owners.items.map((user) => String(user._id)) };
  }
  return { mode: 'own', userIds: [String(viewer.id)] };
}
