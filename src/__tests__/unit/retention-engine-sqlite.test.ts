/**
 * The retention engine on a REAL SQLite provider: what each class deletes or
 * redacts, project overrides, status guards, the trace cascade, destruction
 * records, dry run, watermarks and a manual "older than" purge.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { planWork, runWork, type WatermarkStore } from '@/lib/retention/engine';
import { emptyPolicy, type RetentionPolicyInput } from '@/lib/retention/policy';

const DAY = 86_400_000;
const NOW = new Date('2026-10-23T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let tmpDir = '';
let db: SQLiteProvider;
let raw: Database.Database;
let seq = 0;

function insert(table: string, row: Record<string, unknown>): string {
  const columns = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
  const full: Record<string, unknown> = { id: `r${++seq}`, tenantId: 't1', ...row };
  for (const col of columns) {
    if (full[col.name] !== undefined || !col.notnull || col.dflt_value !== null) continue;
    full[col.name] = /INT|REAL/i.test(col.type) ? 0 : 'x';
  }
  const names = Object.keys(full).filter((k) => columns.some((c) => c.name === k));
  raw.prepare(`INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((n) => `@${n}`).join(', ')})`).run(
    Object.fromEntries(names.map((n) => [n, full[n]])),
  );
  return String(full.id);
}

const rows = (table: string) => raw.prepare(`SELECT * FROM ${table} ORDER BY createdAt`).all() as Array<Record<string, unknown>>;
const ids = (table: string) => rows(table).map((r) => r.id);

function run(policy: RetentionPolicyInput, opts: Partial<Parameters<typeof runWork>[2]> & { mode?: Parameters<typeof planWork>[1]['mode'] } = {}) {
  const items = planWork(policy, { mode: opts.mode ?? { kind: 'policy' }, now: NOW });
  return runWork(db as never, items, { dryRun: false, batchSize: 2, deadline: Date.now() + 60_000, ...opts });
}

function memoryWatermarks(): WatermarkStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k), set: async (k, v) => { map.set(k, v); } };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-retention-'));
  db = new SQLiteProvider(tmpDir, 'retention_main');
  await db.connect();
  await db.switchToTenant('retention_tenant');
  raw = (db as unknown as { getTenantDb(): Database.Database }).getTenantDb();
});

afterAll(async () => {
  await db.disconnect();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const table of ['model_usage_logs', 'rag_query_logs', 'batch_job_items', 'audit_logs', 'agent_tracing_sessions', 'agent_tracing_events']) {
    raw.prepare(`DELETE FROM ${table}`).run();
  }
});

describe('retention engine (sqlite)', () => {
  it('deletes telemetry past 90 days and clears content past 30 under the default policy', async () => {
    const old = insert('model_usage_logs', { createdAt: ago(100), providerRequest: '{"p":1}', providerResponse: '{"r":1}' });
    const mid = insert('model_usage_logs', { createdAt: ago(40), providerRequest: '{"p":1}', providerResponse: '{"r":1}' });
    const fresh = insert('model_usage_logs', { createdAt: ago(5), providerRequest: '{"p":1}' });
    insert('rag_query_logs', { createdAt: ago(40), query: 'secret question' });

    const result = await run(emptyPolicy());

    expect(result.done).toBe(true);
    expect(ids('model_usage_logs')).toEqual([mid, fresh]);
    expect(ids('model_usage_logs')).not.toContain(old);
    const [midRow, freshRow] = rows('model_usage_logs');
    expect(midRow.providerRequest).toBeNull();
    expect(midRow.providerResponse).toBeNull();
    expect(freshRow.providerRequest).toBe('{"p":1}');
    // NOT NULL column: cleared to '', not NULL.
    expect(rows('rag_query_logs')[0].query).toBe('');
    expect(result.deleted).toBe(1);
    expect(result.redacted).toBe(2);
  });

  it('keeps a project longer when its override says so, and rows without a project follow the tenant', async () => {
    const kept = insert('model_usage_logs', { createdAt: ago(100), projectId: 'p2' });
    insert('model_usage_logs', { createdAt: ago(100), projectId: 'p1' });
    insert('model_usage_logs', { createdAt: ago(100) });

    await run({ ...emptyPolicy(), projects: { p2: { telemetry: 365 } } });

    expect(ids('model_usage_logs')).toEqual([kept]);
  });

  it('never touches a batch item that is still running', async () => {
    const running = insert('batch_job_items', { createdAt: ago(200), status: 'running', requestBody: '{"a":1}' });
    insert('batch_job_items', { createdAt: ago(200), status: 'succeeded', requestBody: '{"a":1}' });

    await run(emptyPolicy());

    expect(ids('batch_job_items')).toEqual([running]);
    expect(rows('batch_job_items')[0].requestBody).toBe('{"a":1}');
  });

  // Thread rollups (agent_tracing_threads) exist on MongoDB only; on SQLite that target is a no-op.
  it('deletes old trace sessions with their events', async () => {
    insert('agent_tracing_sessions', { sessionId: 's-old', createdAt: ago(40), updatedAt: ago(40) });
    insert('agent_tracing_sessions', { sessionId: 's-new', createdAt: ago(2), updatedAt: ago(2) });
    insert('agent_tracing_events', { sessionId: 's-old', createdAt: ago(40) });
    insert('agent_tracing_events', { sessionId: 's-old', createdAt: ago(40) });
    insert('agent_tracing_events', { sessionId: 's-new', createdAt: ago(2) });

    const result = await run(emptyPolicy());

    expect(rows('agent_tracing_sessions').map((r) => r.sessionId)).toEqual(['s-new']);
    expect(rows('agent_tracing_events').map((r) => r.sessionId)).toEqual(['s-new']);
    const sessions = result.items.find((i) => i.targetId === 'agent_tracing_sessions');
    expect(sessions).toMatchObject({ affected: 1, cascaded: 2 });
  });

  it('keeps destruction records for three years while the audit class ages out at one', async () => {
    const record = insert('audit_logs', { createdAt: ago(400), service: 'retention', event: 'retention.sweep' });
    insert('audit_logs', { createdAt: ago(400), service: 'members', event: 'members.update' });
    const recent = insert('audit_logs', { createdAt: ago(100), service: 'members', event: 'members.update' });

    await run(emptyPolicy());

    expect(ids('audit_logs').sort()).toEqual([record, recent].sort());
  });

  it('only counts in a dry run', async () => {
    insert('model_usage_logs', { createdAt: ago(100) });
    insert('model_usage_logs', { createdAt: ago(40), providerRequest: '{"p":1}' });

    const result = await run(emptyPolicy(), { dryRun: true });

    expect(result).toMatchObject({ dryRun: true, done: true, deleted: 1, redacted: 1 });
    expect(rows('model_usage_logs')).toHaveLength(2);
  });

  it('remembers how far redaction got and starts from there next time', async () => {
    insert('model_usage_logs', { createdAt: ago(40), providerRequest: '{"p":1}' });
    const marks = memoryWatermarks();

    await run(emptyPolicy(), { watermarks: marks });
    const key = [...marks.map.keys()].find((k) => k.startsWith('model_usage_logs:1:'));
    expect(marks.map.get(key!)).toBe(ago(30));

    // A row older than the watermark that still holds content is left to the delete phase.
    insert('model_usage_logs', { createdAt: ago(50), providerRequest: '{"late":1}' });
    const second = await run(emptyPolicy(), { watermarks: marks });
    expect(second.redacted).toBe(0);
  });

  it('stops at the deadline and reports it is not done', async () => {
    for (let i = 0; i < 5; i += 1) insert('model_usage_logs', { createdAt: ago(100) });

    const result = await run(emptyPolicy(), { deadline: Date.now() - 1 });

    expect(result.done).toBe(false);
    expect(rows('model_usage_logs')).toHaveLength(5);
  });

  it('a manual purge removes everything older than N days but never takes audit below its floor', async () => {
    insert('model_usage_logs', { createdAt: ago(3) });
    const today = insert('model_usage_logs', { createdAt: new Date(NOW.getTime() - 3_600_000).toISOString() });
    const audit = insert('audit_logs', { createdAt: ago(100), service: 'members', event: 'x' });

    await run(emptyPolicy(), { mode: { kind: 'olderThan', days: 1 } });

    expect(ids('model_usage_logs')).toEqual([today]);
    expect(ids('audit_logs')).toEqual([audit]);
  });

  it('stops when cancelled', async () => {
    for (let i = 0; i < 5; i += 1) insert('model_usage_logs', { createdAt: ago(100) });

    const result = await run(emptyPolicy(), { isCancelled: async () => true });

    expect(result.cancelled).toBe(true);
    expect(rows('model_usage_logs')).toHaveLength(5);
  });
});
