import { DatabaseProvider } from './provider.interface';
import { MongoDBProvider } from './mongodb.provider';

let dbProvider: DatabaseProvider | null = null;

/**
 * Get database instance. For multi-tenant operations, call switchToTenant() after getting the instance.
 * The main database is used by default (for tenant management).
 */
export async function getDatabase(): Promise<DatabaseProvider> {
  if (dbProvider) {
    return dbProvider;
  }

  const mongoUri = process.env.MONGODB_URI;
  const mainDbName = process.env.MAIN_DB_NAME || 'cgate_main';

  if (!mongoUri) {
    throw new Error('MONGODB_URI environment variable is not set');
  }

  // Initialize MongoDB provider with main database
  dbProvider = new MongoDBProvider(mongoUri, mainDbName);
  await dbProvider.connect();

  return dbProvider;
}

/**
 * Get database instance for a specific tenant.
 * This is a convenience function that gets the database and switches to the tenant.
 */
export async function getTenantDatabase(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export async function disconnectDatabase(): Promise<void> {
  if (dbProvider) {
    await dbProvider.disconnect();
    dbProvider = null;
  }
}

// Export the provider interface for type safety
export type { DatabaseProvider } from './provider.interface';
export type { IUser, ITenant, IApiToken, IAgentTracingSession, IAgentTracingEvent } from './provider.interface';
