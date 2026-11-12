/**
 * The write path of a mixin whose collection its first write creates ensures the
 * manifest's indexes (ensureTenantCollectionIndexes): once per tenant DB, a
 * required failure is retried by the next write, a best-effort one is not.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';
import {
  ensureTenantCollectionIndexes,
  ensureTenantCollectionsIndexes,
  TENANT_DB_INDEXES,
} from '@/lib/database/mongodb/indexManifest';

function fakeDb(databaseName: string, failing: (name: string | undefined) => boolean = () => false) {
  const created: Array<{ coll: string; name?: string }> = [];
  const db = {
    databaseName,
    collection: (coll: string) => ({
      createIndex: async (_key: unknown, options: { name?: string }) => {
        created.push({ coll, name: options.name });
        if (failing(options.name)) throw new Error('rejected');
        return options.name ?? 'unnamed';
      },
    }),
  } as unknown as Db;
  return { db, created };
}

let seq = 0;
const freshDb = () => `write_path_${Date.now()}_${seq++}`;

describe('ensureTenantCollectionIndexes', () => {
  it('creates every manifest index of the collection once per tenant database', async () => {
    const fake = fakeDb(freshDb());
    await ensureTenantCollectionIndexes(fake.db, 'webhook_deliveries');
    await ensureTenantCollectionIndexes(fake.db, 'webhook_deliveries');
    expect(fake.created.map((c) => c.name).sort()).toEqual(TENANT_DB_INDEXES.webhook_deliveries.map((d) => d.options.name).sort());
  });

  it('retries a collection whose required index failed on the next call', async () => {
    let reject = true;
    const fake = fakeDb(freshDb(), (name) => reject && name === 'idx_status_nextAttemptAt');
    await ensureTenantCollectionIndexes(fake.db, 'webhook_deliveries');
    const first = fake.created.length;
    reject = false;
    await ensureTenantCollectionIndexes(fake.db, 'webhook_deliveries');
    expect(fake.created.length).toBe(first * 2);
    await ensureTenantCollectionIndexes(fake.db, 'webhook_deliveries');
    expect(fake.created.length).toBe(first * 2);
  });

  it('does not retry a collection whose only failure is a best-effort index', async () => {
    const fake = fakeDb(freshDb(), (name) => name === 'idx_agent_runs_active_per_conversation');
    await ensureTenantCollectionIndexes(fake.db, 'agent_runs');
    const first = fake.created.length;
    expect(first).toBe(TENANT_DB_INDEXES.agent_runs.length);
    await ensureTenantCollectionIndexes(fake.db, 'agent_runs');
    expect(fake.created.length).toBe(first);
  });

  it('never rejects, even when an index is refused', async () => {
    const fake = fakeDb(freshDb(), () => true);
    await expect(ensureTenantCollectionIndexes(fake.db, 'files')).resolves.toBeUndefined();
  });

  it('ensureTenantCollectionsIndexes covers each collection', async () => {
    const fake = fakeDb(freshDb());
    const spy = vi.spyOn(fake.db, 'collection');
    await ensureTenantCollectionsIndexes(fake.db, ['webhook_endpoints', 'webhook_deliveries']);
    expect([...new Set(fake.created.map((c) => c.coll))].sort()).toEqual(['webhook_deliveries', 'webhook_endpoints']);
    spy.mockRestore();
  });
});

describe('manifest entries that were defined inline in the mixins', () => {
  it.each([
    ['agent_runs', 'idx_status_createdAt'],
    ['agent_runs', 'idx_tenant_project_agent_createdAt'],
    ['agent_run_locks', 'idx_expiresAt'],
    ['usage_daily', 'uniq_usage_daily_dims_v3'],
    ['usage_daily', 'idx_usage_daily_agent_day'],
    ['external_model_pricing', 'uniq_external_model_pricing'],
    ['models', 'uniq_model_key'],
    ['providers', 'uniq_provider_tenant_key'],
    ['agent_tracing_sessions', 'uniq_project_sessionId'],
    ['agent_tracing_events', 'idx_project_session_eventId'],
    ['agent_tracing_threads', 'idx_project_latestStatus_startedAt'],
  ])('%s has %s', (collection, name) => {
    expect(TENANT_DB_INDEXES[collection]?.some((def) => def.options.name === name)).toBe(true);
  });

  it('the indexes a backend may legitimately refuse are best-effort', () => {
    const bestEffort = Object.entries(TENANT_DB_INDEXES).flatMap(([collection, defs]) =>
      defs.filter((def) => def.bestEffort).map((def) => `${collection}.${def.options.name}`),
    );
    expect(bestEffort.sort()).toEqual([
      'agent_runs.idx_agent_runs_active_per_conversation',
      'agent_tracing_sessions.uniq_project_sessionId',
      'models.uniq_model_key',
      'providers.uniq_provider_tenant_key',
    ]);
  });
});
