/**
 * MongoDB Provider - IAM directory queries mixin.
 *
 * Mirror of sqlite/iam-directory.mixin.ts (read it for the contract): read-only,
 * offset-paged listings of users, groups, API tokens and audit rows for the
 * Authorization center. No collection, field or index is created or changed.
 *
 * Search is a case-insensitive escaped `$regex` (no user input ever reaches the
 * regex engine unescaped; the Turkish i family I, İ, i, ı matches each other);
 * ordering is plain binary on name then _id - no
 * collation, so it behaves the same on every MongoDB-compatible backend.
 */

import { ObjectId, type Filter } from 'mongodb';
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
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';
import { normalizeServicePermissions } from '@/lib/security/rbac';
import { foldedRegexSource } from '@/lib/shared/searchFold';
import { decodeUserDocExternalIds } from '../provider/externalIds';

const MAX_PAGE = 200;
const MAX_IDS = 500;
/** A group's members as an audit actor filter. */
const MAX_ACTOR_IDS = 5_000;
const META_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const clampLimit = (n: number | undefined): number => Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(n)) || 50));
const clampOffset = (n: number | undefined): number => Math.max(0, Math.min(10_000_000, Math.floor(Number(n)) || 0));
/** The typed words, escaped, with the Turkish i family interchangeable (SQLite folds with the same rule). */
const search = (q: string) => ({ $regex: foldedRegexSource(q.trim()), $options: 'i' });

/** Valid ObjectIds of an id list (anything else cannot match a row, so it is dropped). */
function objectIds(ids: readonly string[]): ObjectId[] {
  return ids
    .slice(0, MAX_IDS)
    .filter((id) => typeof id === 'string' && ObjectId.isValid(id) && String(new ObjectId(id)) === id)
    .map((id) => new ObjectId(id));
}

/**
 * The members of a group or project are looked up first and then matched by id, so a
 * filter on them is bounded: a group beyond this many members is cut (the first ones
 * by user id), which the documented scale (thousands) stays well below.
 */
const MAX_MEMBER_IDS = 50_000;

/** Valid ObjectIds of a (possibly long) list of ids; anything that is not one cannot match a row. */
function memberObjectIds(ids: readonly string[]): ObjectId[] {
  const out: ObjectId[] = [];
  for (const id of ids) {
    if (out.length >= MAX_MEMBER_IDS) break;
    if (typeof id === 'string' && ObjectId.isValid(id) && String(new ObjectId(id)) === id) out.push(new ObjectId(id));
  }
  return out;
}

/** A user who was invited and has not answered: can sign in, was invited, has not accepted, is not disabled. */
const PENDING_INVITE: Record<string, unknown> = {
  canLogin: { $ne: false },
  status: { $ne: 'disabled' },
  invitedBy: { $exists: true, $nin: [null, ''] },
  // equals null: absent or null
  inviteAcceptedAt: null,
};

const USER_SORT_FIELD = { name: 'name', email: 'emailLower', createdAt: 'createdAt' } as const;

export function IamDirectoryMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class IamDirectoryOps extends Base {
    /** The query for a user filter, or null when it can match nothing (an empty id list). */
    private async iamUserFilter(query: IamUserFilter): Promise<Record<string, unknown> | null> {
      const db = this.getTenantDb();
      const and: Record<string, unknown>[] = [{ tenantId: query.tenantId }];
      if (query.q?.trim()) and.push({ $or: [{ name: search(query.q) }, { email: search(query.q) }] });
      if (query.roles?.length) and.push({ role: { $in: query.roles.slice(0, MAX_IDS) } });
      if (query.status === 'disabled') and.push({ status: 'disabled' });
      else if (query.status === 'active') and.push({ status: { $ne: 'disabled' } });
      if (query.ids) {
        if (query.ids.length === 0) return null;
        and.push({ _id: { $in: objectIds(query.ids) } });
      }
      if (query.excludeIds?.length) and.push({ _id: { $nin: objectIds(query.excludeIds) } });
      // A row without the flag can sign in.
      if (query.canLogin === true) and.push({ canLogin: { $ne: false } });
      else if (query.canLogin === false) and.push({ canLogin: false });
      // An account without a kind is a member.
      if (query.external === true) and.push({ kind: 'external' });
      else if (query.external === false) and.push({ kind: { $ne: 'external' } });
      if (query.authProviders?.length) {
        const parts: Record<string, unknown>[] = [];
        const named = query.authProviders.filter((provider) => provider !== 'local');
        // a local account has no provider at all (every row written before the field existed)
        if (query.authProviders.includes('local')) parts.push({ authProvider: { $in: [null, '', 'local'] } });
        if (named.length > 0) parts.push({ authProvider: { $in: named } });
        and.push({ $or: parts });
      }
      if (query.invited === true) and.push(PENDING_INVITE);
      else if (query.invited === false) and.push({ $nor: [PENDING_INVITE] });
      if (query.groupId) {
        const members = await db
          .collection(COLLECTIONS.groupMembers)
          .find({ tenantId: query.tenantId, groupId: query.groupId }, { projection: { userId: 1 } })
          .limit(MAX_MEMBER_IDS)
          .toArray();
        and.push({ _id: { $in: memberObjectIds(members.map((member) => String(member.userId))) } });
      }
      if (query.projectId) {
        const [direct, assignments] = await Promise.all([
          db.collection(COLLECTIONS.userProjects)
            .find({ tenantId: query.tenantId, projectId: query.projectId }, { projection: { userId: 1 } })
            .limit(MAX_MEMBER_IDS)
            .toArray(),
          db.collection(COLLECTIONS.groupProjects)
            .find({ tenantId: query.tenantId, projectId: query.projectId }, { projection: { groupId: 1 } })
            .toArray(),
        ]);
        const viaGroups = assignments.length === 0
          ? []
          : await db
            .collection(COLLECTIONS.groupMembers)
            .find({ tenantId: query.tenantId, groupId: { $in: assignments.map((row) => String(row.groupId)) } }, { projection: { userId: 1 } })
            .limit(MAX_MEMBER_IDS)
            .toArray();
        const memberIds = memberObjectIds([...direct, ...viaGroups].map((row) => String(row.userId)));
        // the legacy list of project ids on the user row matches an element
        and.push({ $or: [{ _id: { $in: memberIds } }, { projectIds: query.projectId }] });
      }
      return { $and: and };
    }

    async iamListUsers(query: IamUserQuery): Promise<IamPage<IUser>> {
      const db = this.getTenantDb();
      const limit = clampLimit(query.limit);
      const filter = await this.iamUserFilter(query);
      if (!filter) return { items: [], hasMore: false };
      const field = USER_SORT_FIELD[query.sort ?? 'name'] ?? USER_SORT_FIELD.name;
      const dir = query.dir === 'desc' ? -1 : 1;
      const docs = await db
        .collection<IUser>(COLLECTIONS.users)
        .find(filter as Filter<IUser>, { projection: { password: 0 } })
        .sort({ [field]: dir, _id: dir })
        .allowDiskUse(true)
        .skip(clampOffset(query.offset))
        .limit(limit + 1)
        .toArray();
      return {
        items: docs.slice(0, limit).map((doc) => ({ ...decodeUserDocExternalIds(doc), _id: doc._id?.toString(), password: '' }) as IUser),
        hasMore: docs.length > limit,
      };
    }

    async iamCountUsers(filter: IamUserFilter): Promise<number> {
      const where = await this.iamUserFilter(filter);
      if (!where) return 0;
      return this.getTenantDb().collection<IUser>(COLLECTIONS.users).countDocuments(where as Filter<IUser>);
    }

    private async iamGroupFilter(query: IamGroupFilter): Promise<Record<string, unknown> | null> {
      const db = this.getTenantDb();
      const and: Record<string, unknown>[] = [{ tenantId: query.tenantId }];
      if (query.q?.trim()) and.push({ $or: [{ name: search(query.q) }, { description: search(query.q) }] });
      if (query.ids) {
        if (query.ids.length === 0) return null;
        and.push({ _id: { $in: objectIds(query.ids) } });
      }
      if (query.sources?.length) {
        const parts: Record<string, unknown>[] = [];
        const named = query.sources.filter((source) => source !== 'local');
        if (query.sources.includes('local')) parts.push({ source: { $in: [null, '', 'local'] } });
        if (named.length > 0) parts.push({ source: { $in: named } });
        and.push({ $or: parts });
      }
      if (query.projectId) {
        const assignments = await db
          .collection(COLLECTIONS.groupProjects)
          .find({ tenantId: query.tenantId, projectId: query.projectId }, { projection: { groupId: 1 } })
          .toArray();
        and.push({ _id: { $in: objectIds(assignments.map((row) => String(row.groupId))) } });
      }
      return { $and: and };
    }

    async iamListGroups(query: IamGroupQuery): Promise<IamPage<IGroup>> {
      const db = this.getTenantDb();
      const limit = clampLimit(query.limit);
      const filter = await this.iamGroupFilter(query);
      if (!filter) return { items: [], hasMore: false };
      const docs = await db
        .collection<IGroup>(COLLECTIONS.groups)
        .find(filter as Filter<IGroup>)
        .sort({ name: 1, _id: 1 })
        .skip(clampOffset(query.offset))
        .limit(limit + 1)
        .toArray();
      return {
        items: docs.slice(0, limit).map((doc) => ({
          ...doc,
          _id: doc._id?.toString(),
          source: doc.source ?? 'local',
          servicePermissions: normalizeServicePermissions(doc.servicePermissions),
        }) as IGroup),
        hasMore: docs.length > limit,
      };
    }

    async iamCountGroups(filter: IamGroupFilter): Promise<number> {
      const where = await this.iamGroupFilter(filter);
      if (!where) return 0;
      return this.getTenantDb().collection<IGroup>(COLLECTIONS.groups).countDocuments(where as Filter<IGroup>);
    }

    async iamCountGroupMembers(groupIds: string[]): Promise<Record<string, number>> {
      const out: Record<string, number> = Object.fromEntries(groupIds.map((id) => [id, 0]));
      if (groupIds.length === 0) return out;
      const db = this.getTenantDb();
      for (let i = 0; i < groupIds.length; i += MAX_IDS) {
        const rows = await db
          .collection(COLLECTIONS.groupMembers)
          .aggregate<{ _id: string; c: number }>([
            { $match: { groupId: { $in: groupIds.slice(i, i + MAX_IDS) } } },
            { $group: { _id: '$groupId', c: { $sum: 1 } } },
          ])
          .toArray();
        for (const row of rows) out[String(row._id)] = row.c;
      }
      return out;
    }

    async iamListGroupMemberIds(groupId: string, page: IamPageRequest): Promise<IamPage<string>> {
      const db = this.getTenantDb();
      const limit = clampLimit(page.limit);
      const docs = await db
        .collection<{ userId: string }>(COLLECTIONS.groupMembers)
        .find({ groupId }, { projection: { userId: 1 } })
        .sort({ userId: 1 })
        .skip(clampOffset(page.offset))
        .limit(limit + 1)
        .toArray();
      return { items: docs.slice(0, limit).map((d) => String(d.userId)), hasMore: docs.length > limit };
    }

    /** The query for a token filter, or null when it can match nothing. */
    private iamTokenFilter(query: IamTokenFilter): Record<string, unknown> | null {
      const and: Record<string, unknown>[] = [{ tenantId: query.tenantId }];
      if (query.userId) and.push({ userId: query.userId });
      if (query.projectId) and.push({ projectId: query.projectId });
      if (query.q?.trim()) and.push({ $or: [{ label: search(query.q) }, { tokenPrefix: search(query.q) }] });
      if (query.ids) {
        if (query.ids.length === 0) return null;
        and.push({ _id: { $in: objectIds(query.ids) } });
      }
      if (query.status) {
        const now = query.now ?? new Date();
        // no expiry (absent or null) never expires
        and.push(query.status === 'expired'
          ? { expiresAt: { $ne: null, $lte: now } }
          : { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] });
      }
      if (query.scoped === true) and.push({ servicePermissions: { $ne: null } });
      else if (query.scoped === false) and.push({ servicePermissions: null });
      if (query.userIds) {
        if (query.userIds.length === 0) return null;
        and.push({ userId: { $in: query.userIds.slice(0, MAX_IDS) } });
      }
      if (query.excludeUserIds?.length) and.push({ userId: { $nin: query.excludeUserIds.slice(0, MAX_IDS) } });
      return { $and: and };
    }

    async iamListTokens(query: IamTokenQuery): Promise<IamPage<IApiToken>> {
      // API tokens live in the shared control-plane database, keyed by tenant.
      const db = this.getMainDb();
      const limit = clampLimit(query.limit);
      const filter = this.iamTokenFilter(query);
      if (!filter) return { items: [], hasMore: false };
      const docs = await db
        .collection<IApiToken>(COLLECTIONS.apiTokens)
        .find(filter as Filter<IApiToken>, { projection: { token: 0, tokenHash: 0 } })
        .sort({ createdAt: -1, _id: -1 })
        .skip(clampOffset(query.offset))
        .limit(limit + 1)
        .toArray();
      return {
        items: docs.slice(0, limit).map((doc) => ({ ...doc, _id: doc._id?.toString() }) as IApiToken),
        hasMore: docs.length > limit,
      };
    }

    async iamCountTokens(filter: IamTokenFilter): Promise<number> {
      const where = this.iamTokenFilter(filter);
      if (!where) return 0;
      return this.getMainDb().collection<IApiToken>(COLLECTIONS.apiTokens).countDocuments(where as Filter<IApiToken>);
    }

    async iamListAuditEvents(query: IamAuditQuery): Promise<IamPage<IAuditLog>> {
      const db = this.getTenantDb();
      const limit = clampLimit(query.limit);
      const filter: Record<string, unknown> = { tenantId: query.tenantId };
      if (query.from || query.to) {
        const createdAt: Record<string, Date> = {};
        if (query.from) createdAt.$gte = query.from;
        if (query.to) createdAt.$lte = query.to;
        filter.createdAt = createdAt;
      }
      // (service AND resourceType IN ...) OR event IN ...: the scope of "IAM changes" plus a few
      // events that live in another service (a token's expiry / allowlist edit).
      const scope: Record<string, unknown> = {};
      if (query.service) scope.service = query.service;
      if (query.resourceTypes) {
        if (query.resourceTypes.length === 0 && !query.alsoEvents?.length) return { items: [], hasMore: false };
        scope.resourceType = { $in: query.resourceTypes };
      }
      if (query.alsoEvents?.length) {
        filter.$or = [scope, { event: { $in: query.alsoEvents.slice(0, MAX_IDS) } }];
      } else {
        Object.assign(filter, scope);
      }
      if (query.outcome) filter.outcome = query.outcome;
      if (query.actorUserId) filter.actorUserId = query.actorUserId;
      if (query.actorUserIds) {
        if (query.actorUserIds.length === 0) return { items: [], hasMore: false };
        // an explicit actorUserId filter and an id list must both hold
        filter.actorUserId = query.actorUserId
          ? { $in: query.actorUserIds.slice(0, MAX_ACTOR_IDS).filter((id) => id === query.actorUserId) }
          : { $in: query.actorUserIds.slice(0, MAX_ACTOR_IDS) };
      }
      if (query.apiTokenId) filter.apiTokenId = query.apiTokenId;
      if (query.metadata) {
        if (!META_KEY_RE.test(query.metadata.key)) throw new Error(`Invalid metadata key "${query.metadata.key}"`);
        filter[`metadata.${query.metadata.key}`] = query.metadata.value;
      }
      const cursor = db
        .collection<IAuditLog>(COLLECTIONS.auditLogs)
        .find(filter as Filter<IAuditLog>)
        .sort({ createdAt: -1, _id: -1 })
        .skip(clampOffset(query.offset))
        .limit(limit + 1);
      if (query.maxTimeMs && query.maxTimeMs > 0) cursor.maxTimeMS(Math.floor(query.maxTimeMs));
      const docs = await cursor.toArray();
      return {
        items: docs.slice(0, limit).map((doc) => ({ ...doc, _id: doc._id?.toString() }) as IAuditLog),
        hasMore: docs.length > limit,
      };
    }
  };
}
