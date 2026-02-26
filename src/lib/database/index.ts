import { DatabaseProvider } from './provider.interface';
import { MongoDBProvider } from './mongodb.provider';
import { SQLiteProvider } from './sqlite.provider';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { registerShutdownHandler } from '@/lib/core/lifecycle';
import { registerHealthCheck } from '@/lib/core/health';

const log = createLogger('database');

let dbProvider: DatabaseProvider | null = null;

/**
 * Get database instance. For multi-tenant operations, call switchToTenant() after getting the instance.
 * The main database is used by default (for tenant management).
 */
export async function getDatabase(): Promise<DatabaseProvider> {
  if (dbProvider) {
    return dbProvider;
  }

  const cfg = getConfig();

  if (cfg.database.provider === 'sqlite') {
    // ── SQLite provider ──────────────────────────────────────────────
    const provider = new SQLiteProvider(cfg.database.dataDir, cfg.database.mainDbName);
    await provider.connect();
    dbProvider = provider;
    log.info('SQLite connected successfully', { dataDir: cfg.database.dataDir });

    // Register health check
    registerHealthCheck('sqlite', async () => {
      try {
        // Simple liveness check – run a trivial query
        const mainDb = (provider as SQLiteProvider).getMainDbHandle();
        if (!mainDb) return { status: 'down', message: 'No database handle' };
        mainDb.prepare('SELECT 1').get();
        return { status: 'ok' };
      } catch (error) {
        return { status: 'down', message: error instanceof Error ? error.message : String(error) };
      }
    });
  } else {
    // ── MongoDB provider (default) ───────────────────────────────────
    if (!cfg.database.uri) {
      throw new Error('MONGODB_URI environment variable is not set');
    }

    const provider = new MongoDBProvider(cfg.database.uri, cfg.database.mainDbName, {
      minPoolSize: cfg.database.minPoolSize,
      maxPoolSize: cfg.database.maxPoolSize,
      connectTimeoutMS: cfg.database.connectTimeoutMs,
      socketTimeoutMS: cfg.database.socketTimeoutMs,
      serverSelectionTimeoutMS: cfg.database.serverSelectionTimeoutMs,
    });
    await provider.connect();
    dbProvider = provider;
    log.info('MongoDB connected successfully');

    // Register health check
    registerHealthCheck('mongodb', async () => {
      try {
        const client = (provider as MongoDBProvider).getClient();
        if (!client) return { status: 'down', message: 'No client' };
        await client.db('admin').command({ ping: 1 });
        return { status: 'ok' };
      } catch (error) {
        return { status: 'down', message: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  // Register shutdown handler
  registerShutdownHandler('database', async () => {
    await disconnectDatabase();
  });

  return dbProvider;
}

/**
 * Get database instance for a specific tenant.
 * This is a convenience function that gets the database and switches to the tenant.
 */
export async function getTenantDatabase(
  tenantDbName: string,
): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export async function disconnectDatabase(): Promise<void> {
  if (dbProvider) {
    await dbProvider.disconnect();
    dbProvider = null;
    log.info('Database disconnected');
  }
}

// Export the provider interface for type safety
export type { DatabaseProvider } from './provider.interface';
export type {
  IUser,
  ITenant,
  IProject,
  IApiToken,
  IAgentTracingSession,
  IAgentTracingEvent,
  IModel,
  IModelUsageLog,
  IModelUsageAggregate,
  ModelCategory,
  ModelProviderType,
  IModelPricing,
  IModelUsageCostSnapshot,
  ISemanticCacheConfig,
  ITenantUserDirectoryEntry,
  ProviderDomain,
  IProviderRecord,
  IVectorIndexRecord,
  IFileBucketRecord,
  IFileRecord,
  FileMarkdownStatus,
  IPrompt,
  IPromptVersion,
  IPromptComment,
  IQuotaPolicy,
  InferenceServerType,
  IInferenceServer,
  IInferenceServerMetrics,
  IGuardrail,
  GuardrailType,
  GuardrailAction,
  GuardrailTarget,
  IGuardrailPresetPolicy,
  IGuardrailPiiPolicy,
  IGuardrailModerationPolicy,
  IGuardrailPromptShieldPolicy,
  IGuardrailEvaluationLog,
  IGuardrailEvalAggregate,
  IAlertRule,
  IAlertEvent,
  AlertMetric,
  AlertModule,
  AlertConditionOperator,
  IAlertCondition,
  IAlertChannel,
  AlertEventStatus,
  IRagModule,
  IRagDocument,
  IRagChunk,
  IRagQueryLog,
  RagChunkStrategy,
  IRagChunkConfig,
  RagDocumentStatus,
  IMemoryStore,
  IMemoryStoreConfig,
  IMemoryItem,
  MemoryScope,
  MemorySource,
  MemoryStoreStatus,
  MemoryItemStatus,
} from './provider.interface';
