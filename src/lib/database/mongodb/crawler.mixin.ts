/**
 * MongoDB Provider – Crawlers, Crawl jobs & results mixin
 */

import { ObjectId } from 'mongodb';
import type {
  ICrawler,
  ICrawlJob,
  ICrawlResult,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';
import { getThisNodeIdentity } from '@/lib/core/nodeIdentity';

function toId(value: ObjectId | string | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : value.toString();
}

function objectId(id: string): ObjectId {
  return new ObjectId(id);
}

export function CrawlerMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class CrawlerOps extends Base {
    // ── Crawlers ─────────────────────────────────────────────────────
    async createCrawler(
      record: Omit<ICrawler, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ICrawler> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc: Omit<ICrawler, '_id'> = { ...record, createdAt: now, updatedAt: now };
      const result = await db
        .collection<ICrawler>(COLLECTIONS.crawlers)
        .insertOne(doc as unknown as ICrawler);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateCrawler(
      id: string,
      data: Partial<Omit<ICrawler, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<ICrawler | null> {
      const db = this.getTenantDb();
      const payload: Partial<ICrawler> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.createdAt;
      const result = await db
        .collection<ICrawler>(COLLECTIONS.crawlers)
        .findOneAndUpdate(
          { _id: objectId(id) },
          { $set: payload },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as ICrawler;
    }

    async deleteCrawler(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const crawler = await db
        .collection<ICrawler>(COLLECTIONS.crawlers)
        .findOne({ _id: objectId(id) });
      const result = await db
        .collection<ICrawler>(COLLECTIONS.crawlers)
        .deleteOne({ _id: objectId(id) });
      if (crawler) {
        await db.collection<ICrawlJob>(COLLECTIONS.crawlJobs)
          .deleteMany({ crawlerKey: crawler.key, tenantId: crawler.tenantId });
        await db.collection<ICrawlResult>(COLLECTIONS.crawlResults)
          .deleteMany({ crawlerKey: crawler.key, tenantId: crawler.tenantId });
      }
      return result.deletedCount > 0;
    }

    async findCrawlerById(id: string): Promise<ICrawler | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<ICrawler>(COLLECTIONS.crawlers)
          .findOne({ _id: objectId(id) });
        if (!record) return null;
        return { ...record, _id: toId(record._id) } as ICrawler;
      } catch {
        return null;
      }
    }

    async findCrawlerByKey(
      tenantId: string,
      key: string,
      projectId?: string,
    ): Promise<ICrawler | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId, key };
      if (projectId) query.projectId = projectId;
      const record = await db.collection<ICrawler>(COLLECTIONS.crawlers).findOne(query);
      if (!record) return null;
      return { ...record, _id: toId(record._id) } as ICrawler;
    }

    async listCrawlers(
      tenantId: string,
      filters?: { projectId?: string; status?: string; search?: string },
    ): Promise<ICrawler[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.status) query.status = filters.status;
      if (filters?.search) query.name = { $regex: filters.search, $options: 'i' };
      const docs = await db
        .collection<ICrawler>(COLLECTIONS.crawlers)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as ICrawler);
    }

    // ── Crawl jobs ───────────────────────────────────────────────────
    async createCrawlJob(
      record: Omit<ICrawlJob, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ICrawlJob> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc: Omit<ICrawlJob, '_id'> = { ...record, createdAt: now, updatedAt: now };
      const result = await db
        .collection<ICrawlJob>(COLLECTIONS.crawlJobs)
        .insertOne(doc as unknown as ICrawlJob);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateCrawlJob(
      id: string,
      data: Partial<Omit<ICrawlJob, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<ICrawlJob | null> {
      const db = this.getTenantDb();
      const payload: Partial<ICrawlJob> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.createdAt;
      const result = await db
        .collection<ICrawlJob>(COLLECTIONS.crawlJobs)
        .findOneAndUpdate(
          { _id: objectId(id) },
          { $set: payload },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as ICrawlJob;
    }

    async claimCrawlJob(id: string, tenantId: string, startedAt: Date): Promise<ICrawlJob | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection<ICrawlJob>(COLLECTIONS.crawlJobs)
        .findOneAndUpdate(
          { _id: objectId(id), tenantId, status: 'queued' },
          {
            $set: {
              status: 'running',
              startedAt,
              updatedAt: new Date(),
              nodeId: getThisNodeIdentity(),
            },
          },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as ICrawlJob;
    }

    async requestCrawlJobCancel(id: string, tenantId: string): Promise<ICrawlJob | null> {
      const db = this.getTenantDb();
      const now = new Date();
      // Fast path: job hasn't started yet, cancel it outright.
      const queuedResult = await db
        .collection<ICrawlJob>(COLLECTIONS.crawlJobs)
        .findOneAndUpdate(
          { _id: objectId(id), tenantId, status: 'queued' },
          { $set: { status: 'canceled', endedAt: now, updatedAt: now } },
          { returnDocument: 'after' },
        );
      if (queuedResult) {
        return { ...queuedResult, _id: toId(queuedResult._id) } as ICrawlJob;
      }
      // Already running (possibly on another node) — stamp the request so
      // the owning runner observes it on its next DB round trip.
      const runningResult = await db
        .collection<ICrawlJob>(COLLECTIONS.crawlJobs)
        .findOneAndUpdate(
          { _id: objectId(id), tenantId, status: 'running' },
          { $set: { cancelRequestedAt: now, updatedAt: now } },
          { returnDocument: 'after' },
        );
      if (!runningResult) return null;
      return { ...runningResult, _id: toId(runningResult._id) } as ICrawlJob;
    }

    async finalizeCrawlJob(
      id: string,
      tenantId: string,
      data: Partial<Omit<ICrawlJob, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<ICrawlJob | null> {
      const db = this.getTenantDb();
      const payload: Partial<ICrawlJob> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.createdAt;
      const result = await db
        .collection<ICrawlJob>(COLLECTIONS.crawlJobs)
        .findOneAndUpdate(
          { _id: objectId(id), tenantId, status: 'running' },
          { $set: payload },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as ICrawlJob;
    }

    async findCrawlJobById(id: string): Promise<ICrawlJob | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<ICrawlJob>(COLLECTIONS.crawlJobs)
          .findOne({ _id: objectId(id) });
        if (!record) return null;
        return { ...record, _id: toId(record._id) } as ICrawlJob;
      } catch {
        return null;
      }
    }

    async listCrawlJobs(
      tenantId: string,
      filters?: {
        projectId?: string;
        crawlerKey?: string;
        status?: string;
        limit?: number;
      },
    ): Promise<ICrawlJob[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.crawlerKey) query.crawlerKey = filters.crawlerKey;
      if (filters?.status) query.status = filters.status;
      const cursor = db
        .collection<ICrawlJob>(COLLECTIONS.crawlJobs)
        .find(query)
        .sort({ createdAt: -1 });
      if (filters?.limit && filters.limit > 0) cursor.limit(filters.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as ICrawlJob);
    }

    // ── Crawl results ────────────────────────────────────────────────
    async createCrawlResult(
      record: Omit<ICrawlResult, '_id' | 'createdAt'>,
    ): Promise<ICrawlResult> {
      const db = this.getTenantDb();
      const doc: Omit<ICrawlResult, '_id'> = { ...record, createdAt: new Date() };
      const result = await db
        .collection<ICrawlResult>(COLLECTIONS.crawlResults)
        .insertOne(doc as unknown as ICrawlResult);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async listCrawlResults(
      jobId: string,
      options?: { limit?: number; skip?: number; type?: string },
    ): Promise<ICrawlResult[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { jobId };
      if (options?.type) query.type = options.type;
      const cursor = db
        .collection<ICrawlResult>(COLLECTIONS.crawlResults)
        .find(query)
        .sort({ createdAt: 1 });
      if (options?.skip) cursor.skip(options.skip);
      if (options?.limit) cursor.limit(options.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as ICrawlResult);
    }

    async findCrawlResultById(id: string): Promise<ICrawlResult | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<ICrawlResult>(COLLECTIONS.crawlResults)
          .findOne({ _id: objectId(id) });
        if (!record) return null;
        return { ...record, _id: toId(record._id) } as ICrawlResult;
      } catch {
        return null;
      }
    }

    async countCrawlResults(jobId: string): Promise<number> {
      const db = this.getTenantDb();
      return db
        .collection<ICrawlResult>(COLLECTIONS.crawlResults)
        .countDocuments({ jobId });
    }
  };
}
