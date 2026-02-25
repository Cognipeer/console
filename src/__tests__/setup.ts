/**
 * Global test setup — runs before every test file.
 * Provides the environment variables that application code reads at module load time.
 */

// Required by src/lib/database/index.ts
process.env.MONGODB_URI = 'mongodb://localhost:27017';
process.env.MAIN_DB_NAME = 'test_console_main';

// Required by src/lib/license/* and JWT helpers
process.env.JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars!!';

// Silence noisy console output in tests unless DEBUG=1
if (!process.env.DEBUG) {
  globalThis.console.debug = () => {};
}
