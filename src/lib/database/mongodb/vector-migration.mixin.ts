/**
 * MongoDB Provider – VectorMigration operations mixin (stub)
 *
 * Vector migration tracking is implemented for the SQLite provider.
 * This stub satisfies the DatabaseProvider interface for MongoDB deployments.
 */

import type {
  IVectorMigration,
  IVectorMigrationLog,
  VectorMigrationStatus,
  VectorMigrationLogStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase } from './base';

export function VectorMigrationMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class VectorMigrationOps extends Base {
    async createVectorMigration(
      _migration: Omit<IVectorMigration, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IVectorMigration> {
      throw new Error('Vector migrations are not supported by the MongoDB provider');
    }

    async updateVectorMigration(
      _key: string,
      _data: Partial<Omit<IVectorMigration, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IVectorMigration | null> {
      throw new Error('Vector migrations are not supported by the MongoDB provider');
    }

    async deleteVectorMigration(_key: string): Promise<boolean> {
      throw new Error('Vector migrations are not supported by the MongoDB provider');
    }

    async listVectorMigrations(
      _filters?: { projectId?: string; status?: VectorMigrationStatus },
    ): Promise<IVectorMigration[]> {
      return [];
    }

    async findVectorMigrationByKey(_key: string): Promise<IVectorMigration | null> {
      return null;
    }

    async createVectorMigrationLog(
      _log: Omit<IVectorMigrationLog, '_id' | 'createdAt'>,
    ): Promise<IVectorMigrationLog> {
      throw new Error('Vector migrations are not supported by the MongoDB provider');
    }

    async listVectorMigrationLogs(
      _migrationKey: string,
      _options?: { limit?: number; offset?: number },
    ): Promise<IVectorMigrationLog[]> {
      return [];
    }

    async countVectorMigrationLogs(
      _migrationKey: string,
      _status?: VectorMigrationLogStatus,
    ): Promise<number> {
      return 0;
    }
  };
}
