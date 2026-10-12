/**
 * Global test setup — runs before every test file.
 * Provides the environment variables that application code reads at module load time.
 */

import { beforeEach } from 'vitest';
import { invalidateTenantPrincipals } from '@/lib/iam/events';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';

// Database provider — default to mongodb for existing tests
process.env.DB_PROVIDER = process.env.DB_PROVIDER || 'mongodb';

// Required by src/lib/database/index.ts (when DB_PROVIDER=mongodb)
process.env.MONGODB_URI = 'mongodb://localhost:27017';
process.env.MAIN_DB_NAME = 'test_console_main';

// Required by src/lib/license/* and JWT helpers
process.env.JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars!!';

// Silence noisy console output in tests unless DEBUG=1
if (!process.env.DEBUG) {
  globalThis.console.debug = () => {};
}

beforeEach(() => {
  resetRateLimitStore();
  // Every request is decided by the authorization engine, which keeps each
  // caller's groups and project assignments for a few seconds. Suites reuse the
  // same tenant and user ids with different fixtures from one test to the next,
  // so each test starts with an empty principal cache. (events.ts has no imports
  // on purpose: pulling it in here does not load the database layer before a
  // suite's own vi.mock calls are registered.)
  invalidateTenantPrincipals(null);
});
