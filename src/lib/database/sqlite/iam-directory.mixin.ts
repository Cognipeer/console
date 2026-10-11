/**
 * SQLite Provider - IAM directory queries mixin.
 *
 * Read-only, offset-paged listings the Authorization center needs to browse a
 * large organisation (users, groups, API tokens, audit rows) without loading it
 * all. Purely additive: no new table, column or index, so nothing changes for an
 * existing database. Mirror of mongodb/iam-directory.mixin.ts - both must stay
 * behaviourally identical (tests/integration/iam-directory.test.ts runs the same
 * contract against both).
 *
 * Ordering is by plain binary comparison of the name (then id) on both backends,
 * so a page boundary lands on the same row everywhere.
 */

import type {
  IApiToken,
  IAuditLog,
  IGroup,
  IUser,
  IamAuditQuery,
  IamGroupFilter,
  IamGroupQuery,
  IamPage,
  IamPageRequest,
  IamTokenFilter,
  IamTokenQuery,
  IamUserFilter,
  IamUserQuery,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

const MAX_PAGE = 200;
const MAX_IDS = 500;
/** A group's members as an audit actor filter. */
const MAX_ACTOR_IDS = 5_000;
const META_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const clampLimit = (n: number | undefined): number => Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(n)) || 50));
const clampOffset = (n: number | undefined): number => Math.max(0, Math.min(10_000_000, Math.floor(Number(n)) || 0));
const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** `@p0, @p1, ...` placeholders plus their bound values. */
function inList(prefix: string, values: readonly string[], params: Record<string, unknown>, max: number = MAX_IDS): string {
  return values
    .slice(0, max)
    .map((value, i) => {
      params[`${prefix}${i}`] = value;
      return `@${prefix}${i}`;
    })
    .join(', ');
}


// ── filters (shared by the listings and the counts) ────────────────────────
// Each returns the WHERE conditions, or null when the filter can match nothing
// (an empty id list), so the caller skips the query.

function userFilter(query: IamUserFilter, params: Record<string, unknown>): string[] | null {
  params.tenantId = query.tenantId;
  const where = ['tenantId = @tenantId'];
  if (query.q?.trim()) {
    where.push(`(iam_fold(name) LIKE iam_fold(@q) ESCAPE '\\' OR iam_fold(email) LIKE iam_fold(@q) ESCAPE '\\')`);
    params.q = likePattern(query.q.trim());
  }
  if (query.roles?.length) where.push(`role IN (${inList('role', query.roles, params)})`);
  if (query.status === 'disabled') where.push(`status = 'disabled'`);
  else if (query.status === 'active') where.push(`(status IS NULL OR status != 'disabled')`);
  if (query.ids) {
    if (query.ids.length === 0) return null;
    where.push(`id IN (${inList('id', query.ids, params)})`);
  }
  if (query.excludeIds?.length) where.push(`id NOT IN (${inList('xid', query.excludeIds, params)})`);
  // A row without the flag can sign in.
  if (query.canLogin === true) where.push('(canLogin IS NULL OR canLogin != 0)');
  else if (query.canLogin === false) where.push('canLogin = 0');
  // An account without a kind is a member.
  if (query.external === true) where.push(`kind = 'external'`);
  else if (query.external === false) where.push(`(kind IS NULL OR kind != 'external')`);
  if (query.authProviders?.length) {
    const parts: string[] = [];
    const named = query.authProviders.filter((provider) => provider !== 'local');
    if (query.authProviders.includes('local')) parts.push(`(authProvider IS NULL OR authProvider = '' OR authProvider = 'local')`);
    if (named.length > 0) parts.push(`authProvider IN (${inList('provider', named, params)})`);
    where.push(`(${parts.join(' OR ')})`);
  }
  if (query.invited !== undefined) {
    const pending = `((canLogin IS NULL OR canLogin != 0) AND (status IS NULL OR status != 'disabled') AND invitedBy IS NOT NULL AND invitedBy != '' AND inviteAcceptedAt IS NULL)`;
    where.push(query.invited ? pending : `NOT ${pending}`);
  }
  if (query.groupId) {
    params.memberGroupId = query.groupId;
    where.push(`id IN (SELECT userId FROM ${TABLES.groupMembers} WHERE tenantId = @tenantId AND groupId = @memberGroupId)`);
  }
  if (query.projectId) {
    params.memberProjectId = query.projectId;
    // The legacy list is a JSON array of ids: match the quoted id, which cannot match a longer one.
    params.legacyProjectNeedle = `"${query.projectId}"`;
    where.push(`(
      id IN (SELECT userId FROM ${TABLES.userProjects} WHERE tenantId = @tenantId AND projectId = @memberProjectId)
      OR id IN (SELECT userId FROM ${TABLES.groupMembers} WHERE tenantId = @tenantId AND groupId IN (
        SELECT groupId FROM ${TABLES.groupProjects} WHERE tenantId = @tenantId AND projectId = @memberProjectId))
      OR instr(COALESCE(projectIds, ''), @legacyProjectNeedle) > 0
    )`);
  }
  return where;
}

function groupFilter(query: IamGroupFilter, params: Record<string, unknown>): string[] | null {
  params.tenantId = query.tenantId;
  const where = ['tenantId = @tenantId'];
  if (query.q?.trim()) {
    where.push(`(iam_fold(name) LIKE iam_fold(@q) ESCAPE '\\' OR iam_fold(description) LIKE iam_fold(@q) ESCAPE '\\')`);
    params.q = likePattern(query.q.trim());
  }
  if (query.ids) {
    if (query.ids.length === 0) return null;
    where.push(`id IN (${inList('id', query.ids, params)})`);
  }
  if (query.sources?.length) {
    const parts: string[] = [];
    const named = query.sources.filter((source) => source !== 'local');
    if (query.sources.includes('local')) parts.push(`(source IS NULL OR source = '' OR source = 'local')`);
    if (named.length > 0) parts.push(`source IN (${inList('source', named, params)})`);
    where.push(`(${parts.join(' OR ')})`);
  }
  if (query.projectId) {
    params.assignedProjectId = query.projectId;
    where.push(`id IN (SELECT groupId FROM ${TABLES.groupProjects} WHERE tenantId = @tenantId AND projectId = @assignedProjectId)`);
  }
  return where;
}

function tokenFilter(query: IamTokenFilter, params: Record<string, unknown>): string[] | null {
  params.tenantId = query.tenantId;
  const where = ['tenantId = @tenantId'];
  if (query.userId) {
    where.push('userId = @userId');
    params.userId = query.userId;
  }
  if (query.projectId) {
    where.push('projectId = @projectId');
    params.projectId = query.projectId;
  }
  if (query.q?.trim()) {
    where.push(`(iam_fold(label) LIKE iam_fold(@q) ESCAPE '\\' OR iam_fold(tokenPrefix) LIKE iam_fold(@q) ESCAPE '\\')`);
    params.q = likePattern(query.q.trim());
  }
  if (query.ids) {
    if (query.ids.length === 0) return null;
    where.push(`id IN (${inList('id', query.ids, params)})`);
  }
  if (query.status) {
    params.now = (query.now ?? new Date()).toISOString();
    where.push(query.status === 'expired'
      ? '(expiresAt IS NOT NULL AND expiresAt <= @now)'
      : '(expiresAt IS NULL OR expiresAt > @now)');
  }
  if (query.scoped !== undefined) where.push(query.scoped ? 'servicePermissions IS NOT NULL' : 'servicePermissions IS NULL');
  if (query.userIds) {
    if (query.userIds.length === 0) return null;
    where.push(`userId IN (${inList('owner', query.userIds, params)})`);
  }
  if (query.excludeUserIds?.length) where.push(`userId NOT IN (${inList('xowner', query.excludeUserIds, params)})`);
  return where;
}

/** Sort columns by their public name; the id breaks ties so a page boundary lands on the same row every time. */
const USER_SORT_COLUMN = { name: 'name', email: 'emailLower', createdAt: 'createdAt' } as const;

interface Mappers {
  mapUserRow(row: SqliteRow): IUser;
  mapGroupRow(row: SqliteRow): IGroup;
  mapTokenRow(row: SqliteRow): IApiToken;
  mapAuditLogRow(row: SqliteRow): IAuditLog;
}

export function IamDirectoryMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class IamDirectoryOps extends Base {
    /** The row mappers live in the identity / token / audit mixins this one is composed after. */
    private iamMap(): Mappers {
      return this as unknown as Mappers;
    }

    private iamPage<T>(rows: SqliteRow[], limit: number, map: (row: SqliteRow) => T): IamPage<T> {
      return { items: rows.slice(0, limit).map(map), hasMore: rows.length > limit };
    }

    async iamListUsers(query: IamUserQuery): Promise<IamPage<IUser>> {
      const db = this.getTenantDb();
      const limit = clampLimit(query.limit);
      const params: Record<string, unknown> = { lim: limit + 1, off: clampOffset(query.offset) };
      const where = userFilter(query, params);
      if (!where) return { items: [], hasMore: false };
      const column = USER_SORT_COLUMN[query.sort ?? 'name'] ?? USER_SORT_COLUMN.name;
      const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
      const rows = db
        .prepare(`SELECT * FROM ${TABLES.users} WHERE ${where.join(' AND ')} ORDER BY ${column} ${dir}, id ${dir} LIMIT @lim OFFSET @off`)
        .all(params) as SqliteRow[];
      return this.iamPage(rows, limit, (row) => ({ ...this.iamMap().mapUserRow(row), password: '' }));
    }

    async iamCountUsers(filter: IamUserFilter): Promise<number> {
      const params: Record<string, unknown> = {};
      const where = userFilter(filter, params);
      if (!where) return 0;
      const row = this.getTenantDb()
        .prepare(`SELECT COUNT(*) AS c FROM ${TABLES.users} WHERE ${where.join(' AND ')}`)
        .get(params) as SqliteRow | undefined;
      return Number(row?.c) || 0;
    }

    async iamListGroups(query: IamGroupQuery): Promise<IamPage<IGroup>> {
      const db = this.getTenantDb();
      const limit = clampLimit(query.limit);
      const params: Record<string, unknown> = { lim: limit + 1, off: clampOffset(query.offset) };
      const where = groupFilter(query, params);
      if (!where) return { items: [], hasMore: false };
      const rows = db
        .prepare(`SELECT * FROM ${TABLES.groups} WHERE ${where.join(' AND ')} ORDER BY name ASC, id ASC LIMIT @lim OFFSET @off`)
        .all(params) as SqliteRow[];
      return this.iamPage(rows, limit, (row) => this.iamMap().mapGroupRow(row));
    }

    async iamCountGroups(filter: IamGroupFilter): Promise<number> {
      const params: Record<string, unknown> = {};
      const where = groupFilter(filter, params);
      if (!where) return 0;
      const row = this.getTenantDb()
        .prepare(`SELECT COUNT(*) AS c FROM ${TABLES.groups} WHERE ${where.join(' AND ')}`)
        .get(params) as SqliteRow | undefined;
      return Number(row?.c) || 0;
    }

    async iamCountGroupMembers(groupIds: string[]): Promise<Record<string, number>> {
      const out: Record<string, number> = Object.fromEntries(groupIds.map((id) => [id, 0]));
      if (groupIds.length === 0) return out;
      const db = this.getTenantDb();
      for (let i = 0; i < groupIds.length; i += MAX_IDS) {
        const params: Record<string, unknown> = {};
        const list = inList('g', groupIds.slice(i, i + MAX_IDS), params);
        const rows = db
          .prepare(`SELECT groupId, COUNT(*) AS c FROM ${TABLES.groupMembers} WHERE groupId IN (${list}) GROUP BY groupId`)
          .all(params) as SqliteRow[];
        for (const row of rows) out[String(row.groupId)] = Number(row.c) || 0;
      }
      return out;
    }

    async iamListGroupMemberIds(groupId: string, page: IamPageRequest): Promise<IamPage<string>> {
      const db = this.getTenantDb();
      const limit = clampLimit(page.limit);
      const rows = db
        .prepare(`SELECT userId FROM ${TABLES.groupMembers} WHERE groupId = @groupId ORDER BY userId ASC LIMIT @lim OFFSET @off`)
        .all({ groupId, lim: limit + 1, off: clampOffset(page.offset) }) as SqliteRow[];
      return this.iamPage(rows, limit, (row) => String(row.userId));
    }

    async iamListTokens(query: IamTokenQuery): Promise<IamPage<IApiToken>> {
      // API tokens live in the shared control-plane database, keyed by tenant.
      const db = this.getMainDb();
      const limit = clampLimit(query.limit);
      const params: Record<string, unknown> = { lim: limit + 1, off: clampOffset(query.offset) };
      const where = tokenFilter(query, params);
      if (!where) return { items: [], hasMore: false };
      const rows = db
        .prepare(`SELECT * FROM ${TABLES.apiTokens} WHERE ${where.join(' AND ')} ORDER BY createdAt DESC, id DESC LIMIT @lim OFFSET @off`)
        .all(params) as SqliteRow[];
      return this.iamPage(rows, limit, (row) => {
        const token = this.iamMap().mapTokenRow(row);
        // Display only: neither the legacy plaintext token nor the hash leave the database layer.
        return { ...token, token: undefined, tokenHash: undefined };
      });
    }

    async iamCountTokens(filter: IamTokenFilter): Promise<number> {
      const params: Record<string, unknown> = {};
      const where = tokenFilter(filter, params);
      if (!where) return 0;
      const row = this.getMainDb()
        .prepare(`SELECT COUNT(*) AS c FROM ${TABLES.apiTokens} WHERE ${where.join(' AND ')}`)
        .get(params) as SqliteRow | undefined;
      return Number(row?.c) || 0;
    }

    async iamListAuditEvents(query: IamAuditQuery): Promise<IamPage<IAuditLog>> {
      const db = this.getTenantDb();
      const limit = clampLimit(query.limit);
      const params: Record<string, unknown> = { tenantId: query.tenantId, lim: limit + 1, off: clampOffset(query.offset) };
      const where = ['tenantId = @tenantId'];
      if (query.from) {
        where.push('createdAt >= @from');
        params.from = query.from.toISOString();
      }
      if (query.to) {
        where.push('createdAt <= @to');
        params.to = query.to.toISOString();
      }
      // (service AND resourceType IN ...) OR event IN ...: the scope of "IAM changes" plus a few
      // events that live in another service (a token's expiry / allowlist edit).
      const scope: string[] = [];
      if (query.service) {
        scope.push('service = @service');
        params.service = query.service;
      }
      if (query.resourceTypes) {
        if (query.resourceTypes.length === 0 && !query.alsoEvents?.length) return { items: [], hasMore: false };
        scope.push(`resourceType IN (${query.resourceTypes.length ? inList('rt', query.resourceTypes, params) : 'NULL'})`);
      }
      if (query.alsoEvents?.length) {
        where.push(`((${scope.join(' AND ') || '1 = 1'}) OR event IN (${inList('ev', query.alsoEvents, params)}))`);
      } else {
        where.push(...scope);
      }
      if (query.outcome) {
        where.push('outcome = @outcome');
        params.outcome = query.outcome;
      }
      if (query.actorUserId) {
        where.push('actorUserId = @actorUserId');
        params.actorUserId = query.actorUserId;
      }
      if (query.actorUserIds) {
        if (query.actorUserIds.length === 0) return { items: [], hasMore: false };
        where.push(`actorUserId IN (${inList('actor', query.actorUserIds, params, MAX_ACTOR_IDS)})`);
      }
      if (query.apiTokenId) {
        where.push('apiTokenId = @apiTokenId');
        params.apiTokenId = query.apiTokenId;
      }
      if (query.metadata) {
        if (!META_KEY_RE.test(query.metadata.key)) throw new Error(`Invalid metadata key "${query.metadata.key}"`);
        where.push(`json_extract(metadata, @metaPath) = @metaValue`);
        params.metaPath = `$.${query.metadata.key}`;
        const v = query.metadata.value;
        params.metaValue = typeof v === 'boolean' ? (v ? 1 : 0) : v;
      }
      const rows = db
        .prepare(`SELECT * FROM ${TABLES.auditLogs} WHERE ${where.join(' AND ')} ORDER BY createdAt DESC, id DESC LIMIT @lim OFFSET @off`)
        .all(params) as SqliteRow[];
      return this.iamPage(rows, limit, (row) => this.iamMap().mapAuditLogRow(row));
    }
  };
}
