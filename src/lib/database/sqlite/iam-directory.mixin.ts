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
  IamGroupQuery,
  IamPage,
  IamPageRequest,
  IamTokenQuery,
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
      const params: Record<string, unknown> = { tenantId: query.tenantId, lim: limit + 1, off: clampOffset(query.offset) };
      const where = ['tenantId = @tenantId'];
      if (query.q?.trim()) {
        where.push(`(iam_fold(name) LIKE iam_fold(@q) ESCAPE '\\' OR iam_fold(email) LIKE iam_fold(@q) ESCAPE '\\')`);
        params.q = likePattern(query.q.trim());
      }
      if (query.roles?.length) where.push(`role IN (${inList('role', query.roles, params)})`);
      if (query.status === 'disabled') where.push(`status = 'disabled'`);
      else if (query.status === 'active') where.push(`(status IS NULL OR status != 'disabled')`);
      if (query.ids) {
        if (query.ids.length === 0) return { items: [], hasMore: false };
        where.push(`id IN (${inList('id', query.ids, params)})`);
      }
      const rows = db
        .prepare(`SELECT * FROM ${TABLES.users} WHERE ${where.join(' AND ')} ORDER BY name ASC, id ASC LIMIT @lim OFFSET @off`)
        .all(params) as SqliteRow[];
      return this.iamPage(rows, limit, (row) => ({ ...this.iamMap().mapUserRow(row), password: '' }));
    }

    async iamListGroups(query: IamGroupQuery): Promise<IamPage<IGroup>> {
      const db = this.getTenantDb();
      const limit = clampLimit(query.limit);
      const params: Record<string, unknown> = { tenantId: query.tenantId, lim: limit + 1, off: clampOffset(query.offset) };
      const where = ['tenantId = @tenantId'];
      if (query.q?.trim()) {
        where.push(`(iam_fold(name) LIKE iam_fold(@q) ESCAPE '\\' OR iam_fold(description) LIKE iam_fold(@q) ESCAPE '\\')`);
        params.q = likePattern(query.q.trim());
      }
      if (query.ids) {
        if (query.ids.length === 0) return { items: [], hasMore: false };
        where.push(`id IN (${inList('id', query.ids, params)})`);
      }
      const rows = db
        .prepare(`SELECT * FROM ${TABLES.groups} WHERE ${where.join(' AND ')} ORDER BY name ASC, id ASC LIMIT @lim OFFSET @off`)
        .all(params) as SqliteRow[];
      return this.iamPage(rows, limit, (row) => this.iamMap().mapGroupRow(row));
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
      const params: Record<string, unknown> = { tenantId: query.tenantId, lim: limit + 1, off: clampOffset(query.offset) };
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
        if (query.ids.length === 0) return { items: [], hasMore: false };
        where.push(`id IN (${inList('id', query.ids, params)})`);
      }
      const rows = db
        .prepare(`SELECT * FROM ${TABLES.apiTokens} WHERE ${where.join(' AND ')} ORDER BY createdAt DESC, id DESC LIMIT @lim OFFSET @off`)
        .all(params) as SqliteRow[];
      return this.iamPage(rows, limit, (row) => {
        const token = this.iamMap().mapTokenRow(row);
        // Display only: neither the legacy plaintext token nor the hash leave the database layer.
        return { ...token, token: undefined, tokenHash: undefined };
      });
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
