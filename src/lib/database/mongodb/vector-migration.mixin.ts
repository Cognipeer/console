/**
 * MongoDB Provider – VectorMigration operations mixin
 *
 * Mirrors `sqlite/vector-migration.mixin.ts` so index migrations behave
 * identically on both backends. `key` is unique within a tenant database.
 */

import type { Filter } from 'mongodb';
import type {
  IVectorMigration,
  IVectorMigrationLog,
  IVectorMigrationRunSummary,
  VectorMigrationStatus,
  VectorMigrationLogStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

/** Fields a caller may clear by passing an explicit `undefined`. */
const NULLABLE_FIELDS: readonly string[] = [
  'description',
  'errorMessage',
  'startedAt',
  'completedAt',
];

const IMMUTABLE_FIELDS: readonly string[] = ['_id', 'tenantId', 'key', 'createdBy'];

export function VectorMigrationMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class VectorMigrationOps extends Base {
    async createVectorMigration(
      migration: Omit<IVectorMigration, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IVectorMigration> {
      const db = this.getTenantDb();
      const now = new Date();
      const document = { ...migration, createdAt: now, updatedAt: now };

      const result = await db
        .collection<IVectorMigration>(COLLECTIONS.vectorMigrations)
        .insertOne(document as unknown as IVectorMigration);

      return { ...document, _id: result.insertedId.toString() };
    }

    async updateVectorMigration(
      key: string,
      data: Partial<Omit<IVectorMigration, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IVectorMigration | null> {
      const db = this.getTenantDb();
      const set: Record<string, unknown> = { updatedAt: new Date() };
      const unset: Record<string, ''> = {};

      for (const [field, value] of Object.entries(data)) {
        if (IMMUTABLE_FIELDS.includes(field)) continue;
        if (value === undefined) {
          if (NULLABLE_FIELDS.includes(field)) unset[field] = '';
          continue;
        }
        set[field] = value;
      }

      const result = await db
        .collection<IVectorMigration>(COLLECTIONS.vectorMigrations)
        .findOneAndUpdate(
          { key } as Filter<IVectorMigration>,
          Object.keys(unset).length > 0 ? { $set: set, $unset: unset } : { $set: set },
          { returnDocument: 'after' },
        );

      return result ? { ...result, _id: result._id?.toString() } : null;
    }

    async deleteVectorMigration(key: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IVectorMigration>(COLLECTIONS.vectorMigrations)
        .deleteOne({ key } as Filter<IVectorMigration>);

      if (result.deletedCount > 0) {
        await db
          .collection<IVectorMigrationLog>(COLLECTIONS.vectorMigrationLogs)
          .deleteMany({ migrationKey: key } as Filter<IVectorMigrationLog>);
      }

      return result.deletedCount > 0;
    }

    async listVectorMigrations(filters?: {
      projectId?: string;
      status?: VectorMigrationStatus;
      statuses?: VectorMigrationStatus[];
    }): Promise<IVectorMigration[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};

      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.status) query.status = filters.status;
      if (filters?.statuses && filters.statuses.length > 0) {
        query.status = { $in: filters.statuses };
      }

      const migrations = await db
        .collection<IVectorMigration>(COLLECTIONS.vectorMigrations)
        .find(query as Filter<IVectorMigration>)
        .sort({ createdAt: -1 })
        .toArray();

      return migrations.map((migration) => ({ ...migration, _id: migration._id?.toString() }));
    }

    async findVectorMigrationByKey(key: string): Promise<IVectorMigration | null> {
      const db = this.getTenantDb();
      const migration = await db
        .collection<IVectorMigration>(COLLECTIONS.vectorMigrations)
        .findOne({ key } as Filter<IVectorMigration>);

      return migration ? { ...migration, _id: migration._id?.toString() } : null;
    }

    async createVectorMigrationLog(
      log: Omit<IVectorMigrationLog, '_id' | 'createdAt'>,
    ): Promise<IVectorMigrationLog> {
      const db = this.getTenantDb();
      const document = { ...log, createdAt: new Date() };

      const result = await db
        .collection<IVectorMigrationLog>(COLLECTIONS.vectorMigrationLogs)
        .insertOne(document as unknown as IVectorMigrationLog);

      return { ...document, _id: result.insertedId.toString() };
    }

    async listVectorMigrationLogs(
      migrationKey: string,
      options?: { limit?: number; offset?: number; attempt?: number },
    ): Promise<IVectorMigrationLog[]> {
      const db = this.getTenantDb();
      const logs = await db
        .collection<IVectorMigrationLog>(COLLECTIONS.vectorMigrationLogs)
        .find({
          migrationKey,
          ...(options?.attempt !== undefined ? { attempt: options.attempt } : {}),
        } as Filter<IVectorMigrationLog>)
        .sort({ attempt: -1, batchIndex: 1 })
        .skip(options?.offset ?? 0)
        .limit(options?.limit ?? 100)
        .toArray();

      return logs.map((log) => ({ ...log, _id: log._id?.toString() }));
    }

    async countVectorMigrationLogs(
      migrationKey: string,
      status?: VectorMigrationLogStatus,
      attempt?: number,
    ): Promise<number> {
      const db = this.getTenantDb();
      return db
        .collection<IVectorMigrationLog>(COLLECTIONS.vectorMigrationLogs)
        .countDocuments({
          migrationKey,
          ...(status ? { status } : {}),
          ...(attempt !== undefined ? { attempt } : {}),
        } as Filter<IVectorMigrationLog>);
    }

    async listVectorMigrationRuns(migrationKey: string): Promise<IVectorMigrationRunSummary[]> {
      const db = this.getTenantDb();
      const rows = await db
        .collection<IVectorMigrationLog>(COLLECTIONS.vectorMigrationLogs)
        .aggregate<{
          _id: number;
          batchCount: number;
          successBatches: number;
          failedBatches: number;
          skippedBatches: number;
          migratedCount: number;
          failedCount: number;
          startedAt: Date;
          endedAt: Date;
        }>([
          { $match: { migrationKey } },
          {
            $group: {
              _id: '$attempt',
              batchCount: { $sum: 1 },
              successBatches: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
              failedBatches: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
              skippedBatches: { $sum: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] } },
              migratedCount: { $sum: '$migratedCount' },
              failedCount: { $sum: '$failedCount' },
              startedAt: { $min: '$createdAt' },
              endedAt: { $max: '$createdAt' },
            },
          },
          { $sort: { _id: -1 } },
        ])
        .toArray();

      return rows.map((row) => ({
        attempt: row._id,
        batchCount: row.batchCount,
        successBatches: row.successBatches,
        failedBatches: row.failedBatches,
        skippedBatches: row.skippedBatches,
        migratedCount: row.migratedCount,
        failedCount: row.failedCount,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
      }));
    }
  };
}
