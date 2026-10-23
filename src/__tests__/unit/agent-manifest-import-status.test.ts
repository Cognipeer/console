import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = {
  switchToTenant: vi.fn(),
  findAgentByKey: vi.fn(),
  findSkillByKey: vi.fn(async () => null),
  findPromptByKey: vi.fn(async () => null),
  findMcpServerByKey: vi.fn(async () => null),
  findToolByKey: vi.fn(async () => null),
  findModelByKey: vi.fn(async () => ({ key: 'gpt' })),
};
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (d: typeof db) => unknown) => fn(db)),
}));

import { applyAgentManifest, AgentManifestError, manifestErrorStatus } from '@/lib/services/agents/agentManifest';

const manifest = {
  apiVersion: 'cognipeer.console/v1',
  kind: 'Agent',
  metadata: { key: 'support', name: 'Support', exportedAt: '2026-10-18T00:00:00Z' },
  spec: { modelKey: 'gpt' },
  dependencies: [],
} as never;
const opts = { canNameBucket: async () => ({ allowed: true }) } as never;

beforeEach(() => vi.clearAllMocks());

describe('manifest import errors map to their HTTP status', () => {
  it('create over an existing key is a 409 agent_key_conflict', async () => {
    db.findAgentByKey.mockResolvedValue({ _id: 'x', key: 'support' });
    const error = await applyAgentManifest('t', 't1', 'p1', 'u1', manifest, { ...(opts as object), mode: 'create' } as never).catch((e) => e);
    expect(error).toBeInstanceOf(AgentManifestError);
    expect(error.code).toBe('agent_key_conflict');
    expect(manifestErrorStatus(error)).toBe(409);
  });

  it('update of a missing key is a 404', async () => {
    db.findAgentByKey.mockResolvedValue(null);
    const error = await applyAgentManifest('t', 't1', 'p1', 'u1', manifest, { ...(opts as object), mode: 'update' } as never).catch((e) => e);
    expect(manifestErrorStatus(error)).toBe(404);
  });

  it('other manifest errors stay 400', () => {
    expect(manifestErrorStatus(new AgentManifestError('bad'))).toBe(400);
  });
});
