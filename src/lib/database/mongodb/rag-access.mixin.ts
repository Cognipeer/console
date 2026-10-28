/**
 * MongoDB Provider – Knowledge Engine access control mixin
 *
 * Folders, permission entries and external identity directories. Mirrors
 * `sqlite/rag-access.mixin.ts`; the two answer alike (db-parity.test.ts).
 *
 * Optional fields are never stored as null: an insert leaves a missing field
 * out, and an update that clears one `$unset`s it, so a document reads back the
 * way SQLite's NULL does (absent).
 *
 * Project scope follows the documents (`buildProjectScopeFilter`): a project id
 * narrows the read to that project, an undefined one does not narrow at all.
 *
 * The five collections are created by their first write, which is after the
 * boot-time index pass skipped them. Every write path therefore ensures the
 * collection's indexes first (`ensureTenantCollectionIndexes`, memoised per
 * tenant database), so the unique keys the retries below rely on exist from the
 * very first insert.
 */

import { MongoBulkWriteError, ObjectId, type AnyBulkWriteOperation, type Document, type Filter } from 'mongodb';
import type {
  IRagAclEntry,
  IRagFolder,
  IRagIdentityDomain,
  IRagIdentityLink,
  IRagIdentityUser,
} from '../provider.interface';
import {
  clampRagIdentityPage,
  dedupeAclEntries,
  distinctNonEmptyStrings,
  prepareRagIdentityUsers,
  ragAclPrincipalPrefix,
  resolveRagIdentityLookup,
  type NormalizedRagIdentityUser,
} from '../provider/ragAccess';
import { foldedRegexSource } from '@/lib/shared/searchFold';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';
import { ensureTenantCollectionIndexes } from './indexManifest';
import { toObjectId, toObjectIds } from './objectIds';

const DUPLICATE_KEY_ERROR_CODE = 11000;
/** Directory users written per `bulkWrite`, so a big sync never builds one enormous request. */
const USER_UPSERT_CHUNK = 1000;

/** Folder fields an update clears by passing an explicit `undefined`. */
const FOLDER_NULLABLE_FIELDS = ['parentId', 'ancestorIds', 'aclMode', 'aclManaged', 'source'] as const;

/** `record` without its undefined / null fields (the driver would store them as null). */
function compact<T extends Record<string, unknown>>(record: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function withStringId<T>(doc: { _id?: unknown }): T {
  return { ...doc, _id: doc._id?.toString() } as unknown as T;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === DUPLICATE_KEY_ERROR_CODE;
}

export function RagAccessMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class RagAccessOps extends Base {
    // ── Folders ──────────────────────────────────────────────────────

    async createRagFolder(
      folder: Omit<IRagFolder, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRagFolder> {
      const db = this.getTenantDb();
      await ensureTenantCollectionIndexes(db, COLLECTIONS.ragFolders);
      const now = new Date();
      const doc = { ...compact(folder), createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.ragFolders).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() } as unknown as IRagFolder;
    }

    async updateRagFolder(
      id: string,
      data: Partial<Pick<IRagFolder, 'name' | 'parentId' | 'ancestorIds' | 'aclMode' | 'aclManaged' | 'source' | 'updatedBy'>>,
    ): Promise<IRagFolder | null> {
      const oid = toObjectId(id);
      if (!oid) return null;
      const db = this.getTenantDb();
      const set: Record<string, unknown> = { updatedAt: new Date() };
      const unset: Record<string, ''> = {};
      if (data.name !== undefined) set.name = data.name;
      if (data.updatedBy !== undefined) set.updatedBy = data.updatedBy;
      for (const field of FOLDER_NULLABLE_FIELDS) {
        if (!Object.hasOwn(data, field)) continue;
        const value = data[field];
        if (value === undefined || value === null) unset[field] = '';
        else set[field] = value;
      }
      const result = await db
        .collection(COLLECTIONS.ragFolders)
        .findOneAndUpdate(
          { _id: oid },
          Object.keys(unset).length > 0 ? { $set: set, $unset: unset } : { $set: set },
          { returnDocument: 'after' },
        );
      return result ? withStringId<IRagFolder>(result) : null;
    }

    async findRagFolderById(id: string): Promise<IRagFolder | null> {
      const oid = toObjectId(id);
      if (!oid) return null;
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.ragFolders).findOne({ _id: oid });
      return doc ? withStringId<IRagFolder>(doc) : null;
    }

    async findRagFolderBySource(
      ragModuleKey: string,
      sourceId: string,
      externalId: string,
      projectId?: string,
    ): Promise<IRagFolder | null> {
      const db = this.getTenantDb();
      const query = this.ragModuleQuery(ragModuleKey, projectId);
      query['source.sourceId'] = sourceId;
      query['source.externalId'] = externalId;
      const doc = await db
        .collection(COLLECTIONS.ragFolders)
        .findOne(query as Filter<Document>, { sort: { createdAt: 1, _id: 1 } });
      return doc ? withStringId<IRagFolder>(doc) : null;
    }

    async listRagFolders(
      ragModuleKey: string,
      filters?: { projectId?: string; parentId?: string | null; ancestorId?: string; ids?: string[]; sourceId?: string },
    ): Promise<IRagFolder[]> {
      const db = this.getTenantDb();
      const query = this.ragModuleQuery(ragModuleKey, filters?.projectId);

      if (filters?.parentId === null || filters?.parentId === '') {
        // `null` also matches a folder that has no parentId at all.
        query.parentId = { $in: [null, ''] };
      } else if (typeof filters?.parentId === 'string') {
        query.parentId = filters.parentId;
      }
      // Equality against an array field matches an array that contains the value.
      if (filters?.ancestorId) query.ancestorIds = filters.ancestorId;
      if (filters?.ids !== undefined) {
        const oids = toObjectIds(filters.ids);
        if (oids.length === 0) return [];
        query._id = { $in: oids };
      }
      if (filters?.sourceId) query['source.sourceId'] = filters.sourceId;

      const docs = await db
        .collection(COLLECTIONS.ragFolders)
        .find(query as Filter<Document>)
        .sort({ name: 1, _id: 1 })
        .toArray();
      return docs.map((doc) => withStringId<IRagFolder>(doc));
    }

    /** Deletes the folder and the permission entries that sat on it. */
    async deleteRagFolder(id: string): Promise<boolean> {
      const oid = toObjectId(id);
      if (!oid) return false;
      const db = this.getTenantDb();
      const removed = await db
        .collection(COLLECTIONS.ragFolders)
        .findOneAndDelete({ _id: oid }, { projection: { ragModuleKey: 1 } });
      if (!removed) return false;
      await db
        .collection(COLLECTIONS.ragAclEntries)
        .deleteMany({ ragModuleKey: removed.ragModuleKey, nodeType: 'folder', nodeId: id });
      return true;
    }

    async deleteRagFoldersByModuleKey(ragModuleKey: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragFolders)
        .deleteMany(this.ragModuleQuery(ragModuleKey, projectId) as Filter<Document>);
      return result.deletedCount;
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
      const query = this.ragModuleQuery(ragModuleKey, filters?.projectId);

      if (filters?.nodeType) query.nodeType = filters.nodeType;
      if (filters?.nodeId !== undefined) query.nodeId = filters.nodeId;
      if (filters?.nodeIds !== undefined) {
        const nodeIds = distinctNonEmptyStrings(filters.nodeIds);
        if (nodeIds.length === 0) return [];
        query.nodeId = filters.nodeId !== undefined ? { $eq: filters.nodeId, $in: nodeIds } : { $in: nodeIds };
      }
      if (filters?.principals !== undefined) {
        const principals = distinctNonEmptyStrings(filters.principals);
        if (principals.length === 0) return [];
        query.principal = { $in: principals };
      }

      const docs = await db
        .collection(COLLECTIONS.ragAclEntries)
        .find(query as Filter<Document>)
        .sort({ createdAt: 1, _id: 1 })
        .toArray();
      return docs.map((doc) => withStringId<IRagAclEntry>(doc));
    }

    async listRagAclNodesForPrincipals(
      ragModuleKey: string,
      principals: string[],
      projectId?: string,
    ): Promise<Array<{ nodeType: IRagAclEntry['nodeType']; nodeId: string }>> {
      const wanted = distinctNonEmptyStrings(principals);
      if (wanted.length === 0) return [];
      const db = this.getTenantDb();
      const query = this.ragModuleQuery(ragModuleKey, projectId);
      query.principal = { $in: wanted };
      const rows = await db
        .collection(COLLECTIONS.ragAclEntries)
        .aggregate<{ _id: { nodeType: IRagAclEntry['nodeType']; nodeId: string } }>([
          { $match: query },
          { $group: { _id: { nodeType: '$nodeType', nodeId: '$nodeId' } } },
          { $sort: { '_id.nodeType': 1, '_id.nodeId': 1 } },
        ])
        .toArray();
      return rows.map((row) => ({ nodeType: row._id.nodeType, nodeId: String(row._id.nodeId) }));
    }

    async hasRagAclEntries(
      ragModuleKey: string,
      nodeType: IRagAclEntry['nodeType'],
      nodeId: string,
      projectId?: string,
    ): Promise<boolean> {
      const db = this.getTenantDb();
      const query = this.ragModuleQuery(ragModuleKey, projectId);
      query.nodeType = nodeType;
      query.nodeId = nodeId;
      const found = await db
        .collection(COLLECTIONS.ragAclEntries)
        .findOne(query as Filter<Document>, { projection: { _id: 1 } });
      return found !== null;
    }

    /**
     * MongoDB has no transaction on a standalone server, so the node's current
     * entries are noted, the new entries written, and only the noted ones then
     * removed. A reader in between sees the old and the new together (briefly
     * more permissive on the entries that are going away), never the node with
     * none - an empty module root reads as "everyone". Removing exactly what was
     * there before (not "everything but my entries") also means two replaces of
     * the same node that overlap cannot delete each other's rows and leave it
     * empty: at worst both sets stay until the next save. A principal listed
     * twice is written once.
     */
    async replaceRagAclEntries(
      ragModuleKey: string,
      node: { type: IRagAclEntry['nodeType']; id: string },
      entries: Array<Omit<IRagAclEntry, '_id' | 'ragModuleKey' | 'nodeType' | 'nodeId' | 'createdAt'>>,
      projectId?: string,
    ): Promise<void> {
      const db = this.getTenantDb();
      const coll = db.collection(COLLECTIONS.ragAclEntries);
      const now = new Date();
      const docs = dedupeAclEntries(entries).map((entry) => {
        const entryProject = entry.projectId ?? projectId;
        return {
          _id: new ObjectId(),
          ...compact({
            tenantId: entry.tenantId,
            projectId: entryProject ? entryProject : undefined,
            ragModuleKey,
            nodeType: node.type,
            nodeId: node.id,
            principal: entry.principal,
            label: entry.label,
            managed: entry.managed,
            createdBy: entry.createdBy,
          }),
          createdAt: now,
        };
      });

      const query = this.ragModuleQuery(ragModuleKey, projectId);
      query.nodeType = node.type;
      query.nodeId = node.id;
      const previous = await coll.find(query as Filter<Document>, { projection: { _id: 1 } }).toArray();

      if (docs.length > 0) {
        await ensureTenantCollectionIndexes(db, COLLECTIONS.ragAclEntries);
        await coll.insertMany(docs);
      }
      if (previous.length > 0) {
        await coll.deleteMany({ _id: { $in: previous.map((entry) => entry._id) } });
      }
    }

    async deleteRagAclEntriesByModuleKey(ragModuleKey: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragAclEntries)
        .deleteMany(this.ragModuleQuery(ragModuleKey, projectId) as Filter<Document>);
      return result.deletedCount;
    }

    /** Every module and project of the tenant. An anchored regular expression over the escaped prefix: case-sensitive, no wildcard. */
    async deleteRagAclEntriesByPrincipalPrefix(prefix: string): Promise<number> {
      const literal = ragAclPrincipalPrefix(prefix);
      if (literal === null) return 0;
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.ragAclEntries)
        .deleteMany({ principal: { $regex: `^${this.escapeRegex(literal)}` } });
      return result.deletedCount;
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
      const coll = db.collection(COLLECTIONS.ragIdentityDomains);
      const now = new Date();
      const set: Record<string, unknown> = {
        kind: domain.kind,
        label: domain.label,
        userMatch: domain.userMatch ?? [],
        updatedAt: now,
      };
      const unset: Record<string, ''> = {};
      if (domain.source) set.source = domain.source;
      else unset.source = '';
      if (domain.matchGroupsByExternalId === undefined || domain.matchGroupsByExternalId === null) {
        unset.matchGroupsByExternalId = '';
      } else {
        set.matchGroupsByExternalId = domain.matchGroupsByExternalId;
      }
      if (domain.updatedBy !== undefined) set.updatedBy = domain.updatedBy;
      const setOnInsert: Record<string, unknown> = { tenantId: domain.tenantId, createdAt: now };
      if (domain.createdBy !== undefined) setOnInsert.createdBy = domain.createdBy;

      const update = {
        $set: set,
        $setOnInsert: setOnInsert,
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
      };
      const run = () =>
        coll.findOneAndUpdate({ key: domain.key }, update, { upsert: true, returnDocument: 'after' });
      await ensureTenantCollectionIndexes(db, COLLECTIONS.ragIdentityDomains);
      let doc;
      try {
        doc = await run();
      } catch (error) {
        // Two writers creating the same brand-new domain: the loser hits the
        // unique index; the retry then matches the winner's document.
        if (!isDuplicateKeyError(error)) throw error;
        doc = await run();
      }
      return withStringId<IRagIdentityDomain>(doc as Document);
    }

    async findRagIdentityDomain(key: string): Promise<IRagIdentityDomain | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.ragIdentityDomains).findOne({ key });
      return doc ? withStringId<IRagIdentityDomain>(doc) : null;
    }

    async listRagIdentityDomains(): Promise<IRagIdentityDomain[]> {
      const db = this.getTenantDb();
      const docs = await db.collection(COLLECTIONS.ragIdentityDomains).find({}).sort({ key: 1 }).toArray();
      return docs.map((doc) => withStringId<IRagIdentityDomain>(doc));
    }

    /** Deletes the domain together with its directory users and its links. */
    async deleteRagIdentityDomain(key: string): Promise<boolean> {
      const db = this.getTenantDb();
      await db.collection(COLLECTIONS.ragIdentityUsers).deleteMany({ domain: key });
      await db.collection(COLLECTIONS.ragIdentityLinks).deleteMany({ domain: key });
      const result = await db.collection(COLLECTIONS.ragIdentityDomains).deleteOne({ key });
      return result.deletedCount > 0;
    }

    // ── Identity directory users ─────────────────────────────────────

    /**
     * Insert or replace by (domain, extId). `email`, `upn` and attribute values
     * are stored lower-cased; a user given twice is written once (the last one).
     * Returns how many users were written.
     */
    async upsertRagIdentityUsers(
      domain: string,
      users: Array<Omit<IRagIdentityUser, '_id' | 'domain'>>,
    ): Promise<number> {
      const prepared = prepareRagIdentityUsers(users, new Date());
      if (prepared.length === 0) return 0;
      const db = this.getTenantDb();
      await ensureTenantCollectionIndexes(db, COLLECTIONS.ragIdentityUsers);
      const coll = db.collection(COLLECTIONS.ragIdentityUsers);
      for (let from = 0; from < prepared.length; from += USER_UPSERT_CHUNK) {
        const ops = prepared.slice(from, from + USER_UPSERT_CHUNK).map((user) => this.identityUserUpsert(domain, user));
        try {
          await coll.bulkWrite(ops, { ordered: false });
        } catch (error) {
          // Two syncs upserting the same brand-new user: the loser hits the
          // unique index (E11000). Retry just those operations once; they now
          // match the winner's document. Anything else rethrows.
          const writeErrors = (error as { writeErrors?: unknown })?.writeErrors;
          const list = (Array.isArray(writeErrors) ? writeErrors : writeErrors ? [writeErrors] : []) as Array<{
            code?: number;
            index?: number;
          }>;
          if (
            !(error instanceof MongoBulkWriteError) ||
            list.length === 0 ||
            !list.every((e) => e.code === DUPLICATE_KEY_ERROR_CODE && typeof e.index === 'number')
          ) {
            throw error;
          }
          await coll.bulkWrite(list.map((e) => ops[e.index as number]), { ordered: false });
        }
      }
      return prepared.length;
    }

    /** Removes the domain's users that a later sync run did not report (documents without a run id included). */
    async pruneRagIdentityUsers(domain: string, keepRunId: string): Promise<number> {
      const db = this.getTenantDb();
      // `$ne` also matches a document that has no syncRunId at all.
      const result = await db
        .collection(COLLECTIONS.ragIdentityUsers)
        .deleteMany({ domain, syncRunId: { $ne: keepRunId } });
      return result.deletedCount;
    }

    async findRagIdentityUsers(
      domain: string,
      field: 'extId' | 'email' | 'upn' | `attr:${string}`,
      values: string[],
    ): Promise<IRagIdentityUser[]> {
      const lookup = resolveRagIdentityLookup(field, values);
      if (!lookup) return [];
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { domain };
      if (lookup.kind === 'attr') {
        if (lookup.name.includes('.')) {
          // A dot would be read as a path separator; $getField takes the name literally.
          query.$expr = {
            $in: [{ $getField: { field: { $literal: lookup.name }, input: '$attrs' } }, { $literal: lookup.values }],
          };
        } else {
          query[`attrs.${lookup.name}`] = { $in: lookup.values };
        }
      } else {
        query[lookup.kind] = { $in: lookup.values };
      }
      const docs = await db
        .collection(COLLECTIONS.ragIdentityUsers)
        .find(query as Filter<Document>)
        .sort({ extId: 1 })
        .toArray();
      return docs.map((doc) => withStringId<IRagIdentityUser>(doc));
    }

    /** Ordered by e-mail, then `extId`. `search` looks in e-mail, UPN and name, ignoring case. */
    async listRagIdentityUsers(
      domain: string,
      options?: { search?: string; limit?: number; offset?: number },
    ): Promise<{ users: IRagIdentityUser[]; total: number }> {
      const db = this.getTenantDb();
      const coll = db.collection(COLLECTIONS.ragIdentityUsers);
      const { limit, offset } = clampRagIdentityPage(options);
      const query: Record<string, unknown> = { domain };
      const search = options?.search?.trim();
      if (search) {
        // Escaped, with the letters of the Turkish i family interchangeable
        // (the same fold SQLite applies with iam_fold).
        const matcher = { $regex: foldedRegexSource(search), $options: 'i' };
        query.$or = [{ email: matcher }, { upn: matcher }, { name: matcher }];
      }
      const total = await coll.countDocuments(query as Filter<Document>);
      if (limit === 0) return { users: [], total };
      const docs = await coll
        .find(query as Filter<Document>)
        .sort({ email: 1, extId: 1 })
        .skip(offset)
        .limit(limit)
        .toArray();
      return { users: docs.map((doc) => withStringId<IRagIdentityUser>(doc)), total };
    }

    // ── Identity links ───────────────────────────────────────────────

    async listRagIdentityLinks(filters?: {
      domain?: string;
      consoleKind?: IRagIdentityLink['consoleKind'];
      consoleIds?: string[];
    }): Promise<IRagIdentityLink[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};
      if (filters?.domain !== undefined) query.domain = filters.domain;
      if (filters?.consoleKind) query.consoleKind = filters.consoleKind;
      if (filters?.consoleIds !== undefined) {
        const consoleIds = distinctNonEmptyStrings(filters.consoleIds);
        if (consoleIds.length === 0) return [];
        query.consoleId = { $in: consoleIds };
      }
      const docs = await db
        .collection(COLLECTIONS.ragIdentityLinks)
        .find(query as Filter<Document>)
        .sort({ createdAt: 1, _id: 1 })
        .toArray();
      return docs.map((doc) => withStringId<IRagIdentityLink>(doc));
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
      const coll = db.collection(COLLECTIONS.ragIdentityLinks);
      const pair = {
        domain: link.domain,
        externalKind: link.externalKind,
        externalId: link.externalId,
        consoleKind: link.consoleKind,
        consoleId: link.consoleId,
      };
      const existing = await coll.findOne(pair, { sort: { createdAt: 1, _id: 1 } });
      if (existing) return withStringId<IRagIdentityLink>(existing);

      await ensureTenantCollectionIndexes(db, COLLECTIONS.ragIdentityLinks);
      const doc = { ...compact(link), createdAt: new Date() };
      try {
        const result = await coll.insertOne(doc);
        return { ...doc, _id: result.insertedId.toString() } as unknown as IRagIdentityLink;
      } catch (error) {
        // The same pair linked at the same moment by another request: the unique pair index kept the twin out.
        if ((error as { code?: unknown } | null)?.code !== 11000) throw error;
        const first = await coll.findOne(pair, { sort: { createdAt: 1, _id: 1 } });
        if (!first) throw error;
        return withStringId<IRagIdentityLink>(first);
      }
    }

    async deleteRagIdentityLink(id: string): Promise<boolean> {
      const oid = toObjectId(id);
      if (!oid) return false;
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.ragIdentityLinks).deleteOne({ _id: oid });
      return result.deletedCount > 0;
    }

    // ── Private helpers ──────────────────────────────────────────────

    /** `{ ragModuleKey }` plus the project scope of the documents (none when no project is given). */
    private ragModuleQuery(ragModuleKey: string, projectId?: string): Record<string, unknown> {
      const query: Record<string, unknown> = { ragModuleKey };
      if (projectId !== undefined) Object.assign(query, this.buildProjectScopeFilter(projectId));
      return query;
    }

    private identityUserUpsert(domain: string, user: NormalizedRagIdentityUser): AnyBulkWriteOperation<Document> {
      const set: Record<string, unknown> = {
        tenantId: user.tenantId,
        domain,
        extId: user.extId,
        syncedAt: user.syncedAt,
      };
      const unset: Record<string, ''> = {};
      const optional: Record<string, unknown> = {
        email: user.email,
        upn: user.upn,
        name: user.name,
        type: user.type,
        groups: user.groups,
        attrs: user.attrs,
        syncRunId: user.syncRunId,
      };
      for (const [field, value] of Object.entries(optional)) {
        if (value === undefined) unset[field] = '';
        else set[field] = value;
      }
      return {
        updateOne: {
          filter: { domain, extId: user.extId },
          update: Object.keys(unset).length > 0 ? { $set: set, $unset: unset } : { $set: set },
          upsert: true,
        },
      };
    }
  };
}
