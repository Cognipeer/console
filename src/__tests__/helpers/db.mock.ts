/**
 * TS-driven mock factory for DatabaseProvider.
 *
 * Why a Proxy? `DatabaseProvider` has ~150+ methods spread across mixins.
 * Hand-rolled mocks drift the moment a new method is added — the test won't
 * fail at compile time, it'll throw "x is not a function" or 500 at runtime,
 * and the failing test message doesn't point to the real cause.
 *
 * This factory returns a Proxy that:
 *   - Auto-generates `vi.fn().mockResolvedValue(undefined)` for any property
 *     access that isn't explicitly primed.
 *   - Lets tests override individual methods via `overrides` or assign after
 *     creation (`db.findUserById.mockResolvedValue(...)`).
 *   - Keeps the same `Mocked<DatabaseProvider>` type so `db.foo.mockReturnValue`
 *     still type-checks.
 *   - Pre-primes a small set of "common defaults" that many tests rely on
 *     (createTenant, createUser, etc.) — these are kept identical to the
 *     legacy hand-written mock to preserve existing test behavior.
 *
 * Usage:
 *   vi.mock('@/lib/database', () => {
 *     const getDatabase = vi.fn();
 *     return {
 *       getDatabase,
 *       // the request gates read the caller (and the engine its policies) through the tenant scope
 *       runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
 *     };
 *   });
 *   const db = createMockDb();
 *   (getDatabase as Mock).mockResolvedValue(db);
 *
 *   // Override per test:
 *   db.findUserById.mockResolvedValue(someUser);
 *
 * Every request of every workspace is decided by the authorization engine, so a
 * suite that drives a gated route (withApiRequestContext / withClientApiRequestContext)
 * needs more than `getDatabase`: the gate and the engine read the user row, the
 * groups, the project assignments and the policy version through
 * `runWithTenantScope` - never through the bare `switchToTenant`. `vi.mock`
 * factories run before any import, so the scope function is written inline in the
 * suite's factory (a sync factory on purpose: see the notes in the suites that
 * mock more of the database layer). With the Proxy below behind `getDatabase`
 * every read the engine makes has a default (no groups, no projects, no stored
 * policies), so the caller is decided by the user row the suite serves from
 * `findUserById` (a session) or by the token context it mocks (a token).
 *
 * Two more rules for a suite that drives a gated route:
 *   - do not replace `@/lib/security/rbac` with a factory of a few functions: the
 *     route declarations and the engine's schema read `RBAC_SERVICE_DEFINITIONS`
 *     and friends from it, so the modules fail to load. The gate no longer asks
 *     rbac.ts for a verdict anyway - give the suite a caller (a user row, a token
 *     owner) whose role and permissions produce the verdict it wants.
 *   - an ad-hoc test route has to say how it is authorized, like every real one:
 *     `{ config: authz.authenticated() }` (or `authz.service('models')`, ...), or a
 *     path under a ROUTE_PREFIXES entry. A route that declares nothing is refused
 *     with 403 `route_not_declared`.
 */

import { vi, type Mock, type Mocked } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { hashApiToken } from '@/lib/services/apiTokens/tokenHashing';

export type MockDb = Mocked<DatabaseProvider>;

/**
 * Choose a default resolved value for an un-primed method based on its name.
 * Keeps tests reading naturally: `list*` returns `[]`, `find*` returns `null`,
 * `count*` returns `0`, `delete*` returns `true`. Anything else → `undefined`.
 *
 * For paginated lists (`list*` that wrap `{ items, total }`), the auto default
 * is still `[]` — tests that need the wrapped shape must prime it via the
 * primers map below.
 */
function defaultReturnFor(method: string): unknown {
  if (method.startsWith('list')) return [];
  if (method.startsWith('find')) return null;
  if (method.startsWith('count')) return 0;
  if (method.startsWith('exists')) return false;
  if (method.startsWith('delete')) return true;
  return undefined;
}

/**
 * Methods that need non-undefined defaults to keep existing tests green.
 * Add a primer here only when many tests need the same non-trivial return value.
 * Per-test setup should still prefer `db.xxx.mockResolvedValue(...)`.
 */
function buildPrimers(): Record<string, Mock> {
  return {
    // Connection
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),

    // Tenant ops
    createTenant: vi.fn().mockResolvedValue({
      _id: 'tenant-1',
      slug: 'acme',
      dbName: 'tenant_acme',
      licenseType: 'FREE',
      companyName: 'Acme',
    }),
    findTenantBySlug: vi.fn().mockResolvedValue(null),
    findTenantById: vi.fn().mockResolvedValue(null),
    listTenants: vi.fn().mockResolvedValue([]),
    updateTenant: vi.fn().mockResolvedValue(null),
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    // Passthrough so handlers wrapped in runWithTenant actually execute (the
    // real impl binds the tenant scope then invokes fn). Without this primer
    // the Proxy auto-mock would return a no-op fn that never calls fn(),
    // leaving the handler unrun and the route returning an empty 200.
    runWithTenant: vi.fn(<T>(_tenantDbName: string, fn: () => T | Promise<T>) => fn()),

    // Cross-tenant user directory
    registerUserInDirectory: vi.fn().mockResolvedValue(undefined),
    unregisterUserFromDirectory: vi.fn().mockResolvedValue(undefined),
    listTenantsForUser: vi.fn().mockResolvedValue([]),

    // User
    findUserByEmail: vi.fn().mockResolvedValue(null),
    findUserById: vi.fn().mockResolvedValue(null),
    findUserByExternalId: vi.fn().mockResolvedValue(null),
    createUser: vi.fn().mockResolvedValue({ _id: 'user-1', email: 'test@example.com' }),
    listUsers: vi.fn().mockResolvedValue([]),
    deleteUser: vi.fn().mockResolvedValue(true),
    updateUser: vi.fn().mockResolvedValue(null),

    // Project
    createProject: vi.fn().mockResolvedValue({
      _id: 'proj-1',
      key: 'default',
      name: 'Default Project',
      tenantId: 'tenant-1',
      createdBy: 'user-1',
    }),
    findProjectById: vi.fn().mockResolvedValue(null),
    findProjectByKey: vi.fn().mockResolvedValue(null),
    listProjects: vi.fn().mockResolvedValue([]),
    updateProject: vi.fn().mockResolvedValue(null),
    deleteProject: vi.fn().mockResolvedValue(true),

    // UserProject (new: project-based RBAC)
    findUserProject: vi.fn().mockResolvedValue(null),
    listUserProjectsByUser: vi.fn().mockResolvedValue([]),
    listUserProjectsByProject: vi.fn().mockResolvedValue([]),
    upsertUserProject: vi.fn().mockResolvedValue({}),
    deleteUserProject: vi.fn().mockResolvedValue(true),
    deleteUserProjectsByProject: vi.fn().mockResolvedValue(undefined),
    deleteUserProjectsByUser: vi.fn().mockResolvedValue(undefined),

    // IAM documents (policies, policy version, project-level activation instant).
    // The authorization engine decides every request, so it reads these on the
    // request path: nothing stored means "no custom policies, activation now".
    iamDocGet: vi.fn().mockResolvedValue(null),
    iamDocPut: vi.fn().mockResolvedValue(undefined),
    iamDocList: vi.fn().mockResolvedValue([]),
    iamDocDelete: vi.fn().mockResolvedValue(true),
    iamDocIncrement: vi.fn().mockResolvedValue(1),

    // Groups (stubbed but interface-present)
    listGroups: vi.fn().mockResolvedValue([]),
    addGroupMember: vi.fn().mockResolvedValue({}),
    removeGroupMember: vi.fn().mockResolvedValue(true),
    listGroupMembers: vi.fn().mockResolvedValue([]),
    listGroupMembersByUser: vi.fn().mockResolvedValue([]),
    upsertGroupProject: vi.fn().mockResolvedValue({}),
    removeGroupProject: vi.fn().mockResolvedValue(true),
    listGroupProjectsByProject: vi.fn().mockResolvedValue([]),

    // RAG (non-empty defaults — many tests assume these shapes)
    createRagModule: vi.fn().mockResolvedValue({
      _id: 'ragmod-1',
      key: 'mod-key',
      status: 'active',
      totalDocuments: 0,
      totalChunks: 0,
    }),
    createRagDocument: vi.fn().mockResolvedValue({
      _id: 'ragdoc-1',
      status: 'processing',
      chunkCount: 0,
    }),
    bulkInsertRagChunks: vi.fn().mockResolvedValue(undefined),

    // Agent tracing dashboard (callers rely on the nested shape)
    aggregateAgentTracingDashboard: vi.fn().mockResolvedValue({
      recentSessions: [],
      recentAgents: [],
      recentAgentsTotal: 0,
      analytics: {
        totals: {
          sessionsCount: 0,
          totalEvents: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCachedInputTokens: 0,
          totalTokens: 0,
          totalDurationMs: 0,
          averageInputTokensPerSession: 0,
          averageOutputTokensPerSession: 0,
          averageCachedInputTokensPerSession: 0,
          averageTokensPerSession: 0,
          averageDurationMs: 0,
        },
        tools: { totals: { totalCalls: 0, errorCalls: 0, successCalls: 0, errorRate: 0 }, items: [] },
        statuses: [],
        models: [],
        agents: [],
        daily: [],
      },
    }),
    listAgentTracingSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
    listAgentTracingThreads: vi.fn().mockResolvedValue({ threads: [], total: 0 }),

    // Paginated list endpoints — many APIs return { items, total }
    listFileRecords: vi.fn().mockResolvedValue({ records: [], total: 0 }),
    listGuardrailEvaluations: vi.fn().mockResolvedValue({ evaluations: [], total: 0 }),
    listMemoryEntries: vi.fn().mockResolvedValue({ entries: [], total: 0 }),

    // Counters
    countAgentTracingDistinctAgents: vi.fn().mockResolvedValue(0),
    countFileRecordsByBucket: vi.fn().mockResolvedValue(0),
    countActiveAlerts: vi.fn().mockResolvedValue(0),
    cleanupAgentTracingRetention: vi.fn().mockResolvedValue({ sessionsDeleted: 0, eventsDeleted: 0 }),
    agentTracingAgentExists: vi.fn().mockResolvedValue(false),
    // A transcript lookup answers the sessions it matched (never null).
    findAgentConversationsByTranscriptHash: vi.fn().mockResolvedValue([]),

    // Entity health rollup, alert state and stale-session finalizer
    // (`list*` / `find*` already default to [] / null; these have shaped returns).
    aggregateEntityMetrics: vi.fn().mockResolvedValue([]),
    purgeEntityMetrics: vi.fn().mockResolvedValue(0),
    abandonAgentTracingSession: vi.fn().mockResolvedValue(null),
    listIncidentStatRows: vi.fn().mockResolvedValue([]),
    countIncidentsByStatus: vi.fn().mockResolvedValue({
      open: 0,
      acknowledged: 0,
      investigating: 0,
      resolved: 0,
      closed: 0,
    }),

    // Semantic cache config
    getSemanticCacheConfig: vi.fn().mockResolvedValue(null),

    // Agent runs (background execution) — createResponsesHandler now
    // unconditionally reserves a `mode: 'sync'` AgentRun row for every
    // /responses call (§5/§12.14), so ANY test exercising that route needs
    // a plausible (not undefined) return here, not only tests that care
    // about background execution specifically. A real provider always sets
    // `_id`; auto-generate one so `reservation._id` never crashes a caller
    // that doesn't override this.
    createAgentRun: vi.fn((record: Record<string, unknown>) => Promise.resolve({
      _id: `mock-agent-run-${Math.random().toString(36).slice(2, 10)}`,
      ...record,
    })),
    // Lookups a real provider answers with `null` when nothing matches (the
    // name-based default would be `undefined`). `listAgentRuns`,
    // `listQueuedAgentRuns`, `countActiveAgentRuns` and `deleteAgentRun`
    // already get `[]` / `0` / `true` from `defaultReturnFor`.
    getAgentRunById: vi.fn().mockResolvedValue(null),
    getAgentRunByIdempotencyKey: vi.fn().mockResolvedValue(null),
    // Shapes the name-based default would get wrong (a record, not a number / undefined).
    countAgentRunsByStatus: vi.fn().mockResolvedValue({}),
    promoteScheduledAgentRun: vi.fn().mockResolvedValue(null),
    markAgentRunDetached: vi.fn().mockResolvedValue(null),
    expireWaitingAgentRun: vi.fn().mockResolvedValue(null),
    markAgentRunPublished: vi.fn().mockResolvedValue(null),

    // Agent triggers: a real provider answers a miss with `null` / `false` / a count.
    createAgentTrigger: vi.fn((record: Record<string, unknown>) => Promise.resolve({
      _id: `mock-trigger-${Math.random().toString(36).slice(2, 10)}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...record,
    })),
    getAgentTrigger: vi.fn().mockResolvedValue(null),
    updateAgentTrigger: vi.fn().mockResolvedValue(null),
    deleteAgentTriggersForAgent: vi.fn().mockResolvedValue(0),
    advanceTriggerNextFire: vi.fn().mockResolvedValue(false),
    setTriggerFireResult: vi.fn().mockResolvedValue(false),
    // The webhook delivery log: a recorded row, a count, the retention result.
    recordAgentTriggerDelivery: vi.fn((record: Record<string, unknown>) => Promise.resolve({
      _id: `mock-delivery-${Math.random().toString(36).slice(2, 10)}`,
      ...record,
    })),
    cleanupAgentTriggerDeliveryRetention: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    deleteAgentTriggerDeliveries: vi.fn().mockResolvedValue(0),

    // Retention primitives (src/lib/retention): nothing to age out.
    retentionCount: vi.fn().mockResolvedValue(0),
    retentionCountRedactable: vi.fn().mockResolvedValue(0),
    retentionDeleteBatch: vi.fn().mockResolvedValue(0),
    retentionRedactBatch: vi.fn().mockResolvedValue(0),
    retentionSelectValues: vi.fn().mockResolvedValue([]),
    retentionDeleteWhereIn: vi.fn().mockResolvedValue(0),
  };
}

/**
 * Create a Proxy-backed mock that satisfies the entire DatabaseProvider
 * interface without manual maintenance.
 */
export function createMockDb(overrides: Partial<MockDb> = {}): MockDb {
  const primers = buildPrimers();
  const overrideRecord = overrides as unknown as Record<string, unknown>;
  // Stable cache for auto-generated mocks so `db.foo === db.foo` across reads.
  const autoCache: Record<string, Mock> = {};

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') {
        return Reflect.get(target, prop, receiver);
      }
      // Explicit override wins.
      if (prop in overrideRecord) {
        return overrideRecord[prop];
      }
      // Primed default.
      if (prop in primers) {
        return primers[prop];
      }
      // Vitest internals / symbol-ish reads — let them fall through.
      if (prop === 'then' || prop === 'constructor' || prop.startsWith('_')) {
        return undefined;
      }
      // Auto-generate a mock with a sensible default based on method name.
      if (!(prop in autoCache)) {
        autoCache[prop] = vi.fn().mockResolvedValue(defaultReturnFor(prop));
      }
      return autoCache[prop];
    },
    set(_target, prop, value) {
      if (typeof prop !== 'string') {
        return false;
      }
      overrideRecord[prop] = value;
      return true;
    },
    has(_target, prop) {
      if (typeof prop !== 'string') {
        return false;
      }
      return prop in overrideRecord || prop in primers;
    },
  };

  return new Proxy({}, handler) as unknown as MockDb;
}

/** Convenience: tenant record fixture */
export const TENANT_ACME = {
  _id: 'tenant-acme-id',
  companyName: 'Acme Corp',
  slug: 'acme',
  dbName: 'tenant_acme',
  licenseType: 'FREE',
  createdAt: new Date('2025-01-01'),
};

/** Convenience: user record fixture */
export const USER_ALICE = {
  _id: 'user-alice-id',
  tenantId: 'tenant-acme-id',
  email: 'alice@acme.com',
  name: 'Alice',
  role: 'owner' as const,
  password: '$2b$10$xxx',
  licenseId: 'FREE',
  passwordHash: '$2b$10$xxx',
  licenseType: 'FREE',
  createdAt: new Date('2025-01-01'),
};

/** Convenience: API token fixture */
export const API_TOKEN_VALID = {
  _id: 'token-id-1',
  tenantId: 'tenant-acme-id',
  userId: 'user-alice-id',
  token: 'sk-test-valid-token-abc123',
  tokenHash: hashApiToken('sk-test-valid-token-abc123'),
  tokenPrefix: 'sk-test-valid-t',
  label: 'Test Token',
  name: 'Test Token',
  projectId: 'proj-default-id',
  createdAt: new Date('2025-01-01'),
};
