/**
 * The runtime's project -> tenant-wide fallback, driven against a REAL SQLite
 * provider rather than a mocked `findGuardrailByKey`.
 *
 * A mock would only prove that the engine passes `null`; what matters is what
 * the row store answers to it. Three behaviours are pinned here:
 *
 *   1. `resolveGuardrail` no longer picks up ANOTHER PROJECT's row: project A
 *      and project B both hold key `k`, A's copy is deleted, and A's requests
 *      must resolve to nothing rather than to B's policy (B's webhook getting
 *      A's content, B's block messages, the evaluation log written under B).
 *   2. A genuinely workspace-wide guardrail is still reachable from a project.
 *   3. `ensureDefaultToolGuardrail` materialises the TENANT-WIDE default even
 *      when some project already holds the pinned key — previously that row
 *      (a decoy, `mode: 'disabled'`) was returned as "the default" and every
 *      unbound tool call in the tenant was evaluated against it.
 *
 * And the create side of the same rule: `generateUniqueKey` must refuse a
 * project-scoped key that collides with a tenant-wide row, and must never hand
 * out the pinned default key to anyone.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IGuardrail } from '@/lib/database/provider.interface';

/**
 * The database barrel is replaced by a shim over ONE real SQLite provider.
 * `vi.mock` factories are hoisted above every import, so the provider is
 * reached through a hoisted ref that `beforeAll` fills in; the shim reproduces
 * the barrel's contract (`runWithTenantScope` binds through the provider's own
 * `runWithTenant`), which is what the engine and the record cache call.
 */
const hoisted = vi.hoisted(() => {
  const ref: { db: SQLiteProvider | null } = { db: null };
  const db = (): SQLiteProvider => {
    if (!ref.db) throw new Error('SQLite provider not initialised');
    return ref.db;
  };
  return { ref, db };
});

vi.mock('@/lib/database', () => ({
  getDatabase: async () => hoisted.db(),
  getTenantDatabase: async (tenantDbName: string) => {
    const db = hoisted.db();
    await db.switchToTenant(tenantDbName);
    return db;
  },
  runWithTenantScope: async (tenantDbName: string, fn: (db: SQLiteProvider) => unknown) =>
    hoisted.db().runWithTenant(tenantDbName, () => fn(hoisted.db())),
}));

vi.mock('@/lib/services/usage/usageEvents', () => ({
  recordUsageEvent: vi.fn(() => ({})),
  resolveUsageAttribution: vi.fn(() => ({})),
}));

import { SQLiteProvider as SQLiteProviderImpl } from '@/lib/database/sqlite.provider';
import { createGuardrail } from '@/lib/services/guardrail/guardrailService';
import {
  DEFAULT_TOOL_GUARDRAIL_KEY,
  ensureDefaultToolGuardrail,
  resolveGuardrail,
} from '@/lib/services/guardrail/hooks/engine';
import {
  invalidateGuardrailCache,
  resetRecordCaches,
} from '@/lib/services/guardrail/hooks/recordCache';

const TENANT_ID = 'tenant-fix-resolution';

let tmpDir = '';

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-guardrail-fix-resolution-'));
  const db = new SQLiteProviderImpl(tmpDir, 'fix_main');
  await db.connect();
  hoisted.ref.db = db;
});

afterAll(async () => {
  await hoisted.ref.db?.disconnect();
  hoisted.ref.db = null;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetRecordCaches();
});

function row(
  projectId: string | undefined,
  key: string,
  extra: Partial<Omit<IGuardrail, '_id' | 'createdAt' | 'updatedAt'>> = {},
): Omit<IGuardrail, '_id' | 'createdAt' | 'updatedAt'> {
  return {
    tenantId: TENANT_ID,
    projectId,
    key,
    name: `Guardrail ${key}`,
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    createdBy: 'user-1',
    ...extra,
  };
}

/** Run `fn` inside the provider's own tenant scope for `dbName`. */
function inTenant<T>(dbName: string, fn: (db: SQLiteProvider) => Promise<T>): Promise<T> {
  return hoisted.db().runWithTenant(dbName, () => fn(hoisted.db()));
}

const idOf = (record: { _id?: unknown } | null | undefined): string | undefined =>
  record?._id === undefined ? undefined : String(record._id);

// ═══════════════════════════════════════════════════════════════════════════

describe('resolveGuardrail: project first, then the TENANT-WIDE row only', () => {
  const dbName = 't_fix_resolve';

  it("does not fall through to another project's row once the bound project's row is gone", async () => {
    const key = 'pii-basic';
    const a = await inTenant(dbName, (db) => db.createGuardrail(row('proj-a', key)));
    await inTenant(dbName, (db) => db.createGuardrail(row('proj-b', key)));

    expect(idOf(await resolveGuardrail(dbName, key, 'proj-a'))).toBe(idOf(a));

    await inTenant(dbName, (db) => db.deleteGuardrail(String(a._id)));
    invalidateGuardrailCache(dbName);

    // THE PIN. With an `undefined` fallback this resolved to B's row.
    expect(await resolveGuardrail(dbName, key, 'proj-a')).toBeNull();
  });

  it('still reaches a workspace-wide guardrail from a project', async () => {
    const wide = await inTenant(dbName, (db) => db.createGuardrail(row(undefined, 'workspace-wide')));

    const found = await resolveGuardrail(dbName, 'workspace-wide', 'proj-a');
    expect(idOf(found)).toBe(idOf(wide));
    expect(found?.projectId ?? null).toBeNull();
  });
});

describe('ensureDefaultToolGuardrail: the default is the TENANT-WIDE row', () => {
  const dbName = 't_fix_default';

  it('materialises the tenant-wide default even when a project holds the pinned key', async () => {
    // The disarm scenario: a project-scoped row under the pinned key, switched
    // off. Written straight to the store, since the service now refuses this
    // key — rows like it exist from before it did.
    const decoy = await inTenant(dbName, (db) =>
      db.createGuardrail(row('proj-p', DEFAULT_TOOL_GUARDRAIL_KEY, { enabled: false, mode: 'disabled' })),
    );

    const record = await ensureDefaultToolGuardrail(dbName, TENANT_ID);

    expect(idOf(record)).not.toBe(idOf(decoy));
    expect(record.projectId ?? null).toBeNull();
    expect(record.mode).toBe('enforce');

    const stored = await inTenant(dbName, (db) => db.findGuardrailByKey(DEFAULT_TOOL_GUARDRAIL_KEY, null));
    expect(idOf(stored)).toBe(idOf(record));

    // And the decoy is untouched — it is the project's row, whatever it is for.
    const decoyStill = await inTenant(dbName, (db) => db.findGuardrailByKey(DEFAULT_TOOL_GUARDRAIL_KEY, 'proj-p'));
    expect(idOf(decoyStill)).toBe(idOf(decoy));
    expect(decoyStill?.mode).toBe('disabled');
  });
});

describe('generateUniqueKey (through createGuardrail)', () => {
  const dbName = 't_fix_keys';

  it('refuses a project-scoped key that collides with a tenant-wide guardrail', async () => {
    await inTenant(dbName, (db) => db.createGuardrail(row(undefined, 'pii-basic')));

    const view = await createGuardrail(dbName, TENANT_ID, 'user-1', {
      name: 'PII basic',
      type: 'preset',
      action: 'block',
      projectId: 'proj-a',
    });

    // Both would be reachable from one binding via the project -> tenant
    // fallback, so the project copy is de-duplicated against the tenant row.
    expect(view.key).toBe('pii-basic-1');
  });

  it('never hands out the pinned default tool guardrail key', async () => {
    const scoped = await createGuardrail(dbName, TENANT_ID, 'user-1', {
      name: 'Tool safety (default)',
      type: 'preset',
      action: 'block',
      projectId: 'proj-a',
    });
    expect(scoped.key).toBe(`${DEFAULT_TOOL_GUARDRAIL_KEY}-1`);

    // A tenant-wide create is refused the literal too, and collides with the
    // project row above (an `undefined` lookup already means "any project").
    const wide = await createGuardrail(dbName, TENANT_ID, 'user-1', {
      name: 'Tool safety (default)',
      type: 'preset',
      action: 'block',
    });
    expect(wide.key).toBe(`${DEFAULT_TOOL_GUARDRAIL_KEY}-2`);

    expect(await inTenant(dbName, (db) => db.findGuardrailByKey(DEFAULT_TOOL_GUARDRAIL_KEY))).toBeNull();
  });
});
