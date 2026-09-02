/**
 * The MongoDB guardrail mixin, against a stubbed `Db`: what it WRITES and what
 * it ASKS, at the driver boundary.
 *
 * `createGuardrail` used to spread the input straight into `insertOne`. The
 * BSON serializer turns an EXPLICIT `undefined` into null, so a legacy-shaped
 * or tenant-wide create (`hooks: undefined, hooksVersion: undefined, mode:
 * undefined, projectId: undefined` — exactly what the service layer passes)
 * persisted `hooks: null`, `hooksVersion: null`, `mode: null`, `projectId:
 * null`, while SQLite yielded `undefined` / `'enforce'` for the same input.
 * The API then returned `mode: null` on Mongo only. `updateGuardrail` already
 * stripped undefined keys; the insert now does too, and derives `mode` from
 * `enabled` as the SQLite INSERT does.
 *
 * The lookup half pins the filter the `null` contract emits: `{ projectId:
 * null }`, which in Mongo matches a null field AND a missing one — both
 * spellings of "tenant-wide" that exist on disk.
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { MongoDBProviderBase } from '@/lib/database/mongodb/base';
import { GuardrailMixin } from '@/lib/database/mongodb/guardrail.mixin';
import type { IGuardrail } from '@/lib/database/provider.interface';

/**
 * The mixin over a base whose tenant `Db` is a recorder: `insertOne` keeps the
 * document it was handed, `findOne` keeps the filter. Nothing is connected.
 */
class RecordingGuardrailProvider extends GuardrailMixin(MongoDBProviderBase) {
  inserted: Record<string, unknown> | undefined;
  filters: Array<Record<string, unknown>> = [];

  constructor() {
    super('mongodb://unused.invalid:27017', 'unused_main');
  }

  protected override getTenantDb(): Db {
    const collection = {
      insertOne: async (doc: Record<string, unknown>) => {
        this.inserted = doc;
        return { acknowledged: true, insertedId: new ObjectId() };
      },
      findOne: async (filter: Record<string, unknown>) => {
        this.filters.push(filter);
        return null;
      },
    };
    return { collection: () => collection } as unknown as Db;
  }
}

function legacyShapedCreate(
  overrides: Partial<Omit<IGuardrail, '_id' | 'createdAt' | 'updatedAt'>> = {},
): Omit<IGuardrail, '_id' | 'createdAt' | 'updatedAt'> {
  return {
    tenantId: 'tenant-a',
    // Exactly what guardrailService.createGuardrail passes for a tenant-wide,
    // legacy-shaped preset: every optional field present and undefined.
    projectId: undefined,
    key: 'pii-basic',
    name: 'PII basic',
    description: undefined,
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    failMode: 'open',
    modelKey: undefined,
    policy: { pii: { enabled: true, action: 'block', categories: { email: true } } },
    customPrompt: undefined,
    hooks: undefined,
    hooksVersion: undefined,
    mode: undefined,
    createdBy: 'user-1',
    ...overrides,
  };
}

describe('MongoDB createGuardrail', () => {
  it('inserts no null- or undefined-valued key for an absent field', async () => {
    const provider = new RecordingGuardrailProvider();

    await provider.createGuardrail(legacyShapedCreate());

    const inserted = provider.inserted ?? {};
    for (const [key, value] of Object.entries(inserted)) {
      expect(value, `inserted.${key}`).not.toBeNull();
      expect(value, `inserted.${key}`).not.toBeUndefined();
    }
    for (const absent of ['projectId', 'description', 'modelKey', 'customPrompt', 'hooks', 'hooksVersion']) {
      expect(absent in inserted, `inserted has no "${absent}"`).toBe(false);
    }
    // What was given is still there.
    expect(inserted.key).toBe('pii-basic');
    expect(inserted.policy).toEqual({ pii: { enabled: true, action: 'block', categories: { email: true } } });
    expect(inserted.createdAt).toBeInstanceOf(Date);
  });

  it('derives mode from enabled exactly as the SQLite INSERT does', async () => {
    const enabled = new RecordingGuardrailProvider();
    const created = await enabled.createGuardrail(legacyShapedCreate({ enabled: true }));
    expect(enabled.inserted?.mode).toBe('enforce');
    expect(created.mode).toBe('enforce');

    const disabled = new RecordingGuardrailProvider();
    await disabled.createGuardrail(legacyShapedCreate({ enabled: false }));
    expect(disabled.inserted?.mode).toBe('disabled');

    const explicit = new RecordingGuardrailProvider();
    await explicit.createGuardrail(legacyShapedCreate({ enabled: true, mode: 'monitor' }));
    expect(explicit.inserted?.mode).toBe('monitor');
  });

  it('keeps an authored hooks config and its version intact', async () => {
    const provider = new RecordingGuardrailProvider();
    const hooks = { contractVersion: 2, policies: [], bindings: {} } as unknown as IGuardrail['hooks'];

    await provider.createGuardrail(legacyShapedCreate({ hooks, hooksVersion: 2, projectId: 'proj-a' }));

    expect(provider.inserted?.hooks).toEqual(hooks);
    expect(provider.inserted?.hooksVersion).toBe(2);
    expect(provider.inserted?.projectId).toBe('proj-a');
  });
});

describe('MongoDB findGuardrailByKey filter', () => {
  it('emits { projectId: null } for the tenant-wide question and no clause for "any"', async () => {
    const provider = new RecordingGuardrailProvider();

    await provider.findGuardrailByKey('k', 'proj-a');
    await provider.findGuardrailByKey('k', null);
    await provider.findGuardrailByKey('k');

    expect(provider.filters).toEqual([
      { key: 'k', projectId: 'proj-a' },
      { key: 'k', projectId: null },
      { key: 'k' },
    ]);
  });

  it('applies the same three-way filter to word lists', async () => {
    const provider = new RecordingGuardrailProvider();

    await provider.findGuardrailWordListByKey('list', null);
    await provider.findGuardrailWordListByKey('list', 'proj-b');
    await provider.findGuardrailWordListByKey('list');

    expect(provider.filters).toEqual([
      { key: 'list', projectId: null },
      { key: 'list', projectId: 'proj-b' },
      { key: 'list' },
    ]);
  });
});
