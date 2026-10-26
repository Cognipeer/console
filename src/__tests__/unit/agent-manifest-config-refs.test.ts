/**
 * Config references in the agent manifest: export keeps them as stored (never a value); import re-binds each
 * to the target project (by id when that item is there, else by key), drops and reports what cannot be
 * resolved, and needs Config read access only for references the overwritten agent did not already have.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row { _id: string; key: string; projectId?: string; groupId?: string; isSecret?: boolean }
let groups: Row[];
let items: Row[];
const created = vi.fn();
const updated = vi.fn();
const db = {
  switchToTenant: vi.fn(),
  findAgentByKey: vi.fn(),
  findSkillByKey: vi.fn(async () => null),
  findPromptByKey: vi.fn(async () => null),
  findMcpServerByKey: vi.fn(async () => null),
  findToolByKey: vi.fn(async () => null),
  findModelByKey: vi.fn(async () => ({ key: 'gpt' })),
  listConfigGroups: async (f: { projectId?: string }) => groups.filter((g) => g.projectId === f.projectId),
  listConfigItems: async (f: { projectId?: string }) => items.filter((i) => i.projectId === f.projectId),
  findConfigItemById: async (id: string) => items.find((i) => i._id === id) ?? null,
  findConfigGroupById: async (id: string) => groups.find((g) => g._id === id) ?? null,
  createAgent: async (data: Record<string, unknown>) => { created(data); return { _id: 'new', ...data }; },
  updateAgent: async (id: string, data: Record<string, unknown>) => { updated(data); return { _id: id, ...data }; },
};
const runWithTenantScope = vi.hoisted(() => vi.fn());
runWithTenantScope.mockImplementation(async (_name: string, fn: (d: typeof db) => unknown) => fn(db));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => db), runWithTenantScope }));

import { encryptObject } from '@/lib/utils/crypto';
import {
  applyAgentManifest,
  buildAgentManifest,
  ConfigReferenceForbiddenError,
} from '@/lib/services/agents/agentManifest';

const allow = async () => ({ allowed: true });
const manifestWith = (sandbox: Record<string, unknown>) => ({
  apiVersion: 'cognipeer.console/v1',
  kind: 'Agent',
  metadata: { key: 'support', name: 'Support', exportedAt: '2026-10-18T00:00:00Z' },
  spec: { modelKey: 'gpt', sandbox: { enabled: true, ...sandbox } },
  dependencies: [],
}) as never;

let canReference: ReturnType<typeof vi.fn>;
const apply = (manifest: never, over: Record<string, unknown> = {}) =>
  applyAgentManifest('t', 't1', 'p1', 'u1', manifest, { canNameBucket: allow, canReferenceConfig: canReference, ...over } as never);

beforeEach(() => {
  vi.clearAllMocks();
  groups = [{ _id: 'g1', key: 'shared', projectId: 'p1' }];
  items = [
    { _id: 'i1', key: 'region', groupId: 'g1', projectId: 'p1', isSecret: false },
    { _id: 'i2', key: 'api-key', groupId: 'g1', projectId: 'p1', isSecret: true },
  ];
  db.findAgentByKey.mockResolvedValue(null);
  canReference = vi.fn().mockResolvedValue(true);
});

describe('export', () => {
  it('keeps the references as stored and carries no value', () => {
    const sandbox = {
      enabled: true,
      envRefs: { REGION: { configId: 'i1', key: 'region', groupId: 'g1' } },
      secretRefs: { KEY: { configId: 'i2', key: 'api-key', groupId: 'g1' } },
      groupRefs: [{ groupId: 'g1', key: 'shared' }],
    };
    const manifest = buildAgentManifest({ key: 'a', name: 'A', status: 'draft' }, { modelKey: 'gpt', sandbox } as never);
    expect(manifest.spec.sandbox).toMatchObject(sandbox);
  });
});

describe('import', () => {
  it('keeps a reference whose id is in the target project and re-binds the others by key', async () => {
    await apply(manifestWith({
      envRefs: {
        REGION: { configId: 'i1', key: 'region', groupId: 'g1' },
        // Another environment's ids: found here by key.
        OTHER: { configId: 'foreign-id', key: 'region', groupId: 'foreign-group' },
      },
      secretRefs: { KEY: { configId: 'foreign-2', key: 'api-key' } },
      groupRefs: [{ groupId: 'foreign-group', key: 'shared' }],
    }));
    const stored = created.mock.calls[0][0].config.sandbox;
    expect(stored.envRefs).toEqual({
      REGION: { configId: 'i1', key: 'region', groupId: 'g1' },
      OTHER: { configId: 'i1', key: 'region', groupId: 'g1' },
    });
    expect(stored.secretRefs).toEqual({ KEY: { configId: 'i2', key: 'api-key', groupId: 'g1' } });
    expect(stored.groupRefs).toEqual([{ groupId: 'g1', key: 'shared' }]);
  });

  it('drops what the target project cannot resolve and reports it, without failing the import', async () => {
    const result = await apply(manifestWith({
      envRefs: {
        GONE: { configId: 'x', key: 'nowhere' },
        // A secret item cannot be an environment variable.
        SECRETY: { configId: 'x', key: 'api-key' },
        KEEP: { configId: 'i1', key: 'region' },
      },
      groupRefs: [{ groupId: 'x', key: 'missing-group' }],
    }));
    const stored = created.mock.calls[0][0].config.sandbox;
    expect(stored.envRefs).toEqual({ KEEP: { configId: 'i1', key: 'region', groupId: 'g1' } });
    expect(stored).not.toHaveProperty('groupRefs');
    expect(result.warnings.map((w) => w.code)).toEqual(['config_reference_dropped', 'config_reference_dropped', 'config_reference_dropped']);
    expect(result.warnings.map((w) => w.message).join(' ')).toMatch(/GONE[\s\S]*SECRETY[\s\S]*missing-group/);
  });

  it('does not touch the project config when the manifest has no references', async () => {
    const spy = vi.spyOn(db, 'listConfigItems');
    const result = await apply(manifestWith({ env: { A: '1' } }));
    expect(spy).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
    expect(canReference).not.toHaveBeenCalled();
  });

  it('needs Config read access for references the agent did not have, and throws before writing', async () => {
    canReference.mockResolvedValue(false);
    const error = await apply(manifestWith({ secretRefs: { KEY: { configId: 'i2', key: 'api-key' } } })).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigReferenceForbiddenError);
    expect(error.field).toBe('config.sandbox.secretRefs');
    expect(created).not.toHaveBeenCalled();
    // A caller that passes no check cannot add references either.
    const closed = await apply(manifestWith({ groupRefs: [{ groupId: 'g1', key: 'shared' }] }), { canReferenceConfig: undefined }).catch((e) => e);
    expect(closed).toBeInstanceOf(ConfigReferenceForbiddenError);
  });

  it('asks nothing for references the overwritten agent already stores', async () => {
    canReference.mockResolvedValue(false);
    db.findAgentByKey.mockResolvedValue({
      _id: 'ex', key: 'support',
      config: { modelKey: 'gpt', sandbox: { enabled: true, envRefs: { REGION: { configId: 'i1', key: 'region', groupId: 'g1' } } } },
    });
    await apply(manifestWith({ envRefs: { REGION: { configId: 'i1', key: 'region' } } }));
    expect(updated).toHaveBeenCalledTimes(1);
    expect(canReference).not.toHaveBeenCalled();
  });
});

describe('import: tenant scope, permission order and shape rules', () => {
  it('runs the whole import (config lookups and the write) inside one tenant scope', async () => {
    await apply(manifestWith({ envRefs: { REGION: { configId: 'i1', key: 'region' } } }));
    expect(runWithTenantScope).toHaveBeenCalledTimes(1);
    expect(runWithTenantScope.mock.calls[0][0]).toBe('t');
  });

  it('refuses before any Config lookup when the raw references add a target and the caller cannot read Config', async () => {
    canReference.mockResolvedValue(false);
    const spy = vi.spyOn(db, 'listConfigItems');
    // An unknown key would otherwise only produce a "dropped" warning that tells what the project holds.
    const error = await apply(manifestWith({ envRefs: { X: { configKey: 'nope' } } })).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigReferenceForbiddenError);
    expect(error.field).toBe('config.sandbox.envRefs');
    expect(spy).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('drops a ref whose name is also a typed value (env/secrets) and reports it', async () => {
    const result = await apply(manifestWith({
      env: { REGION: 'x' },
      // Only a sealed secrets block travels in a manifest (masked to its keys on the way in).
      secretsSealed: encryptObject({ KEY: 'v' }),
      envRefs: { REGION: { configId: 'i1', key: 'region' }, OTHER: { configId: 'i1', key: 'region' } },
      secretRefs: { KEY: { configId: 'i2', key: 'api-key' } },
    }));
    const stored = created.mock.calls[0][0].config.sandbox;
    expect(Object.keys(stored.envRefs)).toEqual(['OTHER']);
    expect(stored).not.toHaveProperty('secretRefs');
    expect(result.warnings.map((w) => w.code)).toEqual(['config_reference_dropped', 'config_reference_dropped']);
    expect(result.warnings[0].message).toMatch(/REGION[\s\S]*also set in env/);
    expect(result.warnings[1].message).toMatch(/KEY[\s\S]*also set in secrets/);
  });

  it('drops a secret ref whose name is a typed secret the overwritten agent keeps', async () => {
    db.findAgentByKey.mockResolvedValue({
      _id: 'ex', key: 'support',
      config: { modelKey: 'gpt', sandbox: { enabled: true, secretsSealed: encryptObject({ KEY: 'v' }) } },
    });
    // A real manifest carries no secrets: the stored ones stay, so a Config ref under the same name would lose.
    const result = await apply(manifestWith({ secretRefs: { KEY: { configId: 'i2', key: 'api-key' } } }));
    const stored = updated.mock.calls[0][0].config.sandbox;
    expect(stored).not.toHaveProperty('secretRefs');
    expect(stored.secretsSealed).toBeTruthy();
    expect(result.warnings.map((w) => w.message).join(' ')).toMatch(/KEY[\s\S]*also set in secrets/);
  });

  it('deletes refs that are not plain objects / arrays, with a warning', async () => {
    const result = await apply(manifestWith({ envRefs: ['a'], secretRefs: 'x', groupRefs: { groupId: 'g1' } }));
    const stored = created.mock.calls[0][0].config.sandbox;
    expect(stored).not.toHaveProperty('envRefs');
    expect(stored).not.toHaveProperty('secretRefs');
    expect(stored).not.toHaveProperty('groupRefs');
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.every((w) => w.code === 'config_reference_dropped')).toBe(true);
  });
});


describe('a persistent sandbox (instance mode)', () => {
  it('is left out of an export: the id names one project\'s machine', () => {
    const manifest = buildAgentManifest(
      { key: 'a', name: 'A', status: 'draft' },
      { modelKey: 'gpt', sandbox: { enabled: true, mode: 'instance', instanceId: 'sbx-1' } } as never,
    );
    expect(manifest.spec.sandbox).toEqual({ enabled: true, mode: 'instance' });
  });

  it('is never taken from a manifest, is kept when importing over the agent, and is reported when missing', async () => {
    db.findAgentByKey.mockResolvedValue({ _id: 'a1', key: 'support', config: { modelKey: 'gpt', sandbox: { enabled: true, mode: 'instance', instanceId: 'sbx-kept' } } });
    await apply(manifestWith({ mode: 'instance', instanceId: 'sbx-from-elsewhere' }));
    expect((updated.mock.calls[0][0] as { config: { sandbox: Record<string, unknown> } }).config.sandbox.instanceId).toBe('sbx-kept');

    db.findAgentByKey.mockResolvedValue(null);
    const result = await apply(manifestWith({ mode: 'instance', instanceId: 'sbx-from-elsewhere' }));
    expect((created.mock.calls[0][0] as { config: { sandbox: Record<string, unknown> } }).config.sandbox).not.toHaveProperty('instanceId');
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'sandbox_instance_unset' }));
  });
});
