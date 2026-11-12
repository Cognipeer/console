/**
 * A guardrail view names the side it protects (`target`) and the families it
 * enforces there (`policy.<family>.enabled`), both derived from the active
 * hooks. Consumers pick guardrails by the two together: the AI App Gateway
 * offers `target === 'input' && policy.pii.enabled` records as request PII
 * protection. A record must never claim PII protection on a side where no
 * active hook runs it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IGuardrail } from '@/lib/database/provider.interface';
import type { GuardrailHooksConfig, GuardrailPolicy, HookId } from '@/lib/services/guardrail/hooks/contract';

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
  runWithTenantScope: async (tenantDbName: string, fn: (db: SQLiteProvider) => unknown) =>
    hoisted.db().runWithTenant(tenantDbName, () => fn(hoisted.db())),
}));

vi.mock('@/lib/services/usage/usageEvents', () => ({
  recordUsageEvent: vi.fn(() => ({})),
  resolveUsageAttribution: vi.fn(() => ({})),
}));

import { SQLiteProvider as SQLiteProviderImpl } from '@/lib/database/sqlite.provider';
import {
  createGuardrail,
  deriveGuardrailTarget,
  getGuardrail,
  serializeGuardrail,
  updateGuardrail,
} from '@/lib/services/guardrail/guardrailService';
import { resetRecordCaches } from '@/lib/services/guardrail/hooks/recordCache';

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

const pii = (hooks: HookId[]): GuardrailPolicy =>
  ({ id: 'pii-1', family: 'pii', enabled: true, hooks, schedule: SYNC_BLOCK, piiPolicyKey: 'pii-default' }) as GuardrailPolicy;
const words = (hooks: HookId[]): GuardrailPolicy =>
  ({ id: 'words-1', family: 'word_filter', enabled: true, hooks, schedule: SYNC_BLOCK }) as GuardrailPolicy;

function config(policies: GuardrailPolicy[], on: HookId[]): GuardrailHooksConfig {
  const bindings: GuardrailHooksConfig['bindings'] = {};
  for (const hook of on) bindings[hook] = { enabled: true, schedule: SYNC_BLOCK };
  return { contractVersion: 2, policies, bindings } as GuardrailHooksConfig;
}

function record(hooks: GuardrailHooksConfig, target: IGuardrail['target'] = 'input'): IGuardrail {
  return {
    _id: 'g1', tenantId: 't', key: 'g', name: 'G', type: 'preset', target, action: 'block', enabled: true, createdBy: 'u', hooks,
  } as IGuardrail;
}

/** The AI App Gateway's input PII picker predicate. */
const offeredAsInputPii = (view: { target?: string; policy?: { pii?: { enabled?: boolean } } }): boolean =>
  view.target === 'input' && view.policy?.pii?.enabled === true;

describe('guardrail view direction', () => {
  it('an output-only PII guardrail is an output guardrail and is not offered as input protection', () => {
    const view = serializeGuardrail(record(config([pii(['output.pre'])], ['output.pre']), 'input'));
    expect(view.target).toBe('output');
    expect(view.policy?.pii?.enabled).toBe(true);
    expect(offeredAsInputPii(view)).toBe(false);
  });

  it('an input-bound PII guardrail is offered', () => {
    const view = serializeGuardrail(record(config([pii(['input.pre'])], ['input.pre']), 'output'));
    expect(view.target).toBe('input');
    expect(offeredAsInputPii(view)).toBe(true);
  });

  it('PII on the output side only does not count for a record whose input side runs something else', () => {
    const view = serializeGuardrail(record(config([words(['input.pre']), pii(['output.pre'])], ['input.pre', 'output.pre'])));
    expect(view.target).toBe('input');
    expect(view.policy?.wordFilter?.enabled).toBe(true);
    expect(view.policy?.pii?.enabled).toBe(false);
    expect(offeredAsInputPii(view)).toBe(false);
  });

  it('a PII policy on a switched-off hook protects nothing', () => {
    const view = serializeGuardrail(record(config([pii(['input.pre'])], []), 'input'));
    expect(view.policy?.pii?.enabled).toBe(false);
    expect(offeredAsInputPii(view)).toBe(false);
  });

  it('with nothing active, the stored target stands', () => {
    expect(deriveGuardrailTarget(config([], []), 'output')).toBe('output');
    expect(deriveGuardrailTarget(undefined, 'input')).toBe('input');
  });
});

describe('guardrail direction through create and update', () => {
  const TENANT_DB = 'view_direction';
  let tmpDir = '';

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cognipeer-guardrail-direction-'));
    const db = new SQLiteProviderImpl(tmpDir, 'direction_main');
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

  it('stores the derived target, and an edit from input to output takes the record out of the input picker', async () => {
    const created = await createGuardrail(TENANT_DB, 'tenant-direction', 'user-1', {
      name: 'Email guard',
      action: 'block',
      projectId: 'proj-1',
      hooks: config([pii(['input.pre'])], ['input.pre']),
    } as Parameters<typeof createGuardrail>[3]);
    expect(created.target).toBe('input');
    expect(offeredAsInputPii(created)).toBe(true);

    const updated = await updateGuardrail(TENANT_DB, created.id, 'user-1', {
      hooks: config([pii(['output.pre'])], ['output.pre']),
    } as Parameters<typeof updateGuardrail>[3]);
    expect(updated?.target).toBe('output');
    expect(offeredAsInputPii(updated!)).toBe(false);

    const stored = await hoisted.db().runWithTenant(TENANT_DB, () => hoisted.db().findGuardrailById(created.id));
    expect(stored?.target).toBe('output');
    const reread = await getGuardrail(TENANT_DB, created.id);
    expect(offeredAsInputPii(reread!)).toBe(false);
  });

  it('an output-only create is stored as output', async () => {
    const created = await createGuardrail(TENANT_DB, 'tenant-direction', 'user-1', {
      name: 'Output email guard',
      action: 'block',
      projectId: 'proj-1',
      hooks: config([pii(['output.pre'])], ['output.pre']),
    } as Parameters<typeof createGuardrail>[3]);
    expect(created.target).toBe('output');
    expect(offeredAsInputPii(created)).toBe(false);
  });
});
