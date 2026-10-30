/**
 * SQLite Provider – Knowledge Engine access control mixin
 *
 * Folders, permission entries and external identity directories. Mirrors
 * `mongodb/rag-access.mixin.ts`; the two answer alike (db-parity.test.ts).
 *
 * Lists that come from a caller (principals, ids, node ids) travel as ONE JSON
 * parameter and are read with `json_each(@x)`, so an access scope carrying
 * thousands of ids never meets SQLite's bound-variable limit. An empty list
 * matches nothing.
 *
 * Project scope follows the documents (`buildProjectScopeFilter`): a project id
 * narrows the read to that project, an undefined one does not narrow at all.
 */

import type {
  IRagAclEntry,
  IRagFolder,
  IRagIdentityDomain,
  IRagIdentityLink,
  IRagIdentityUser,
  RagAclNodeType,
} from '../provider/types.domain';
import {
  clampRagAclLabelsLimit,
  clampRagIdentityPage,
  dedupeAclEntries,
  distinctNonEmptyStrings,
  prepareRagIdentityUsers,
  ragAclPrincipalPrefix,
  resolveRagIdentityLookup,
} from '../provider/ragAccess';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

/** One JSON array as a single bound parameter. */
const jsonList = (values: readonly string[]): string => JSON.stringify(values);

export function RagAccessMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class RagAccessOps extends Base {
    // ── Folders ──────────────────────────────────────────────────────

    async createRagFolder(
      folder: Omit<IRagFolder, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRagFolder> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.ragFolders}
        (id, tenantId, projectId, ragModuleKey, parentId, name, ancestorIds, aclMode, aclManaged,
         source, sourceId, sourceExternalId, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @ragModuleKey, @parentId, @name, @ancestorIds, @aclMode, @aclManaged,
         @source, @sourceId, @sourceExternalId, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: folder.tenantId,
        projectId: folder.projectId ?? null,
        ragModuleKey: folder.ragModuleKey,
        parentId: folder.parentId ?? null,
        name: folder.name,
        ancestorIds: folder.ancestorIds ? this.toJson(folder.ancestorIds) : null,
        aclMode: folder.aclMode ?? null,
        aclManaged: folder.aclManaged ?? null,
        source: folder.source ? this.toJson(folder.source) : null,
        sourceId: folder.source?.sourceId ?? null,
        sourceExternalId: folder.source?.externalId ?? null,
        createdBy: folder.createdBy,
        updatedBy: folder.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...folder, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateRagFolder(
      id: string,
      data: Partial<Pick<IRagFolder, 'name' | 'parentId' | 'ancestorIds' | 'aclMode' | 'aclManaged' | 'source' | 'updatedBy'>>,
    ): Promise<IRagFolder | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      // Presence, not value: an explicit `undefined` clears the field (a folder
      // moved to the top level, handed back to "inherit", detached from a source).
      if (Object.hasOwn(data, 'parentId')) { sets.push('parentId = @parentId'); params.parentId = data.parentId ?? null; }
      if (Object.hasOwn(data, 'ancestorIds')) {
        sets.push('ancestorIds = @ancestorIds');
        params.ancestorIds = data.ancestorIds ? this.toJson(data.ancestorIds) : null;
      }
      if (Object.hasOwn(data, 'aclMode')) { sets.push('aclMode = @aclMode'); params.aclMode = data.aclMode ?? null; }
      if (Object.hasOwn(data, 'aclManaged')) { sets.push('aclManaged = @aclManaged'); params.aclManaged = data.aclManaged ?? null; }
      if (Object.hasOwn(data, 'source')) {
        sets.push('source = @source', 'sourceId = @sourceId', 'sourceExternalId = @sourceExternalId');
        params.source = data.source ? this.toJson(data.source) : null;
        params.sourceId = data.source?.sourceId ?? null;
        params.sourceExternalId = data.source?.externalId ?? null;
      }

      db.prepare(`UPDATE ${TABLES.ragFolders} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findRagFolderById(id);
    }

    async findRagFolderById(id: string): Promise<IRagFolder | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.ragFolders} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapRagFolderRow(row) : null;
    }

    async findRagFolderBySource(
      ragModuleKey: string,
      sourceId: string,
      externalId: string,
      projectId?: string,
    ): Promise<IRagFolder | null> {
      const db = this.getTenantDb();
      const clauses: string[] = ['ragModuleKey = @ragModuleKey', 'sourceId = @sourceId', 'sourceExternalId = @externalId'];
      const params: Record<string, unknown> = { ragModuleKey, sourceId, externalId };
      if (projectId !== undefined) {
        const scopeFilter = this.buildProjectScopeFilter(projectId);
        clauses.push(scopeFilter.clause);
        Object.assign(params, scopeFilter.params);
      }
      const row = db.prepare(
        `SELECT * FROM ${TABLES.ragFolders} WHERE ${clauses.join(' AND ')} ORDER BY createdAt ASC, rowid ASC LIMIT 1`,
      ).get(params) as SqliteRow | undefined;
      return row ? this.mapRagFolderRow(row) : null;
    }

    async listRagFolders(
      ragModuleKey: string,
      filters?: { projectId?: string; parentId?: string | null; ancestorId?: string; ids?: string[]; sourceId?: string },
    ): Promise<IRagFolder[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['ragModuleKey = @ragModuleKey'];
      const params: Record<string, unknown> = { ragModuleKey };

      if (filters?.projectId !== undefined) {
        const scopeFilter = this.buildProjectScopeFilter(filters.projectId);
        clauses.push(scopeFilter.clause);
        Object.assign(params, scopeFilter.params);
      }
      if (filters?.parentId === null || filters?.parentId === '') {
        clauses.push("(parentId IS NULL OR parentId = '')");
      } else if (typeof filters?.parentId === 'string') {
        clauses.push('parentId = @parentId');
        params.parentId = filters.parentId;
      }
      if (filters?.ancestorId) {
        // json_each(NULL) has no rows, so a top-level folder (no ancestors) never matches.
        clauses.push(`EXISTS (SELECT 1 FROM json_each(${TABLES.ragFolders}.ancestorIds) WHERE json_each.value = @ancestorId)`);
        params.ancestorId = filters.ancestorId;
      }
      if (filters?.ids !== undefined) {
        const ids = distinctNonEmptyStrings(filters.ids);
        if (ids.length === 0) return [];
        clauses.push('id IN (SELECT value FROM json_each(@ids))');
        params.ids = jsonList(ids);
      }
      if (filters?.sourceId) { clauses.push('sourceId = @sourceId'); params.sourceId = filters.sourceId; }

      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragFolders} WHERE ${clauses.join(' AND ')} ORDER BY name ASC, id ASC`,
      ).all(params) as SqliteRow[];
      return rows.map((row) => this.mapRagFolderRow(row));
    }

    /** Deletes the folder and the permission entries that sat on it. */
    async deleteRagFolder(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const run = db.transaction((folderId: string) => {
        const row = db.prepare(`SELECT ragModuleKey FROM ${TABLES.ragFolders} WHERE id = @id`).get({ id: folderId }) as
          | { ragModuleKey: string }
          | undefined;
        if (!row) return false;
        db.prepare(
          `DELETE FROM ${TABLES.ragAclEntries} WHERE ragModuleKey = @ragModuleKey AND nodeType = 'folder' AND nodeId = @id`,
        ).run({ ragModuleKey: row.ragModuleKey, id: folderId });
        return db.prepare(`DELETE FROM ${TABLES.ragFolders} WHERE id = @id`).run({ id: folderId }).changes > 0;
      });
      return run(id);
    }

    async deleteRagFoldersByModuleKey(ragModuleKey: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const { clauses, params } = this.ragModuleScope(ragModuleKey, projectId);
      return db.prepare(`DELETE FROM ${TABLES.ragFolders} WHERE ${clauses.join(' AND ')}`).run(params).changes;
    }

    // ── Permission entries ───────────────────────────────────────────

    /** Oldest entry first (the order they were granted in). */
    async listRagAclEntries(
      ragModuleKey: string,
      filters?: {
        projectId?: string;
        nodeType?: IRagAclEntry['nodeType'];
        nodeId?: string;
        nodeIds?: string[];
        principals?: string[];
      },
    ): Promise<IRagAclEntry[]> {
      const db = this.getTenantDb();
      const { clauses, params } = this.ragModuleScope(ragModuleKey, filters?.projectId);

      if (filters?.nodeType) { clauses.push('nodeType = @nodeType'); params.nodeType = filters.nodeType; }
      if (filters?.nodeId !== undefined) { clauses.push('nodeId = @nodeId'); params.nodeId = filters.nodeId; }
      if (filters?.nodeIds !== undefined) {
        const nodeIds = distinctNonEmptyStrings(filters.nodeIds);
        if (nodeIds.length === 0) return [];
        clauses.push('nodeId IN (SELECT value FROM json_each(@nodeIds))');
        params.nodeIds = jsonList(nodeIds);
      }
      if (filters?.principals !== undefined) {
        const principals = distinctNonEmptyStrings(filters.principals);
        if (principals.length === 0) return [];
        clauses.push('principal IN (SELECT value FROM json_each(@principals))');
        params.principals = jsonList(principals);
      }

      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragAclEntries} WHERE ${clauses.join(' AND ')} ORDER BY createdAt ASC, rowid ASC`,
      ).all(params) as SqliteRow[];
      return rows.map((row) => this.mapRagAclEntryRow(row));
    }

    async listRagAclNodesForPrincipals(
      ragModuleKey: string,
      principals: string[],
      projectId?: string,
    ): Promise<Array<{ nodeType: IRagAclEntry['nodeType']; nodeId: string }>> {
      const wanted = distinctNonEmptyStrings(principals);
      if (wanted.length === 0) return [];
      const db = this.getTenantDb();
      const { clauses, params } = this.ragModuleScope(ragModuleKey, projectId);
      clauses.push('principal IN (SELECT value FROM json_each(@principals))');
      params.principals = jsonList(wanted);
      const rows = db.prepare(
        `SELECT DISTINCT nodeType, nodeId FROM ${TABLES.ragAclEntries} WHERE ${clauses.join(' AND ')} ORDER BY nodeType ASC, nodeId ASC`,
      ).all(params) as Array<{ nodeType: string; nodeId: string }>;
      return rows.map((row) => ({ nodeType: row.nodeType as IRagAclEntry['nodeType'], nodeId: String(row.nodeId) }));
    }

    async hasRagAclEntries(
      ragModuleKey: string,
      nodeType: IRagAclEntry['nodeType'],
      nodeId: string,
      projectId?: string,
    ): Promise<boolean> {
      const db = this.getTenantDb();
      const { clauses, params } = this.ragModuleScope(ragModuleKey, projectId);
      clauses.push('nodeType = @nodeType', 'nodeId = @nodeId');
      params.nodeType = nodeType;
      params.nodeId = nodeId;
      const row = db.prepare(
        `SELECT 1 AS present FROM ${TABLES.ragAclEntries} WHERE ${clauses.join(' AND ')} LIMIT 1`,
      ).get(params);
      return row !== undefined;
    }

    /** Node id -> its number of entries; a node with none is not in the record. */
    async countRagAclEntriesByNode(
      ragModuleKey: string,
      filter: { projectId?: string; nodeType: RagAclNodeType; nodeIds: string[] },
    ): Promise<Record<string, number>> {
      const nodeIds = distinctNonEmptyStrings(filter.nodeIds);
      if (nodeIds.length === 0) return {};
      const db = this.getTenantDb();
      const { clauses, params } = this.ragModuleScope(ragModuleKey, filter.projectId);
      clauses.push('nodeType = @nodeType', 'nodeId IN (SELECT value FROM json_each(@nodeIds))');
      params.nodeType = filter.nodeType;
      params.nodeIds = jsonList(nodeIds);
      const rows = db.prepare(
        `SELECT nodeId, COUNT(*) AS cnt FROM ${TABLES.ragAclEntries} WHERE ${clauses.join(' AND ')} GROUP BY nodeId`,
      ).all(params) as Array<{ nodeId: string; cnt: number }>;
      return Object.fromEntries(rows.map((row) => [String(row.nodeId), Number(row.cnt)]));
    }

    /**
     * Distinct nodes of one type with at least one entry. The prefix is compared
     * as it is (`substr`, not LIKE: `%` and `_` are no wildcards, the case counts),
     * like `deleteRagAclEntriesByPrincipalPrefix`; one that no principal can start
     * with matches nothing.
     */
    async countRagAclNodes(
      ragModuleKey: string,
      filter: { projectId?: string; nodeType: RagAclNodeType; principalPrefix?: string },
    ): Promise<number> {
      const db = this.getTenantDb();
      const { clauses, params } = this.ragModuleScope(ragModuleKey, filter.projectId);
      clauses.push('nodeType = @nodeType');
      params.nodeType = filter.nodeType;
      if (filter.principalPrefix !== undefined) {
        const literal = ragAclPrincipalPrefix(filter.principalPrefix);
        if (literal === null) return 0;
        clauses.push('substr(principal, 1, length(@prefix)) = @prefix');
        params.prefix = literal;
      }
      const row = db.prepare(
        `SELECT COUNT(DISTINCT nodeId) AS cnt FROM ${TABLES.ragAclEntries} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as { cnt: number };
      return Number(row.cnt) || 0;
    }

    /**
     * One transaction: the node's entries are removed and the new ones written,
     * so no reader sees the node without its permissions in between (an empty
     * module root reads as "everyone"). A principal listed twice is written once.
     */
    async replaceRagAclEntries(
      ragModuleKey: string,
      node: { type: IRagAclEntry['nodeType']; id: string },
      entries: Array<Omit<IRagAclEntry, '_id' | 'ragModuleKey' | 'nodeType' | 'nodeId' | 'createdAt'>>,
      projectId?: string,
    ): Promise<void> {
      const db = this.getTenantDb();
      const now = this.now();
      const unique = dedupeAclEntries(entries);
      const { clauses, params } = this.ragModuleScope(ragModuleKey, projectId);
      clauses.push('nodeType = @nodeType', 'nodeId = @nodeId');
      params.nodeType = node.type;
      params.nodeId = node.id;

      const remove = db.prepare(`DELETE FROM ${TABLES.ragAclEntries} WHERE ${clauses.join(' AND ')}`);
      const insert = db.prepare(`
        INSERT INTO ${TABLES.ragAclEntries}
        (id, tenantId, projectId, ragModuleKey, nodeType, nodeId, principal, label, managed, createdBy, createdAt)
        VALUES (@id, @tenantId, @projectId, @ragModuleKey, @nodeType, @nodeId, @principal, @label, @managed, @createdBy, @createdAt)
      `);
      db.transaction(() => {
        remove.run(params);
        for (const entry of unique) {
          const entryProject = entry.projectId ?? projectId;
          insert.run({
            id: this.newId(),
            tenantId: entry.tenantId,
            projectId: entryProject ? entryProject : null,
            ragModuleKey,
            nodeType: node.type,
            nodeId: node.id,
            principal: entry.principal,
            label: entry.label ?? null,
            managed: entry.managed ?? null,
            createdBy: entry.createdBy ?? null,
            createdAt: now,
          });
        }
      })();
    }

    async deleteRagAclEntriesByModuleKey(ragModuleKey: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const { clauses, params } = this.ragModuleScope(ragModuleKey, projectId);
      return db.prepare(`DELETE FROM ${TABLES.ragAclEntries} WHERE ${clauses.join(' AND ')}`).run(params).changes;
    }

    /**
     * Every module and project of the tenant. The leading characters are compared
     * as they are, not matched with LIKE: LIKE reads `%` and `_` in the prefix as
     * wildcards and folds the case of ASCII letters, MongoDB's anchored, escaped
     * regular expression does neither.
     */
    async deleteRagAclEntriesByPrincipalPrefix(prefix: string): Promise<number> {
      const literal = ragAclPrincipalPrefix(prefix);
      if (literal === null) return 0;
      const db = this.getTenantDb();
      return db.prepare(
        `DELETE FROM ${TABLES.ragAclEntries} WHERE substr(principal, 1, length(@prefix)) = @prefix`,
      ).run({ prefix: literal }).changes;
    }

    /**
     * Every module and project of the tenant, the prefix read literally like the
     * delete above. One label per principal (`MAX`, so the same one every time
     * when entries disagree), ordered by principal; entries without a label say
     * nothing.
     */
    async listRagAclPrincipalLabels(
      principalPrefix: string,
      options?: { limit?: number },
    ): Promise<Array<{ principal: string; label: string }>> {
      const literal = ragAclPrincipalPrefix(principalPrefix);
      const limit = clampRagAclLabelsLimit(options);
      if (literal === null || limit === 0) return [];
      const db = this.getTenantDb();
      const rows = db.prepare(`
        SELECT principal, COALESCE(MAX(CASE WHEN managed = 'sync' THEN label END), MAX(label)) AS label FROM ${TABLES.ragAclEntries}
        WHERE substr(principal, 1, length(@prefix)) = @prefix AND label IS NOT NULL AND label <> ''
        GROUP BY principal ORDER BY principal ASC LIMIT @limit
      `).all({ prefix: literal, limit }) as Array<{ principal: string; label: string }>;
      return rows.map((row) => ({ principal: String(row.principal), label: String(row.label) }));
    }

    // ── Identity domains ─────────────────────────────────────────────

    /**
     * By unique `key`. An existing domain keeps its id, `createdAt` and
     * `createdBy`; every other field is replaced by the one given (an optional
     * field left out is cleared) except `updatedBy`, which stays when none is given.
     */
    async upsertRagIdentityDomain(
      domain: Omit<IRagIdentityDomain, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRagIdentityDomain> {
      const db = this.getTenantDb();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.ragIdentityDomains}
        (id, tenantId, key, kind, label, source, userMatch, matchGroupsByExternalId, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @key, @kind, @label, @source, @userMatch, @matchGroupsByExternalId, @createdBy, @updatedBy, @createdAt, @updatedAt)
        ON CONFLICT(key) DO UPDATE SET
          kind = excluded.kind,
          label = excluded.label,
          source = excluded.source,
          userMatch = excluded.userMatch,
          matchGroupsByExternalId = excluded.matchGroupsByExternalId,
          updatedBy = COALESCE(excluded.updatedBy, updatedBy),
          updatedAt = excluded.updatedAt
      `).run({
        id: this.newId(),
        tenantId: domain.tenantId,
        key: domain.key,
        kind: domain.kind,
        label: domain.label,
        source: domain.source ? this.toJson(domain.source) : null,
        userMatch: this.toJson(domain.userMatch ?? []),
        matchGroupsByExternalId:
          domain.matchGroupsByExternalId === undefined ? null : this.toBoolInt(domain.matchGroupsByExternalId),
        createdBy: domain.createdBy ?? null,
        updatedBy: domain.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      const saved = await this.findRagIdentityDomain(domain.key);
      return saved as IRagIdentityDomain;
    }

    async findRagIdentityDomain(key: string): Promise<IRagIdentityDomain | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.ragIdentityDomains} WHERE key = @key`).get({ key }) as
        | SqliteRow
        | undefined;
      return row ? this.mapRagIdentityDomainRow(row) : null;
    }

    async listRagIdentityDomains(): Promise<IRagIdentityDomain[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.ragIdentityDomains} ORDER BY key ASC`).all() as SqliteRow[];
      return rows.map((row) => this.mapRagIdentityDomainRow(row));
    }

    /** Deletes the domain together with its directory users and its links. */
    async deleteRagIdentityDomain(key: string): Promise<boolean> {
      const db = this.getTenantDb();
      const run = db.transaction((domainKey: string) => {
        db.prepare(`DELETE FROM ${TABLES.ragIdentityUsers} WHERE domain = @key`).run({ key: domainKey });
        db.prepare(`DELETE FROM ${TABLES.ragIdentityLinks} WHERE domain = @key`).run({ key: domainKey });
        return db.prepare(`DELETE FROM ${TABLES.ragIdentityDomains} WHERE key = @key`).run({ key: domainKey }).changes > 0;
      });
      return run(key);
    }

    // ── Identity directory users ─────────────────────────────────────

    /**
     * Insert or replace by (domain, extId), in one transaction. `email`, `upn`
     * and attribute values are stored lower-cased; a user given twice is written
     * once (the last one). Returns how many users were written.
     */
    async upsertRagIdentityUsers(
      domain: string,
      users: Array<Omit<IRagIdentityUser, '_id' | 'domain'>>,
    ): Promise<number> {
      const prepared = prepareRagIdentityUsers(users, new Date());
      if (prepared.length === 0) return 0;
      const db = this.getTenantDb();
      const upsert = db.prepare(`
        INSERT INTO ${TABLES.ragIdentityUsers}
        (id, tenantId, domain, extId, email, upn, name, type, groups, attrs, syncRunId, syncedAt)
        VALUES (@id, @tenantId, @domain, @extId, @email, @upn, @name, @type, @groups, @attrs, @syncRunId, @syncedAt)
        ON CONFLICT(domain, extId) DO UPDATE SET
          tenantId = excluded.tenantId,
          email = excluded.email,
          upn = excluded.upn,
          name = excluded.name,
          type = excluded.type,
          groups = excluded.groups,
          attrs = excluded.attrs,
          syncRunId = excluded.syncRunId,
          syncedAt = excluded.syncedAt
      `);
      db.transaction(() => {
        for (const user of prepared) {
          upsert.run({
            id: this.newId(),
            tenantId: user.tenantId,
            domain,
            extId: user.extId,
            email: user.email ?? null,
            upn: user.upn ?? null,
            name: user.name ?? null,
            type: user.type ?? null,
            groups: user.groups ? this.toJson(user.groups) : null,
            attrs: user.attrs ? this.toJson(user.attrs) : null,
            syncRunId: user.syncRunId ?? null,
            syncedAt: user.syncedAt.toISOString(),
          });
        }
      })();
      return prepared.length;
    }

    /** Removes the domain's users that a later sync run did not report (rows without a run id included). */
    async pruneRagIdentityUsers(domain: string, keepRunId: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(
        `DELETE FROM ${TABLES.ragIdentityUsers} WHERE domain = @domain AND (syncRunId IS NULL OR syncRunId <> @keepRunId)`,
      ).run({ domain, keepRunId }).changes;
    }

    async findRagIdentityUsers(
      domain: string,
      field: 'extId' | 'email' | 'upn' | `attr:${string}`,
      values: string[],
    ): Promise<IRagIdentityUser[]> {
      const lookup = resolveRagIdentityLookup(field, values);
      if (!lookup) return [];
      const db = this.getTenantDb();
      const params: Record<string, unknown> = { domain, values: jsonList(lookup.values) };
      let column: string;
      if (lookup.kind === 'attr') {
        // The name is validated (`RAG_IDENTITY_ATTR_NAME`) and travels as a bound
        // JSON path, quoted so a `.` or `-` in it is part of the name.
        column = 'json_extract(attrs, @attrPath)';
        params.attrPath = `$."${lookup.name}"`;
      } else {
        column = lookup.kind;
      }
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragIdentityUsers} WHERE domain = @domain AND ${column} IN (SELECT value FROM json_each(@values)) ORDER BY extId ASC`,
      ).all(params) as SqliteRow[];
      return rows.map((row) => this.mapRagIdentityUserRow(row));
    }

    /**
     * Ordered by e-mail, then `extId`. `search` looks in e-mail, UPN and name,
     * ignoring case. `extIds` keeps only those users (an empty list: nobody),
     * `excludeExtIds` leaves those out; ids are compared as given and travel as
     * one JSON parameter each.
     */
    async listRagIdentityUsers(
      domain: string,
      options?: { search?: string; limit?: number; offset?: number; extIds?: string[]; excludeExtIds?: string[] },
    ): Promise<{ users: IRagIdentityUser[]; total: number }> {
      const db = this.getTenantDb();
      const { limit, offset } = clampRagIdentityPage(options);
      const clauses: string[] = ['domain = @domain'];
      const params: Record<string, unknown> = { domain };
      const search = options?.search?.trim();
      if (search) {
        // Folded on both sides (LIKE alone folds ASCII only) with the escape
        // character declared, so `%` and `_` typed in the box are looked for as typed.
        const columns = ['email', 'upn', 'name'].map((c) => `iam_fold(${c}) LIKE iam_fold(@search) ESCAPE '\\'`);
        clauses.push(`(${columns.join(' OR ')})`);
        params.search = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      }
      if (options?.extIds !== undefined) {
        const wanted = distinctNonEmptyStrings(options.extIds);
        if (wanted.length === 0) return { users: [], total: 0 };
        clauses.push('extId IN (SELECT value FROM json_each(@extIds))');
        params.extIds = jsonList(wanted);
      }
      if (options?.excludeExtIds !== undefined) {
        const unwanted = distinctNonEmptyStrings(options.excludeExtIds);
        if (unwanted.length > 0) {
          clauses.push('extId NOT IN (SELECT value FROM json_each(@excludeExtIds))');
          params.excludeExtIds = jsonList(unwanted);
        }
      }
      const where = clauses.join(' AND ');
      const total = (db.prepare(`SELECT COUNT(*) AS cnt FROM ${TABLES.ragIdentityUsers} WHERE ${where}`).get(params) as {
        cnt: number;
      }).cnt;
      if (limit === 0) return { users: [], total };
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragIdentityUsers} WHERE ${where} ORDER BY email ASC, extId ASC LIMIT @limit OFFSET @offset`,
      ).all({ ...params, limit, offset }) as SqliteRow[];
      return { users: rows.map((row) => this.mapRagIdentityUserRow(row)), total };
    }

    /**
     * Each group id in the users' `groups` with the number of users holding it,
     * by id. The write keeps a group once per user, so one (user, group) row is
     * one user. A user without groups adds nothing (`json_each(NULL)` has no rows).
     */
    async listRagIdentityGroupCounts(domain: string): Promise<Array<{ id: string; users: number }>> {
      const db = this.getTenantDb();
      const rows = db.prepare(`
        SELECT g.value AS id, COUNT(*) AS users
        FROM ${TABLES.ragIdentityUsers} u, json_each(u.groups) g
        WHERE u.domain = @domain
        GROUP BY g.value ORDER BY g.value ASC
      `).all({ domain }) as Array<{ id: string; users: number }>;
      return rows.map((row) => ({ id: String(row.id), users: Number(row.users) }));
    }

    // ── Identity links ───────────────────────────────────────────────

    async listRagIdentityLinks(filters?: {
      domain?: string;
      consoleKind?: IRagIdentityLink['consoleKind'];
      consoleIds?: string[];
    }): Promise<IRagIdentityLink[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.domain !== undefined) { clauses.push('domain = @domain'); params.domain = filters.domain; }
      if (filters?.consoleKind) { clauses.push('consoleKind = @consoleKind'); params.consoleKind = filters.consoleKind; }
      if (filters?.consoleIds !== undefined) {
        const consoleIds = distinctNonEmptyStrings(filters.consoleIds);
        if (consoleIds.length === 0) return [];
        clauses.push('consoleId IN (SELECT value FROM json_each(@consoleIds))');
        params.consoleIds = jsonList(consoleIds);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragIdentityLinks} ${where} ORDER BY createdAt ASC, rowid ASC`,
      ).all(params) as SqliteRow[];
      return rows.map((row) => this.mapRagIdentityLinkRow(row));
    }

    /**
     * Idempotent: linking the same pair twice answers with the first link. A
     * duplicate row would outlive the deletion of the other one, and access
     * would stay after somebody unlinked it.
     */
    async createRagIdentityLink(
      link: Omit<IRagIdentityLink, '_id' | 'createdAt'>,
    ): Promise<IRagIdentityLink> {
      const db = this.getTenantDb();
      const existing = db.prepare(`
        SELECT * FROM ${TABLES.ragIdentityLinks}
        WHERE domain = @domain AND externalKind = @externalKind AND externalId = @externalId
          AND consoleKind = @consoleKind AND consoleId = @consoleId
        ORDER BY createdAt ASC, rowid ASC LIMIT 1
      `).get({
        domain: link.domain,
        externalKind: link.externalKind,
        externalId: link.externalId,
        consoleKind: link.consoleKind,
        consoleId: link.consoleId,
      }) as SqliteRow | undefined;
      if (existing) return this.mapRagIdentityLinkRow(existing);

      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.ragIdentityLinks}
        (id, tenantId, domain, externalKind, externalId, consoleKind, consoleId, createdBy, createdAt)
        VALUES (@id, @tenantId, @domain, @externalKind, @externalId, @consoleKind, @consoleId, @createdBy, @createdAt)
      `).run({
        id,
        tenantId: link.tenantId,
        domain: link.domain,
        externalKind: link.externalKind,
        externalId: link.externalId,
        consoleKind: link.consoleKind,
        consoleId: link.consoleId,
        createdBy: link.createdBy ?? null,
        createdAt: now,
      });
      return { ...link, _id: id, createdAt: new Date(now) };
    }

    async deleteRagIdentityLink(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.ragIdentityLinks} WHERE id = @id`).run({ id }).changes > 0;
    }

    // ── Private helpers ──────────────────────────────────────────────

    /** `ragModuleKey = @ragModuleKey` plus the project scope of the documents (none when no project is given). */
    private ragModuleScope(
      ragModuleKey: string,
      projectId?: string,
    ): { clauses: string[]; params: Record<string, unknown> } {
      const clauses: string[] = ['ragModuleKey = @ragModuleKey'];
      const params: Record<string, unknown> = { ragModuleKey };
      if (projectId !== undefined) {
        const scopeFilter = this.buildProjectScopeFilter(projectId);
        clauses.push(scopeFilter.clause);
        Object.assign(params, scopeFilter.params);
      }
      return { clauses, params };
    }

    private mapRagFolderRow(r: SqliteRow): IRagFolder {
      return {
        _id: String(r.id),
        tenantId: String(r.tenantId),
        projectId: r.projectId ? String(r.projectId) : undefined,
        ragModuleKey: String(r.ragModuleKey),
        parentId: r.parentId ? String(r.parentId) : undefined,
        name: String(r.name),
        ancestorIds: r.ancestorIds ? this.parseJson<string[] | undefined>(r.ancestorIds, undefined) : undefined,
        aclMode: r.aclMode === 'own' ? 'own' : undefined,
        aclManaged: r.aclManaged === 'sync' ? 'sync' : undefined,
        source: r.source ? this.parseJson<IRagFolder['source']>(r.source, undefined) : undefined,
        createdBy: String(r.createdBy),
        updatedBy: r.updatedBy ? String(r.updatedBy) : undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    private mapRagAclEntryRow(r: SqliteRow): IRagAclEntry {
      return {
        _id: String(r.id),
        tenantId: String(r.tenantId),
        projectId: r.projectId ? String(r.projectId) : undefined,
        ragModuleKey: String(r.ragModuleKey),
        nodeType: String(r.nodeType) as IRagAclEntry['nodeType'],
        nodeId: String(r.nodeId),
        principal: String(r.principal),
        label: r.label ? String(r.label) : undefined,
        managed: r.managed === 'sync' ? 'sync' : undefined,
        createdBy: r.createdBy ? String(r.createdBy) : undefined,
        createdAt: this.toDate(r.createdAt),
      };
    }

    private mapRagIdentityDomainRow(r: SqliteRow): IRagIdentityDomain {
      return {
        _id: String(r.id),
        tenantId: String(r.tenantId),
        key: String(r.key),
        kind: String(r.kind) as IRagIdentityDomain['kind'],
        label: String(r.label),
        source: r.source ? this.parseJson<IRagIdentityDomain['source']>(r.source, undefined) : undefined,
        userMatch: this.parseJson<IRagIdentityDomain['userMatch']>(r.userMatch, []),
        matchGroupsByExternalId:
          r.matchGroupsByExternalId === null || r.matchGroupsByExternalId === undefined
            ? undefined
            : this.fromBoolInt(r.matchGroupsByExternalId),
        createdBy: r.createdBy ? String(r.createdBy) : undefined,
        updatedBy: r.updatedBy ? String(r.updatedBy) : undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    private mapRagIdentityUserRow(r: SqliteRow): IRagIdentityUser {
      return {
        _id: String(r.id),
        tenantId: String(r.tenantId),
        domain: String(r.domain),
        extId: String(r.extId),
        email: r.email ? String(r.email) : undefined,
        upn: r.upn ? String(r.upn) : undefined,
        name: r.name ? String(r.name) : undefined,
        type: r.type === 'member' || r.type === 'guest' ? r.type : undefined,
        groups: r.groups ? this.parseJson<string[] | undefined>(r.groups, undefined) : undefined,
        attrs: r.attrs ? this.parseJson<Record<string, string> | undefined>(r.attrs, undefined) : undefined,
        syncRunId: r.syncRunId ? String(r.syncRunId) : undefined,
        syncedAt: this.toDate(r.syncedAt),
      };
    }

    private mapRagIdentityLinkRow(r: SqliteRow): IRagIdentityLink {
      return {
        _id: String(r.id),
        tenantId: String(r.tenantId),
        domain: String(r.domain),
        externalKind: String(r.externalKind) as IRagIdentityLink['externalKind'],
        externalId: String(r.externalId),
        consoleKind: String(r.consoleKind) as IRagIdentityLink['consoleKind'],
        consoleId: String(r.consoleId),
        createdBy: r.createdBy ? String(r.createdBy) : undefined,
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
