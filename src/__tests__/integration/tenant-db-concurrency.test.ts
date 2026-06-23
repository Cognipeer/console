/**
 * Integration test — tenant-DB binding under concurrent multi-tenant load.
 *
 * Production runs many tenants through one process. The danger is cross-tenant
 * leakage: a write meant for tenant A landing in tenant B's database because a
 * concurrent request for B overwrote the process-global tenant binding.
 *
 * `getTenantDb()` resolves `tenantContext.getStore() ?? this.tenantDb`. The
 * AsyncLocalStorage store (set by `switchToTenant`'s `enterWith` and by
 * `runWithTenant`'s `run`) is per-async-context and survives `await`
 * boundaries within the same continuation; only code that reads `getTenantDb()`
 * with NO tenant bound in its own async ancestry falls back to the mutable
 * `this.tenantDb` global and is racy.
 *
 * This test pins that invariant: detached writers that each call
 * `switchToTenant` in their own continuation (the shape of `logModelUsage`,
 * tracing/MCP/tool logging, etc.) must NEVER leak across tenants, even when
 * hundreds of them interleave. If someone refactors a writer to read the
 * ambient DB without binding its own tenant, this test fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';

let db: SQLiteProvider;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-tenant-conc-'));
  db = new SQLiteProvider(tmpDir, 'conc_main');
  await db.connect();
  // Pre-open both tenant DBs (schema + connection cached).
  await db.switchToTenant('tenant_a');
  await db.switchToTenant('tenant_b');
});

afterAll(async () => {
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Mirrors the detached-writer shape: resolve db, bind tenant, (optionally yield)
// then write — all relying on the ambient binding for the actual query.
async function detachedWrite(dbName: string, tenantId: string, key: string, yieldFirst: boolean) {
  await db.switchToTenant(dbName);
  if (yieldFirst) await new Promise((r) => setTimeout(r, 0));
  await db.createProject({
    tenantId, key, name: 'x', description: 'x', createdBy: 'u', updatedBy: 'u',
  } as never);
}

async function countLeaks(yieldFirst: boolean, iterations: number) {
  const tag = yieldFirst ? 'y' : 'n';
  const tasks: Promise<unknown>[] = [];
  for (let i = 0; i < iterations; i++) {
    tasks.push(detachedWrite('tenant_a', 'tenant-a-id', `a-${tag}-${i}`, yieldFirst));
    tasks.push(detachedWrite('tenant_b', 'tenant-b-id', `b-${tag}-${i}`, yieldFirst));
  }
  await Promise.all(tasks);

  const aProjects = await db.runWithTenant('tenant_a', () => db.listProjects('tenant-a-id'));
  const bProjects = await db.runWithTenant('tenant_b', () => db.listProjects('tenant-b-id'));
  const inRound = (arr: { key: string }[], p: string) =>
    arr.filter((x) => x.key.startsWith(p) && x.key.includes(`-${tag}-`));
  return {
    aLeakedToB: inRound(bProjects, 'a-').length,
    bLeakedToA: inRound(aProjects, 'b-').length,
  };
}

describe('tenant DB isolation under concurrent detached writes', () => {
  it('no cross-tenant leak when switch and write share a continuation', async () => {
    const r = await countLeaks(false, 300);
    expect(r.aLeakedToB + r.bLeakedToA).toBe(0);
  });

  it('no cross-tenant leak even with an await between switch and write', async () => {
    const r = await countLeaks(true, 300);
    expect(r.aLeakedToB + r.bLeakedToA).toBe(0);
  });
});
