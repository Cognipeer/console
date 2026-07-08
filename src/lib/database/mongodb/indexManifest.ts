/**
 * MongoDB index manifest — the single source of truth for the indexes every
 * console deployment needs, applied idempotently and NON-BLOCKINGLY.
 *
 * Why this exists: on Azure Cosmos DB for MongoDB (vCore) any unindexed filter
 * or sort is a full collection scan. Historically indexes were created only
 * lazily on specific write paths (tracing/providers/models) or when a report
 * opened, so most collections — including the largest, `audit_logs`,
 * `sandbox_instances`, `model_usage_logs`, `*_request_logs` — had ONLY the
 * default `_id_` index, and every new tenant DB started with zero indexes.
 *
 * Applied from `base.ts`:
 *   - `ensureMainDbIndexes`   once per process in `connect()`
 *   - `ensureTenantDbIndexes` once per tenant DB per process, on first tenant
 *     bind (`switchToTenant` / `runWithTenant`), fire-and-forget.
 * Both memoize per process, so this is NOT re-run on every request. Tenant
 * indexes are existence-guarded (only created for collections that already
 * exist) so community deployments never get empty enterprise collections and
 * no work happens for features a tenant never uses.
 *
 * Collection names are string literals (not the COLLECTIONS map) on purpose:
 * it keeps this module free of a circular import with base.ts.
 */

import type { Db, IndexSpecification, CreateIndexesOptions } from 'mongodb';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('mongodb-index');

interface IndexDef {
  key: IndexSpecification;
  options: CreateIndexesOptions;
}

/** Control-plane (main) DB — these collections always exist. */
export const MAIN_DB_INDEXES: Record<string, IndexDef[]> = {
  // Hottest lookup in the system: every /client/v1/* request resolves a token
  // by hash. Also last-used updates by hash.
  api_tokens: [
    { key: { tokenHash: 1 }, options: { name: 'idx_tokenHash' } },
    { key: { tenantId: 1, projectId: 1 }, options: { name: 'idx_tenant_project' } },
    { key: { userId: 1 }, options: { name: 'idx_userId' } },
  ],
  tenants: [{ key: { slug: 1 }, options: { name: 'idx_slug' } }],
  // Login resolves a user's tenants by email.
  tenant_user_directory: [{ key: { email: 1 }, options: { name: 'idx_email' } }],
  // Cluster heartbeat stale-sweep filters by lastHeartbeatAt.
  nodes: [{ key: { lastHeartbeatAt: 1 }, options: { name: 'idx_heartbeat' } }],
};

/**
 * Per-tenant DB — existence-guarded. Collections already owning indexes via
 * their own ensure* routines (agent_tracing_*, providers, models) are
 * intentionally omitted to avoid duplicate/conflicting index names.
 */
export const TENANT_DB_INDEXES: Record<string, IndexDef[]> = {
  audit_logs: [
    { key: { createdAt: -1 }, options: { name: 'idx_createdAt' } },
    { key: { service: 1, action: 1, createdAt: -1 }, options: { name: 'idx_service_action_createdAt' } },
    { key: { actorUserId: 1, createdAt: -1 }, options: { name: 'idx_actor_createdAt' } },
  ],
  model_usage_logs: [
    { key: { modelKey: 1, createdAt: -1 }, options: { name: 'idx_modelKey_createdAt' } },
    { key: { projectId: 1, createdAt: -1 }, options: { name: 'idx_project_createdAt' } },
  ],
  browser_session_events: [
    { key: { sessionId: 1, createdAt: 1 }, options: { name: 'idx_session_createdAt' } },
  ],
  crawl_results: [{ key: { jobId: 1, createdAt: 1 }, options: { name: 'idx_job_createdAt' } }],
  rag_chunks: [
    { key: { documentId: 1, chunkIndex: 1 }, options: { name: 'idx_doc_chunk' } },
    { key: { vectorId: 1 }, options: { name: 'idx_vectorId' } },
  ],
  rag_query_logs: [{ key: { moduleKey: 1, createdAt: -1 }, options: { name: 'idx_module_createdAt' } }],
  reranker_run_logs: [{ key: { rerankerKey: 1, createdAt: -1 }, options: { name: 'idx_reranker_createdAt' } }],
  websearch_run_logs: [{ key: { searchKey: 1, createdAt: -1 }, options: { name: 'idx_search_createdAt' } }],
  agent_conversations: [{ key: { agentKey: 1, updatedAt: -1 }, options: { name: 'idx_agent_updatedAt' } }],
  agent_versions: [{ key: { agentId: 1, version: -1 }, options: { name: 'idx_agent_version' } }],
  mcp_request_logs: [{ key: { serverKey: 1, createdAt: -1 }, options: { name: 'idx_server_createdAt' } }],
  tool_request_logs: [{ key: { toolKey: 1, createdAt: -1 }, options: { name: 'idx_tool_createdAt' } }],
  ocr_job_items: [{ key: { jobId: 1, index: 1 }, options: { name: 'idx_job_index' } }],
  batch_job_items: [{ key: { batchId: 1, index: 1 }, options: { name: 'idx_batch_index' } }],
  memory_items: [{ key: { storeKey: 1, createdAt: -1 }, options: { name: 'idx_store_createdAt' } }],
  alert_events: [{ key: { ruleId: 1, firedAt: -1 }, options: { name: 'idx_rule_firedAt' } }],
  files: [{ key: { providerKey: 1, bucketKey: 1, key: 1 }, options: { name: 'idx_provider_bucket_key' } }],
  config_audit_logs: [{ key: { createdAt: -1 }, options: { name: 'idx_createdAt' } }],
  // ── Sandbox (enterprise) — created only in tenant DBs that have them ──
  sandbox_instances: [
    { key: { actualState: 1, createdAt: -1 }, options: { name: 'idx_state_createdAt' } },
    { key: { warm: 1, warmKey: 1 }, options: { name: 'idx_warm_key' } },
    { key: { id: 1 }, options: { name: 'idx_id' } },
    { key: { projectId: 1 }, options: { name: 'idx_projectId' } },
  ],
  sandbox_commands: [{ key: { runnerId: 1, status: 1, issuedAt: 1 }, options: { name: 'idx_runner_status_issued' } }],
  sandbox_events: [{ key: { runnerId: 1, sequence: 1 }, options: { name: 'idx_runner_sequence' } }],
  sandbox_runners: [
    { key: { id: 1 }, options: { name: 'idx_id' } },
    { key: { agentTokenHash: 1 }, options: { name: 'idx_agentTokenHash' } },
  ],
  sandbox_snapshots: [{ key: { instanceId: 1, createdAt: -1 }, options: { name: 'idx_instance_createdAt' } }],
  sandbox_volumes: [{ key: { id: 1 }, options: { name: 'idx_id' } }],
  gpu_fleet_commands: [{ key: { hostId: 1, status: 1, issuedAt: 1 }, options: { name: 'idx_host_status_issued' } }],
  gpu_fleet_events: [{ key: { hostId: 1, sequence: -1 }, options: { name: 'idx_host_sequence' } }],
};

// Per-process state. Key is scope-prefixed so a tenant DB that happens to share
// the main DB name can't collide. `ensured` is populated only AFTER a run
// succeeds, so a first touch that races connection (client not yet connected)
// does not permanently mark the DB done — the next touch retries. `inFlight`
// dedups concurrent first-touches of the same DB.
const ensured = new Set<string>();
const inFlight = new Map<string, Promise<void>>();

function isNotConnected(error: unknown): boolean {
  return error instanceof Error && /not connected|MongoNotConnected/i.test(error.message);
}

async function applyIndexes(db: Db, manifest: Record<string, IndexDef[]>, onlyExisting: boolean): Promise<void> {
  let existing: Set<string> | null = null;
  if (onlyExisting) {
    const names = await db.listCollections({}, { nameOnly: true }).toArray();
    existing = new Set(names.map((c) => c.name));
  }
  for (const [coll, defs] of Object.entries(manifest)) {
    if (existing && !existing.has(coll)) continue; // never create empty collections
    for (const def of defs) {
      // createIndex is idempotent for an identical key+name; a pre-existing
      // index with the same name but different key throws — we swallow it so a
      // single bad spec can never wedge startup or a request.
      await db.collection(coll).createIndex(def.key, def.options).catch((error) => {
        logger.warn('createIndex skipped', { coll, name: def.options.name, error: String(error) });
      });
    }
  }
}

function ensureOnce(memoKey: string, run: () => Promise<void>): Promise<void> {
  if (ensured.has(memoKey)) return Promise.resolve();
  let pending = inFlight.get(memoKey);
  if (!pending) {
    pending = run()
      .then(() => {
        ensured.add(memoKey); // memoize only on success, so failures retry later
      })
      .catch((error) => {
        // A connection race (first touch before connect completes) is benign:
        // leave the key unmemoized so the next touch retries. Anything else is
        // worth a warning but must never reject into a fire-and-forget caller.
        if (!isNotConnected(error)) {
          logger.warn('ensureIndexes failed', { memoKey, error: String(error) });
        }
      })
      .finally(() => inFlight.delete(memoKey));
    inFlight.set(memoKey, pending);
  }
  return pending;
}

/** Ensure control-plane indexes once per process. Call from connect(). */
export function ensureMainDbIndexes(db: Db, dbName: string): Promise<void> {
  return ensureOnce(`main:${dbName}`, () => applyIndexes(db, MAIN_DB_INDEXES, false));
}

/** Ensure tenant indexes once per tenant DB per process. Fire-and-forget from the tenant-bind path. */
export function ensureTenantDbIndexes(db: Db, dbName: string): Promise<void> {
  return ensureOnce(`tenant:${dbName}`, () => applyIndexes(db, TENANT_DB_INDEXES, true));
}
