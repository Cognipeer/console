/**
 * Choosing a persistent sandbox for an agent (`config.sandbox.instanceId`) is a Sandbox decision: a write that
 * sets or changes it needs Sandbox write (`canUseSandbox`), asked before validation (whose lookup would tell the
 * caller which sandboxes exist), and fails closed when the route passes no answer. Re-saving or clearing the
 * stored id asks nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = {
  listConfigGroups: async () => [],
  listConfigItems: async () => [],
  findConfigItemById: async () => null,
  findConfigGroupById: async () => null,
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
const validateAgentConfig = vi.hoisted(() => vi.fn(async () => ({ errors: [], warnings: [] })));
vi.mock('@/lib/services/agents/agentConfigValidation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/agents/agentConfigValidation')>()),
  validateAgentConfig,
}));

import { prepareNewAgentConfig, validateNativeConfigUpdate, type AgentConfigWriteScope } from '@/server/api/plugins/agent-config-write';
import type { IAgentConfig } from '@/lib/database';

let canUseSandbox: ReturnType<typeof vi.fn>;
const scope = (withSandbox = true): AgentConfigWriteScope => ({
  tenantDbName: 'tdb',
  tenantId: 't',
  projectId: 'p1',
  canNameBucket: async () => ({ allowed: true }),
  canReferenceConfig: async () => true,
  ...(withSandbox ? { canUseSandbox: canUseSandbox as never } : {}),
});

const config = (sandbox: Record<string, unknown>): Record<string, unknown> => ({
  modelKey: 'gpt',
  sandbox: { enabled: true, ...sandbox },
});

const stored = { modelKey: 'gpt', sandbox: { enabled: true, mode: 'instance', instanceId: 'sbx-1' } } as unknown as IAgentConfig;

beforeEach(() => {
  canUseSandbox = vi.fn().mockResolvedValue(true);
  validateAgentConfig.mockClear();
});

describe('choosing a persistent sandbox', () => {
  it('a new agent with one needs Sandbox write, asked before validation', async () => {
    canUseSandbox.mockResolvedValue(false);
    const out = await prepareNewAgentConfig(config({ mode: 'instance', instanceId: 'sbx-1' }), scope());
    expect(out).toEqual({ forbidden: expect.objectContaining({ code: 'sandbox_write_required', field: 'config.sandbox.instanceId' }) });
    expect(validateAgentConfig).not.toHaveBeenCalled();
  });

  it('is accepted with Sandbox write', async () => {
    const out = await prepareNewAgentConfig(config({ mode: 'instance', instanceId: 'sbx-1' }), scope());
    expect('config' in out).toBe(true);
    expect(canUseSandbox).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the route passes no answer', async () => {
    const out = await prepareNewAgentConfig(config({ mode: 'instance', instanceId: 'sbx-1' }), scope(false));
    expect(out).toEqual({ forbidden: expect.objectContaining({ code: 'sandbox_write_required' }) });
  });

  it('is asked even while the sandbox is switched off or in another mode (it could be turned on later)', async () => {
    canUseSandbox.mockResolvedValue(false);
    const off = await prepareNewAgentConfig({ modelKey: 'gpt', sandbox: { enabled: false, instanceId: 'sbx-1' } }, scope());
    expect(off).toEqual({ forbidden: expect.objectContaining({ code: 'sandbox_write_required' }) });
  });

  it('re-saving or clearing the stored sandbox asks nothing; changing it asks', async () => {
    canUseSandbox.mockResolvedValue(false);
    expect(await validateNativeConfigUpdate(config({ mode: 'instance', instanceId: 'sbx-1' }), 'bot', scope(), stored)).toEqual({ warnings: [] });
    expect(await validateNativeConfigUpdate(config({ mode: 'session' }), 'bot', scope(), stored)).toEqual({ warnings: [] });
    expect(canUseSandbox).not.toHaveBeenCalled();
    const changed = await validateNativeConfigUpdate(config({ mode: 'instance', instanceId: 'sbx-2' }), 'bot', scope(), stored);
    expect(changed).toEqual({ forbidden: expect.objectContaining({ code: 'sandbox_write_required' }) });
    expect(canUseSandbox).toHaveBeenCalledTimes(1);
  });

  it('a config without one asks nothing', async () => {
    const out = await prepareNewAgentConfig(config({ mode: 'session', templateKey: 'multi-base' }), scope(false));
    expect('config' in out).toBe(true);
  });
});
