/**
 * Writing `config.sandbox.envRefs / secretRefs / groupRefs` (create and update): references are normalized to
 * the stored shape against the request's project, a name cannot be both typed and referenced, and pointing at
 * a config item/group the stored config did not needs Config read access (re-saving stored refs asks nothing).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row { _id: string; key: string; projectId?: string; groupId?: string; isSecret?: boolean }
let groups: Row[];
let items: Row[];
const loadIndexCalls = vi.fn();

const mockDb = {
  listConfigGroups: async (f: { projectId?: string }) => { loadIndexCalls('groups'); return groups.filter((g) => g.projectId === f.projectId); },
  listConfigItems: async (f: { projectId?: string }) => items.filter((i) => i.projectId === f.projectId),
  findConfigItemById: async (id: string) => items.find((i) => i._id === id) ?? null,
  findConfigGroupById: async (id: string) => groups.find((g) => g._id === id) ?? null,
};
const runWithTenantScope = vi.hoisted(() => vi.fn());
runWithTenantScope.mockImplementation(async (_name: string, fn: (d: typeof mockDb) => unknown) => fn(mockDb));
vi.mock('@/lib/database', () => ({ runWithTenantScope }));
vi.mock('@/lib/services/agents', () => ({
  normalizeA2aMetadataUpdate: vi.fn(),
  prepareConnectionForStorage: vi.fn(),
  publishAgent: vi.fn(),
}));
vi.mock('@/lib/services/agents/agentService', () => ({ AgentGuardrailBlockedError: class extends Error {} }));
vi.mock('@/server/api/plugins/guardrail-bindings', () => ({
  carriedGuardrailFields: () => ({}),
  resolveConfigGuardrailBindings: async () => ({}),
}));
vi.mock('@/lib/services/agents/agentConfigValidation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/agents/agentConfigValidation')>()),
  validateAgentConfig: async () => ({ errors: [], warnings: [] }),
}));

import { prepareNewAgentConfig, validateNativeConfigUpdate, type AgentConfigWriteScope } from '@/server/api/plugins/agent-config-write';
import type { IAgentConfig } from '@/lib/database';

let canReference: ReturnType<typeof vi.fn>;
const scope = (): AgentConfigWriteScope => ({
  tenantDbName: 'tdb',
  tenantId: 't',
  projectId: 'p1',
  canNameBucket: async () => ({ allowed: true }),
  canReferenceConfig: canReference as never,
});

const config = (sandbox: Record<string, unknown>): Record<string, unknown> => ({
  modelKey: 'gpt',
  sandbox: { enabled: true, ...sandbox },
});

beforeEach(() => {
  groups = [{ _id: 'g1', key: 'shared', projectId: 'p1' }, { _id: 'g9', key: 'foreign', projectId: 'p2' }];
  items = [
    { _id: 'i1', key: 'region', groupId: 'g1', projectId: 'p1', isSecret: false },
    { _id: 'i2', key: 'api-key', groupId: 'g1', projectId: 'p1', isSecret: true },
    { _id: 'i9', key: 'other', groupId: 'g9', projectId: 'p2', isSecret: false },
  ];
  canReference = vi.fn().mockResolvedValue(true);
  loadIndexCalls.mockClear();
  runWithTenantScope.mockClear();
});

describe('prepareNewAgentConfig with config references', () => {
  it('stores the normalized shape (ids), resolving keys against the request project', async () => {
    const out = await prepareNewAgentConfig(config({
      envRefs: { REGION: { configKey: 'region' } },
      secretRefs: { KEY: { configId: 'i2' } },
      groupRefs: [{ groupKey: 'shared' }, { groupId: 'g1' }],
    }), scope());
    expect('config' in out).toBe(true);
    if (!('config' in out)) return;
    expect(out.config.sandbox).toMatchObject({
      envRefs: { REGION: { configId: 'i1', key: 'region', groupId: 'g1' } },
      secretRefs: { KEY: { configId: 'i2', key: 'api-key', groupId: 'g1' } },
      groupRefs: [{ groupId: 'g1', key: 'shared' }],
    });
  });

  it('drops empty reference fields and does not load Config when none is sent', async () => {
    const empty = await prepareNewAgentConfig(config({ envRefs: {}, groupRefs: [] }), scope());
    expect('config' in empty && empty.config.sandbox).toEqual({ enabled: true });
    expect(loadIndexCalls).not.toHaveBeenCalled();
    expect(canReference).not.toHaveBeenCalled();
    const none = await prepareNewAgentConfig(config({ env: { A: '1' } }), scope());
    expect('config' in none).toBe(true);
    expect(loadIndexCalls).not.toHaveBeenCalled();
  });

  it.each([
    ['a secret item under envRefs', { envRefs: { KEY: { configId: 'i2' } } }, 'config.sandbox.envRefs.KEY'],
    ['an item of another project', { secretRefs: { X: { configId: 'i9' } } }, 'config.sandbox.secretRefs.X'],
    ['an unknown key', { envRefs: { X: { configKey: 'nope' } } }, 'config.sandbox.envRefs.X'],
    ['a group of another project', { groupRefs: [{ groupId: 'g9' }] }, 'config.sandbox.groupRefs[0]'],
    ['a bad variable name', { envRefs: { '1BAD': { configKey: 'region' } } }, 'config.sandbox.envRefs.1BAD'],
    ['a name typed in env too', { env: { REGION: 'x' }, envRefs: { REGION: { configKey: 'region' } } }, 'config.sandbox.envRefs.REGION'],
    ['a name typed in secrets too', { secrets: { KEY: 'x' }, secretRefs: { KEY: { configKey: 'api-key' } } }, 'config.sandbox.secretRefs.KEY'],
  ])('answers 400 with the field path for %s', async (_label, sandbox, field) => {
    const out = await prepareNewAgentConfig(config(sandbox), scope());
    expect(out).toHaveProperty('badRequest');
    const body = (out as { badRequest: { validation: { errors: Array<{ field: string }> } } }).badRequest;
    expect(body.validation.errors.map((e) => e.field)).toContain(field);
    // Permission is asked first (these references are new), then the lookup says what is wrong.
    expect(canReference).toHaveBeenCalled();
  });

  it('binds the whole normalization to one tenant scope, and none when no reference is sent', async () => {
    await prepareNewAgentConfig(config({ envRefs: { REGION: { configKey: 'region' } } }), scope());
    expect(runWithTenantScope).toHaveBeenCalledTimes(1);
    expect(runWithTenantScope.mock.calls[0][0]).toBe('tdb');
    runWithTenantScope.mockClear();
    await prepareNewAgentConfig(config({ env: { A: '1' } }), scope());
    expect(runWithTenantScope).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown key', { envRefs: { X: { configKey: 'nope' } } }, 'config.sandbox.envRefs'],
    ['a secret item under envRefs', { envRefs: { KEY: { configKey: 'api-key' } } }, 'config.sandbox.envRefs'],
    ['a group of another project', { groupRefs: [{ groupId: 'g9' }] }, 'config.sandbox.groupRefs'],
    ['an unknown group key', { groupRefs: [{ groupKey: 'nope' }] }, 'config.sandbox.groupRefs'],
  ])('answers 403 before any lookup (no 400 that reveals what Config holds) for %s without Config read', async (_label, sandbox, field) => {
    canReference.mockResolvedValue(false);
    const out = await prepareNewAgentConfig(config(sandbox), scope());
    expect(out).toEqual({ forbidden: expect.objectContaining({ code: 'config_read_required', field }) });
    expect(runWithTenantScope).not.toHaveBeenCalled();
    expect(loadIndexCalls).not.toHaveBeenCalled();
  });

  it('answers 403 config_read_required when the caller may not read Config', async () => {
    canReference.mockResolvedValue(false);
    const out = await prepareNewAgentConfig(config({ secretRefs: { KEY: { configId: 'i2' } } }), scope());
    expect(out).toEqual({
      forbidden: expect.objectContaining({ code: 'config_read_required', type: 'config_read_required', field: 'config.sandbox.secretRefs' }),
    });
    const group = await prepareNewAgentConfig(config({ groupRefs: [{ groupId: 'g1' }] }), scope());
    expect(group).toEqual({ forbidden: expect.objectContaining({ field: 'config.sandbox.groupRefs' }) });
  });
});

describe('validateNativeConfigUpdate with config references', () => {
  const stored = {
    modelKey: 'gpt',
    sandbox: {
      enabled: true,
      envRefs: { REGION: { configId: 'i1', key: 'region', groupId: 'g1' } },
      groupRefs: [{ groupId: 'g1', key: 'shared' }],
    },
  } as unknown as IAgentConfig;

  it('asks nothing when the stored references are re-saved', async () => {
    canReference.mockResolvedValue(false);
    const out = await validateNativeConfigUpdate(
      config({ envRefs: { REGION: { configId: 'i1', key: 'region' } }, groupRefs: [{ groupKey: 'shared' }] }),
      'bot', scope(), stored,
    );
    expect(out).toEqual({ warnings: [] });
    expect(canReference).not.toHaveBeenCalled();
  });

  it('asks only for what is new, and answers 403 without Config read', async () => {
    canReference.mockResolvedValue(false);
    const out = await validateNativeConfigUpdate(
      config({ envRefs: { REGION: { configId: 'i1' } }, secretRefs: { KEY: { configId: 'i2' } }, groupRefs: [{ groupId: 'g1' }] }),
      'bot', scope(), stored,
    );
    expect(out).toEqual({ forbidden: expect.objectContaining({ code: 'config_read_required', field: 'config.sandbox.secretRefs' }) });
    expect(canReference).toHaveBeenCalledTimes(1);
  });

  it('accepts a new reference with Config read access, and removing references asks nothing', async () => {
    const added = await validateNativeConfigUpdate(config({ secretRefs: { KEY: { configId: 'i2' } } }), 'bot', scope(), stored);
    expect(added).toEqual({ warnings: [] });
    expect(canReference).toHaveBeenCalledTimes(1);
    canReference.mockClear();
    canReference.mockResolvedValue(false);
    const removed = await validateNativeConfigUpdate(config({}), 'bot', scope(), stored);
    expect(removed).toEqual({ warnings: [] });
    expect(canReference).not.toHaveBeenCalled();
  });

  it('asks nothing for a stored reference sent by key, but 403s before lookup for a new key on update', async () => {
    canReference.mockResolvedValue(false);
    const byKey = await validateNativeConfigUpdate(config({ envRefs: { REGION: { configKey: 'region' } } }), 'bot', scope(), stored);
    expect(byKey).toEqual({ warnings: [] });
    runWithTenantScope.mockClear();
    const fresh = await validateNativeConfigUpdate(config({ envRefs: { NEW: { configKey: 'nope' } } }), 'bot', scope(), stored);
    expect(fresh).toEqual({ forbidden: expect.objectContaining({ field: 'config.sandbox.envRefs' }) });
    expect(runWithTenantScope).not.toHaveBeenCalled();
  });

  it('refuses an overlap with typed values on update too', async () => {
    const out = await validateNativeConfigUpdate(
      config({ env: { REGION: 'x' }, envRefs: { REGION: { configId: 'i1' } } }), 'bot', scope(), stored,
    );
    expect(out).toHaveProperty('badRequest');
  });
});
