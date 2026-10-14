/**
 * Which people and tokens to evaluate first when --max-principals cuts the list.
 *
 * Whoever the upgrade can touch comes first, so a sampled report is still the
 * informative part of the directory: members with project assignments, group
 * memberships and their own service levels before plain members; owners and
 * admins (never narrowed) last; tokens whose owner is in a group that grants
 * something first, then unscoped tokens (a scope only ever caps), then tokens
 * without a project (they run in the default project).
 */

import { grantsOfUser } from './census';
import { isPrivilegedRole, type TenantData, type TokenRow, type UserRow } from './data';

function userScore(data: TenantData, user: UserRow): number {
  if (isPrivilegedRole(user.role)) return -1;
  const rows = data.userProjects.get(user.id) ?? [];
  const withLevels = rows.filter((r) => r.servicePermissions && Object.keys(r.servicePermissions as object).length > 0).length;
  const groupIds = data.groupIdsByUser.get(user.id) ?? [];
  const groupRows = groupIds.reduce((n, id) => n + (data.groupProjects.get(id)?.length ?? 0), 0);
  const own = user.servicePermissions && Object.keys(user.servicePermissions as object).length > 0 ? 1 : 0;
  return withLevels * 4 + groupRows * 2 + groupIds.length + rows.length + own;
}

/** Stable: people with equal scores keep the order the database returned them in. */
export function orderUsersForSampling(data: TenantData): UserRow[] {
  return data.users
    .map((user, index) => ({ user, index, score: userScore(data, user) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.user);
}

function tokenScore(data: TenantData, token: TokenRow): number {
  const unscoped = token.servicePermissions == null;
  const gains = unscoped && grantsOfUser(data, token.userId).length > 0 ? 4 : 0;
  return gains + (unscoped ? 2 : 0) + (token.projectId ? 0 : 1);
}

export function orderTokensForSampling(data: TenantData): TokenRow[] {
  return data.tokens
    .map((token, index) => ({ token, index, score: tokenScore(data, token) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.token);
}
