import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';

const encrypted = new Set(['bad-cipher']);
vi.mock('@/lib/services/config/configService', () => ({
  openConfigItemValue: (item: { value: string; key: string }) => {
    if (encrypted.has(item.value)) throw new Error('cannot decrypt');
    return item.value;
  },
}));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { resolveAgentSandboxConfigVars } from '@/lib/services/agents/agentSandboxConfigVars';

interface Item { _id: string; key: string; value: string; isSecret: boolean; groupId: string; projectId?: string; version: number }
let items: Item[];
let groups: Array<{ _id: string; key: string; projectId?: string }>;
let audit: Array<Record<string, unknown>>;

const db = () => ({
  findConfigGroupById: async (id: string) => groups.find((g) => g._id === id) ?? null,
  findConfigItemById: async (id: string) => items.find((i) => i._id === id) ?? null,
  listConfigItems: async (f: { groupId?: string }) => items.filter((i) => !f.groupId || i.groupId === f.groupId),
  createConfigAuditLog: async (entry: Record<string, unknown>) => { audit.push(entry); return entry; },
}) as unknown as DatabaseProvider;

const base = { tenantDbName: 'tdb', tenantId: 't', projectId: 'p1', agentKey: 'bot' };
const item = (id: string, key: string, value: string, isSecret = false, over: Partial<Item> = {}): Item =>
  ({ _id: id, key, value, isSecret, groupId: 'g1', projectId: 'p1', version: 2, ...over });

beforeEach(() => {
  groups = [{ _id: 'g1', key: 'shared', projectId: 'p1' }];
  items = [
    item('i1', 'region', 'eu-west'),
    item('i2', 'api-key', 'sk-secret-123', true),
    item('i3', 'cfg-log-level', 'debug'),
  ];
  audit = [];
});

describe('resolveAgentSandboxConfigVars', () => {
  it('returns the typed values untouched, without reading Config, when there are no references', async () => {
    const out = await resolveAgentSandboxConfigVars({
      ...base, db: db(), secrets: { TOKEN: 'abcd' }, sandbox: { enabled: true, env: { A: '1' } },
    });
    expect(out).toEqual({ machineEnv: { A: '1' }, secrets: { TOKEN: 'abcd' }, problems: [] });
    expect(audit).toEqual([]);
  });

  it('puts plain config values on the machine and secret ones in the secrets', async () => {
    const out = await resolveAgentSandboxConfigVars({
      ...base, db: db(),
      sandbox: {
        enabled: true,
        env: { A: '1' },
        envRefs: { REGION: { configId: 'i1', key: 'region' } },
        secretRefs: { KEY: { configId: 'i2', key: 'api-key' } },
      },
      secrets: { TOKEN: 'abcd' },
    });
    expect(out.machineEnv).toEqual({ A: '1', REGION: 'eu-west' });
    expect(out.secrets).toEqual({ TOKEN: 'abcd', KEY: 'sk-secret-123' });
    expect(out.problems).toEqual([]);
  });

  it('never puts a secret value on the machine: an envRefs item that became secret goes to the secrets', async () => {
    const out = await resolveAgentSandboxConfigVars({
      ...base, db: db(), sandbox: { enabled: true, envRefs: { REGION: { configId: 'i2', key: 'api-key' } } },
    });
    expect(out.machineEnv).toEqual({});
    expect(out.secrets).toEqual({ REGION: 'sk-secret-123' });
  });

  it('keeps a secretRefs entry secret even when its item is plain now', async () => {
    const out = await resolveAgentSandboxConfigVars({
      ...base, db: db(), sandbox: { enabled: true, secretRefs: { LVL: { configId: 'i1', key: 'region' } } },
    });
    expect(out.secrets).toEqual({ LVL: 'eu-west' });
    expect(out.machineEnv).toEqual({});
  });

  it('binds a whole group: secret items to the secrets, the others to the machine, named after the key', async () => {
    const out = await resolveAgentSandboxConfigVars({
      ...base, db: db(), sandbox: { enabled: true, groupRefs: [{ groupId: 'g1', key: 'shared' }] },
    });
    expect(out.machineEnv).toEqual({ LOG_LEVEL: 'debug', REGION: 'eu-west' });
    expect(out.secrets).toEqual({ API_KEY: 'sk-secret-123' });
  });

  it('lets a typed name or a single reference beat a bound group', async () => {
    const out = await resolveAgentSandboxConfigVars({
      ...base, db: db(),
      sandbox: {
        enabled: true,
        env: { REGION: 'typed' },
        envRefs: { LOG_LEVEL: { configId: 'i1', key: 'region' } },
        groupRefs: [{ groupId: 'g1', key: 'shared' }],
      },
      secrets: { API_KEY: 'typed-secret' },
    });
    expect(out.machineEnv).toEqual({ REGION: 'typed', LOG_LEVEL: 'eu-west' });
    expect(out.secrets).toEqual({ API_KEY: 'typed-secret' });
    // The group's items that lost were never read, so the secret one is not audited.
    expect(audit).toEqual([]);
  });

  it('leaves out a reference that cannot be used and reports it; the others still resolve', async () => {
    items.push(item('i4', 'broken', 'bad-cipher', true), item('i5', 'elsewhere', 'x', false, { projectId: 'p2' }));
    const out = await resolveAgentSandboxConfigVars({
      ...base, db: db(),
      sandbox: {
        enabled: true,
        envRefs: { GONE: { configId: 'nope', key: 'removed' }, REGION: { configId: 'i1', key: 'region' } },
        secretRefs: { BROKEN: { configId: 'i4', key: 'broken' }, OTHER: { configId: 'i5', key: 'elsewhere' } },
      },
    });
    expect(out.machineEnv).toEqual({ REGION: 'eu-west' });
    expect(out.secrets).toEqual({});
    expect(out.problems.map((p) => [p.reason, p.name])).toEqual(
      expect.arrayContaining([['missing', 'GONE'], ['unreadable', 'BROKEN'], ['other_project', 'OTHER']]),
    );
    expect(JSON.stringify(out.problems)).not.toContain('sk-secret');
  });

  it('reads each secret item once and audits it as the agent', async () => {
    await resolveAgentSandboxConfigVars({
      ...base, db: db(),
      sandbox: {
        enabled: true,
        secretRefs: { KEY: { configId: 'i2', key: 'api-key' } },
        groupRefs: [{ groupId: 'g1', key: 'shared' }],
      },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ configKey: 'api-key', action: 'read', performedBy: 'agent:bot', projectId: 'p1' });
  });

  it('keeps typed env + Config machine env within 100 variables: explicit refs first, then group items; the rest is a limit problem', async () => {
    groups.push({ _id: 'g2', key: 'big', projectId: 'p1' });
    for (let n = 0; n < 60; n += 1) items.push(item(`b${n}`, `big-${String(n).padStart(2, '0')}`, 'v', false, { groupId: 'g2' }));
    const typedEnv = Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`T${n}`, '1']));
    const out = await resolveAgentSandboxConfigVars({
      ...base, db: db(),
      sandbox: { enabled: true, env: typedEnv, envRefs: { REGION: { configId: 'i1', key: 'region', groupId: 'g1' } }, groupRefs: [{ groupId: 'g2', key: 'big' }] },
    });
    expect(Object.keys(out.machineEnv)).toHaveLength(100);
    // The agent's own env and the single-item ref are never the ones dropped.
    expect(Object.keys(typedEnv).every((name) => name in out.machineEnv)).toBe(true);
    expect(out.machineEnv.REGION).toBe('eu-west');
    const limited = out.problems.filter((p) => p.reason === 'limit');
    expect(limited).toHaveLength(11);
    expect(limited[0].message).toMatch(/at most 100 variables/);
    expect(JSON.stringify(out.problems)).not.toMatch(/"v"/);
  });

  it('leaves a Config value larger than 32 KiB out of the machine env with a limit problem, and the run goes on', async () => {
    items.push(item('i9', 'huge', 'x'.repeat(32 * 1024 + 1)));
    const out = await resolveAgentSandboxConfigVars({
      ...base, db: db(),
      sandbox: { enabled: true, envRefs: { HUGE: { configId: 'i9', key: 'huge' }, REGION: { configId: 'i1', key: 'region' } } },
    });
    expect(out.machineEnv).toEqual({ REGION: 'eu-west' });
    expect(out.problems).toEqual([expect.objectContaining({ reason: 'limit', name: 'HUGE' })]);
    expect(out.problems[0].message).not.toContain('xxxx');
  });

  it('does not cap secrets or a value of exactly 32 KiB', async () => {
    items.push(item('i9', 'edge', 'y'.repeat(32 * 1024)));
    const out = await resolveAgentSandboxConfigVars({
      ...base, db: db(),
      sandbox: { enabled: true, envRefs: { EDGE: { configId: 'i9', key: 'edge' } }, secretRefs: { KEY: { configId: 'i2', key: 'api-key' } } },
    });
    expect(out.machineEnv.EDGE).toHaveLength(32 * 1024);
    expect(out.secrets).toEqual({ KEY: 'sk-secret-123' });
    expect(out.problems).toEqual([]);
  });
});
