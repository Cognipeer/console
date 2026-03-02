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
 * Get (or lazily initialise) the global database provider instance.
 *
 * ## Concurrency model
 *
 * The gateway uses a **singleton provider** pattern:
 * - A single `DatabaseProvider` instance is created on first call and reused
 *   for the lifetime of the process.
 * - For tenant-scoped operations (users, tokens, projects, etc.) callers must
 *   invoke `switchToTenant(tenantDbName)` **before** issuing queries. The
 *   switch is synchronous and sets the provider's active database context.
 *
 * ### Important caveats
 *
 * 1. **Request isolation** – Because Next.js processes requests concurrently
 *    within a single Node.js process, two requests that call `switchToTenant`
 *    with different tenants could interleave. This is safe because each
 *    `switchToTenant` call only sets the *current* database reference and all
 *    subsequent operations stay on that reference until the next switch.
 *    Always pair `getDatabase() → switchToTenant() → queries` without yielding
 *    control between the switch and the queries wherever possible.
 *
 * 2. **Singleton lifecycle** – The provider is torn down by the registered
 *    shutdown handler (`registerShutdownHandler`). Tests should call
 *    `disconnectDatabase()` in their teardown to release resources.
 *
 * 3. **Provider selection** – Determined by `DB_PROVIDER` env var (`sqlite` or
 *    `mongodb`). SQLite is the default for self-hosted / on-prem setups.
 *
 * @returns The shared `DatabaseProvider` instance.
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
  IConfigGroup,
  IConfigItem,
  IConfigAuditLog,
  ConfigValueType,
} from './provider.interface';
