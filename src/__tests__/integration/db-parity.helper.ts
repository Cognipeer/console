/**
 * DB parity helper: run the SAME test suite against both SQLite and MongoDB.
 *
 * Why: SQLite and MongoDB provider mixins are independently implemented.
 * A test that passes on SQLite but never hits MongoDB hides drift that only
 * surfaces in production. This helper lets a test file declare the contract
 * once and run it twice.
 *
 * Usage in a test file:
 *
 *   import { describeForEachProvider } from './db-parity.helper';
 *
 *   describeForEachProvider('User CRUD', (getDb) => {
 *     it('creates and finds a user', async () => {
 *       const db = getDb();
 *       const user = await db.createUser({ email: '...', tenantId: '...' });
 *       expect(await db.findUserById(user._id!)).toMatchObject({ email: '...' });
 *     });
 *   });
 *
 * Skipping MongoDB locally:
 *   PARITY_SKIP_MONGODB=1 npm test
 *
 * MongoDB requires `mongodb-memory-server`. Install it as a dev dep:
 *   npm install -D mongodb-memory-server
 * The helper warns and falls back to SQLite-only if the package is missing.
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseProvider } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';

/** Synchronously check whether mongodb-memory-server is installed. */
const MONGO_AVAILABLE: boolean = (() => {
  try {
    createRequire(import.meta.url).resolve('mongodb-memory-server');
    return true;
  } catch {
    return false;
  }
})();

type ProviderKind = 'sqlite' | 'mongodb';

type ProviderHandle = {
  kind: ProviderKind;
  getDb: () => DatabaseProvider;
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
};

function makeSqliteHandle(): ProviderHandle {
  let db: SQLiteProvider | null = null;
  let tmpDir = '';
  return {
    kind: 'sqlite',
    getDb: () => {
      if (!db) throw new Error('SQLite provider not initialized — call setup() first');
      return db;
    },
    setup: async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-parity-sqlite-'));
      db = new SQLiteProvider(tmpDir, 'parity_main');
      await db.connect();
    },
    teardown: async () => {
      await db?.disconnect();
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      db = null;
    },
  };
}

type MongoMemoryServerLike = {
  getUri(): string;
  stop(): Promise<void>;
};

async function makeMongoHandle(): Promise<ProviderHandle | null> {
  // Lazy-import via dynamic string so projects without mongodb-memory-server
  // installed do not need its types either (it's a peer/optional dep).
  let MongoMemoryServerCtor: { create(): Promise<MongoMemoryServerLike> };
  try {
    const moduleName = 'mongodb-memory-server';
    // The string indirection prevents TS from trying to resolve the type.
    const mod = (await import(/* @vite-ignore */ moduleName)) as {
      MongoMemoryServer: { create(): Promise<MongoMemoryServerLike> };
    };
    MongoMemoryServerCtor = mod.MongoMemoryServer;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      '[db-parity] mongodb-memory-server not installed — skipping MongoDB parity. ' +
        'Install with: npm install -D mongodb-memory-server',
    );
    return null;
  }

  let server: MongoMemoryServerLike | null = null;
  let db: MongoDBProvider | null = null;
  return {
    kind: 'mongodb',
    getDb: () => {
      if (!db) throw new Error('MongoDB provider not initialized — call setup() first');
      return db;
    },
    setup: async () => {
      server = await MongoMemoryServerCtor.create();
      db = new MongoDBProvider(server.getUri(), 'parity_main', {
        minPoolSize: 1,
        maxPoolSize: 5,
        connectTimeoutMS: 5000,
        socketTimeoutMS: 10000,
        serverSelectionTimeoutMS: 5000,
      });
      await db.connect();
    },
    teardown: async () => {
      await db?.disconnect();
      await server?.stop();
      db = null;
      server = null;
    },
  };
}

/**
 * Run `body` once per provider. Each provider gets its own setup/teardown
 * lifecycle and a stable `getDb()` accessor inside the body.
 *
 * Filtering:
 *   - PARITY_SKIP_MONGODB=1  → SQLite only
 *   - PARITY_SKIP_SQLITE=1   → MongoDB only (rare, but useful when debugging)
 */
export function describeForEachProvider(
  label: string,
  body: (getDb: () => DatabaseProvider) => void,
): void {
  const kinds: ProviderKind[] = [];
  if (!process.env.PARITY_SKIP_SQLITE) kinds.push('sqlite');
  if (!process.env.PARITY_SKIP_MONGODB && MONGO_AVAILABLE) kinds.push('mongodb');

  if (kinds.length === 0) {
    describe.skip(`${label} (no parity providers enabled)`, () => {
      // nothing
    });
    return;
  }

  if (!MONGO_AVAILABLE && !process.env.PARITY_SKIP_MONGODB) {
    // Surface a single skipped describe so the user knows why MongoDB didn't
    // run, without spamming a fail per test.
    describe(`${label} [mongodb]`, () => {
      it.skip('mongodb-memory-server not installed — `npm install -D mongodb-memory-server` to enable parity', () => {
        // noop
      });
    });
  }

  describe.each(kinds)(`${label} [%s]`, (kind) => {
    let handle: ProviderHandle | null = null;

    beforeAll(async () => {
      if (kind === 'sqlite') handle = makeSqliteHandle();
      else handle = await makeMongoHandle();
      if (handle) await handle.setup();
    });

    afterAll(async () => {
      await handle?.teardown();
    });

    body(() => {
      if (!handle) {
        throw new Error(
          `[${kind}] provider unavailable — setup failed or package missing.`,
        );
      }
      return handle.getDb();
    });
  });
}
