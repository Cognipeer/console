/**
 * Every log-shaped collection the console creates is in the retention
 * registry, as an engine target or as a legacy entry with its default. A new
 * `*_logs` / `*_events` / `*_runs`... collection that is in neither fails here:
 * that is how a table grows without bound.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

import { describe, expect, it } from 'vitest';

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { RETENTION_AGE_INDEXES, TENANT_DB_INDEXES } from '@/lib/database/mongodb/indexManifest';
import { RETENTION_CLASSES } from '@/lib/retention/classes';
import { getLegacyRetentionTargets, getRetentionTargets } from '@/lib/retention/targets';

const ROOT = path.resolve(__dirname, '../../lib/database');
const LOG_SHAPED = /(_logs?|_events?|_runs|_results|_metrics|_deliveries|_items|_claims|_daily|_sessions|_reports|_turns|_requests|_commands|^incidents)$/;

/** Collections whose names look like logs but hold user-authored data, not a record of activity. */
const NOT_LOGS: Record<string, string> = {
  config_items: 'Tenant configuration values.',
  evaluation_dataset_items: 'Evaluation dataset rows a user wrote or imported.',
  memory_items: 'Agent memory a user or agent stored on purpose; deleted with its memory store.',
};

/** Written by enterprise modules, which register their own retention entries (console-ee). */
const ENTERPRISE_OWNED = new Set(['gpu_fleet_commands', 'gpu_host_metrics', 'realtime_sessions', 'realtime_session_turns', 'sandbox_events', 'sandbox_commands']);

function collectionNames(): Set<string> {
  const names = new Set<string>();
  const sqliteDir = path.join(ROOT, 'sqlite');
  for (const file of readdirSync(sqliteDir).filter((f) => f.endsWith('.ts'))) {
    for (const match of readFileSync(path.join(sqliteDir, file), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)/g)) {
      names.add(match[1]);
    }
  }
  const mongoBase = readFileSync(path.join(ROOT, 'mongodb', 'base.ts'), 'utf8');
  const block = mongoBase.slice(mongoBase.indexOf('COLLECTIONS'));
  for (const match of block.matchAll(/^\s+[A-Za-z0-9]+: '([a-z0-9_]+)',/gm)) names.add(match[1]);
  return names;
}

describe('retention registry coverage', () => {
  it('finds the collections (sanity)', () => {
    const names = collectionNames();
    expect(names.has('model_usage_logs')).toBe(true);
    expect(names.has('agent_tracing_events')).toBe(true);
  });

  it('every log-shaped collection has a retention entry with a default', () => {
    const covered = new Set<string>();
    for (const target of getRetentionTargets()) {
      covered.add(target.collection);
      for (const extra of target.covers ?? []) covered.add(extra);
    }
    for (const legacy of getLegacyRetentionTargets()) {
      covered.add(legacy.collection);
      for (const extra of legacy.covers ?? []) covered.add(extra);
    }
    const missing = [...collectionNames()]
      .filter((name) => LOG_SHAPED.test(name))
      .filter((name) => !covered.has(name) && !(name in NOT_LOGS) && !ENTERPRISE_OWNED.has(name));
    expect(missing, `add these to src/lib/retention/targets.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('every engine target has a MongoDB index leading on its age field', () => {
    const listed = new Set(RETENTION_AGE_INDEXES.map(([collection, field]) => `${collection}.${field}`));
    // A few rows per alert; the incident mixin owns that collection's indexes.
    for (const target of getRetentionTargets().filter((t) => t.edition === 'core' && t.collection !== 'incidents')) {
      expect(listed.has(`${target.collection}.${target.timeField}`), `${target.collection}.${target.timeField}`).toBe(true);
      const leads = (TENANT_DB_INDEXES[target.collection] ?? []).some((def) => Object.keys(def.key as object)[0] === target.timeField);
      expect(leads, target.collection).toBe(true);
    }
  });

  it('every field a core target names is a column of its SQLite table', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cognipeer-retention-fields-'));
    const db = new SQLiteProvider(dir, 'retention_fields_main');
    try {
      await db.connect();
      await db.switchToTenant('retention_fields_tenant');
      const raw = (db as unknown as { getTenantDb(): Database.Database }).getTenantDb();
      const columnsOf = (table: string) => new Set((raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      const problems: string[] = [];
      // Thread rollups exist on MongoDB only.
      for (const target of getRetentionTargets().filter((t) => t.edition === 'core' && t.collection !== 'agent_tracing_threads')) {
        const columns = columnsOf(target.collection);
        const fields = [
          target.timeField,
          target.projectField,
          target.cascade?.parentField,
          ...(target.guard ?? []).map((g) => g.field),
          ...target.phases.flatMap((p) => (p.fields ?? []).map((f) => f.field)),
        ].filter((f): f is string => Boolean(f));
        for (const field of fields) if (!columns.has(field)) problems.push(`${target.collection}.${field}`);
        for (const child of target.cascade?.children ?? []) {
          if (!columnsOf(child.collection).has(child.field)) problems.push(`${child.collection}.${child.field}`);
        }
      }
      expect(problems).toEqual([]);
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('target ids are unique and every phase names a class with a default', () => {
    const ids = getRetentionTargets().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const target of getRetentionTargets()) {
      expect(target.phases.length, target.id).toBeGreaterThan(0);
      for (const phase of target.phases) {
        expect(RETENTION_CLASSES[phase.class], `${target.id}: ${phase.class}`).toBeDefined();
        if (phase.action === 'redact') expect(phase.fields?.length, target.id).toBeGreaterThan(0);
      }
    }
  });
});
