/**
 * MongoDB Provider – Browser sessions mixin
 *
 * Persists browser session metadata and fine-grained session event logs
 * (one document per action / tool call). The actual Playwright browser
 * instances live in-memory inside the `BrowserManager` service – only
 * metadata is stored here.
 */

import { ObjectId } from 'mongodb';
import type {
  IBrowser,
  IBrowserSession,
  IBrowserSessionEvent,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

function toId(value: ObjectId | string | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : value.toString();
}

function objectId(id: string): ObjectId {
  return new ObjectId(id);
}

export function BrowserMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class BrowserOps extends Base {    // ── Browsers (parent profiles) ────────────────────────────────

    async createBrowser(
      record: Omit<IBrowser, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IBrowser> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc: Omit<IBrowser, '_id'> = { ...record, createdAt: now, updatedAt: now };
      const result = await db
        .collection<IBrowser>(COLLECTIONS.browsers)
        .insertOne(doc as unknown as IBrowser);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateBrowser(
      id: string,
      data: Partial<Omit<IBrowser, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IBrowser | null> {
      const db = this.getTenantDb();
      const payload: Partial<IBrowser> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.createdAt;
      const result = await db
        .collection<IBrowser>(COLLECTIONS.browsers)
        .findOneAndUpdate({ _id: objectId(id) }, { $set: payload }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IBrowser;
    }

    async deleteBrowser(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IBrowser>(COLLECTIONS.browsers)
        .deleteOne({ _id: objectId(id) });
      return result.deletedCount > 0;
    }

    async findBrowserById(id: string): Promise<IBrowser | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<IBrowser>(COLLECTIONS.browsers)
          .findOne({ _id: objectId(id) });
        if (!record) return null;
        return { ...record, _id: toId(record._id) } as IBrowser;
      } catch {
        return null;
      }
    }

    async findBrowserByKey(
      tenantId: string,
      key: string,
      projectId?: string,
    ): Promise<IBrowser | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId, key };
      if (projectId) query.projectId = projectId;
      const record = await db.collection<IBrowser>(COLLECTIONS.browsers).findOne(query);
      if (!record) return null;
      return { ...record, _id: toId(record._id) } as IBrowser;
    }

    async listBrowsers(
      tenantId: string,
      filters?: { projectId?: string; status?: string; search?: string },
    ): Promise<IBrowser[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.status) query.status = filters.status;
      if (filters?.search) query.name = { $regex: filters.search, $options: 'i' };
      const docs = await db
        .collection<IBrowser>(COLLECTIONS.browsers)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IBrowser);
    }
    // ── Browser Sessions ──────────────────────────────────────────────

    async createBrowserSession(
      record: Omit<IBrowserSession, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IBrowserSession> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc: Omit<IBrowserSession, '_id'> = {
        ...record,
        createdAt: now,
        updatedAt: now,
      };
      const result = await db
        .collection<IBrowserSession>(COLLECTIONS.browserSessions)
        .insertOne(doc as unknown as IBrowserSession);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateBrowserSession(
      id: string,
      data: Partial<Omit<IBrowserSession, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IBrowserSession | null> {
      const db = this.getTenantDb();
      const payload: Partial<IBrowserSession> = {
        ...data,
        updatedAt: new Date(),
      };
      delete payload._id;
      delete payload.tenantId;
      delete payload.createdAt;

      const result = await db
        .collection<IBrowserSession>(COLLECTIONS.browserSessions)
        .findOneAndUpdate(
          { _id: objectId(id) },
          { $set: payload },
          { returnDocument: 'after' },
        );

      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IBrowserSession;
    }

    async deleteBrowserSession(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IBrowserSession>(COLLECTIONS.browserSessions)
        .deleteOne({ _id: objectId(id) });
      // Cascade-delete events
      await db
        .collection<IBrowserSessionEvent>(COLLECTIONS.browserSessionEvents)
        .deleteMany({ sessionId: id });
      return result.deletedCount > 0;
    }

    async findBrowserSessionById(id: string): Promise<IBrowserSession | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<IBrowserSession>(COLLECTIONS.browserSessions)
          .findOne({ _id: objectId(id) });
        if (!record) return null;
        return { ...record, _id: toId(record._id) } as IBrowserSession;
      } catch {
        return null;
      }
    }

    async findBrowserSessionByKey(
      tenantId: string,
      sessionKey: string,
      projectId?: string,
    ): Promise<IBrowserSession | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId, sessionKey };
      if (projectId) query.projectId = projectId;
      const record = await db
        .collection<IBrowserSession>(COLLECTIONS.browserSessions)
        .findOne(query);
      if (!record) return null;
      return { ...record, _id: toId(record._id) } as IBrowserSession;
    }

    async listBrowserSessions(
      tenantId: string,
      filters?: {
        projectId?: string;
        browserId?: string;
        agentId?: string;
        status?: string;
        search?: string;
        limit?: number;
      },
    ): Promise<IBrowserSession[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.browserId) query.browserId = filters.browserId;
      if (filters?.agentId) query.agentId = filters.agentId;
      if (filters?.status) query.status = filters.status;
      if (filters?.search) query.name = { $regex: filters.search, $options: 'i' };

      const cursor = db
        .collection<IBrowserSession>(COLLECTIONS.browserSessions)
        .find(query)
        .sort({ createdAt: -1 });

      if (filters?.limit && filters.limit > 0) {
        cursor.limit(filters.limit);
      }

      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IBrowserSession);
    }


    async createBrowserSessionEvent(
      record: Omit<IBrowserSessionEvent, '_id' | 'createdAt'>,
    ): Promise<IBrowserSessionEvent> {
      const db = this.getTenantDb();
      const doc: Omit<IBrowserSessionEvent, '_id'> = {
        ...record,
        createdAt: new Date(),
      };
      const result = await db
        .collection<IBrowserSessionEvent>(COLLECTIONS.browserSessionEvents)
        .insertOne(doc as unknown as IBrowserSessionEvent);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async listBrowserSessionEvents(
      sessionId: string,
      options?: { limit?: number; skip?: number },
    ): Promise<IBrowserSessionEvent[]> {
      const db = this.getTenantDb();
      const cursor = db
        .collection<IBrowserSessionEvent>(COLLECTIONS.browserSessionEvents)
        .find({ sessionId })
        .sort({ createdAt: 1 });
      if (options?.skip) cursor.skip(options.skip);
      if (options?.limit) cursor.limit(options.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IBrowserSessionEvent);
    }

    async countBrowserSessionEvents(sessionId: string): Promise<number> {
      const db = this.getTenantDb();
      return db
        .collection<IBrowserSessionEvent>(COLLECTIONS.browserSessionEvents)
        .countDocuments({ sessionId });
    }
  };
}
