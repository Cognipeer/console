/**
 * MongoDB Provider - IAM directory queries mixin.
 *
 * Mirror of sqlite/iam-directory.mixin.ts (read it for the contract): read-only,
 * offset-paged listings of users, groups, API tokens and audit rows for the
 * Authorization center. No collection, field or index is created or changed.
 *
 * Search is a case-insensitive escaped `$regex` (no user input ever reaches the
 * regex engine unescaped); ordering is plain binary on name then _id - no
 * collation, so it behaves the same on every MongoDB-compatible backend.
 */

import { ObjectId, type Filter } from 'mongodb';
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
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, escapeRegex } from './base';
import { normalizeServicePermissions } from '@/lib/security/rbac';

const MAX_PAGE = 200;
const MAX_IDS = 500;
/** A group's members as an audit actor filter. */
const MAX_ACTOR_IDS = 5_000;
const META_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const clampLimit = (n: number | undefined): number => Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(n)) || 50));
const clampOffset = (n: number | undefined): number => Math.max(0, Math.min(10_000_000, Math.floor(Number(n)) || 0));
const search = (q: string) => ({ $regex: escapeRegex(q.trim()), $options: 'i' });

/** Valid ObjectIds of an id list (anything else cannot match a row, so it is dropped). */
function objectIds(ids: readonly string[]): ObjectId[] {
  return ids
    .slice(0, MAX_IDS)
    .filter((id) => typeof id === 'string' && ObjectId.isValid(id) && String(new ObjectId(id)) === id)
    .map((id) => new ObjectId(id));
}

export function IamDirectoryMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class IamDirectoryOps extends Base {
    async iamListUsers(query: IamUserQuery): Promise<IamPage<IUser>> {
      const db = this.getTenantDb();
      const limit = clampLimit(query.limit);
      const filter: Record<string, unknown> = { tenantId: query.tenantId };
      if (query.q?.trim()) filter.$or = [{ name: search(query.q) }, { email: search(query.q) }];
      if (query.roles?.length) filter.role = { $in: query.roles.slice(0, MAX_IDS) };
      if (query.status === 'disabled') filter.status = 'disabled';
      else if (query.status === 'active') filter.status = { $ne: 'disabled' };
      if (query.ids) {
        if (query.ids.length === 0) return { items: [], hasMore: false };
        filter._id = { $in: objectIds(query.ids) };
      }
      const docs = await db
        .collection<IUser>(COLLECTIONS.users)
        .find(filter as Filter<IUser>, { projection: { password: 0 } })
        .sort({ name: 1, _id: 1 })
        .allowDiskUse(true)
        .skip(clampOffset(query.offset))
        .limit(limit + 1)
        .toArray();
      return {
        items: docs.slice(0, limit).map((doc) => ({ ...doc, _id: doc._id?.toString(), password: '' }) as IUser),
        hasMore: docs.length > limit,
      };
    }

    async iamListGroups(query: IamGroupQuery): Promise<IamPage<IGroup>> {
      const db = this.getTenantDb();
      const limit = clampLimit(query.limit);
      const filter: Record<string, unknown> = { tenantId: query.tenantId };
      if (query.q?.trim()) filter.$or = [{ name: search(query.q) }, { description: search(query.q) }];
      if (query.ids) {
        if (query.ids.length === 0) return { items: [], hasMore: false };
        filter._id = { $in: objectIds(query.ids) };
      }
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

    async iamListTokens(query: IamTokenQuery): Promise<IamPage<IApiToken>> {
      // API tokens live in the shared control-plane database, keyed by tenant.
      const db = this.getMainDb();
      const limit = clampLimit(query.limit);
      const filter: Record<string, unknown> = { tenantId: query.tenantId };
      if (query.userId) filter.userId = query.userId;
      if (query.projectId) filter.projectId = query.projectId;
      if (query.q?.trim()) filter.$or = [{ label: search(query.q) }, { tokenPrefix: search(query.q) }];
      if (query.ids) {
        if (query.ids.length === 0) return { items: [], hasMore: false };
        filter._id = { $in: objectIds(query.ids) };
      }
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
