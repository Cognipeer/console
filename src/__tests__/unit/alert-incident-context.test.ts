import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

/** The mock db with every method as a plain vitest mock: tests feed it partial rows. */
type LooseDb = Record<string, import('vitest').Mock>;
import {
  ENRICHER_TIMEOUT_MS,
  buildIncidentContext,
  normalizeErrorSignature,
  summarizeErrorSignatures,
} from '@/lib/services/alerts/incidentContext';
import { __resetAlertExtensionsForTests, registerIncidentEnricher } from '@/enterprise/alert-extensions';
import type { IAlertRule } from '@/lib/database';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

const rule = {
  _id: 'r1', tenantId: 't', projectId: 'p1', name: 'Agent errors', module: 'agents', metric: 'agent_error_rate',
  condition: { operator: 'gt', threshold: 10 }, windowMinutes: 15, cooldownMinutes: 60, enabled: true, channels: [],
} as unknown as IAlertRule;

describe('normalizeErrorSignature', () => {
  it('masks uuids, long ids, hex and numbers, and keeps only the first line', () => {
    expect(normalizeErrorSignature('Timeout after 30000 ms for 123e4567-e89b-12d3-a456-426614174000\nstack line')).toBe('Timeout after <n> ms for <id>');
    expect(normalizeErrorSignature('bad pointer 0xdeadbeef')).toBe('bad pointer <hex>');
    expect(normalizeErrorSignature('token abcdef0123456789abcdef failed')).toBe('token <id> failed');
  });

  it('collapses whitespace, truncates to 160 chars and ignores non-strings', () => {
    expect(normalizeErrorSignature('a   b\t c')).toBe('a b c');
    const long = normalizeErrorSignature('x'.repeat(500));
    expect(long.length).toBe(160);
    expect(long.endsWith('…')).toBe(true);
    expect(normalizeErrorSignature(undefined)).toBe('');
    expect(normalizeErrorSignature(42)).toBe('');
    expect(normalizeErrorSignature('\n\n  \nreal line')).toBe('real line');
  });
});

describe('summarizeErrorSignatures', () => {
  it('counts a signature once per session, orders by count then text, and keeps the top five', () => {
    const sessions = [
      { errors: [{ message: 'Rate limit 429' }, { message: 'Rate limit 429' }, { message: 'Rate limit 431' }] },
      { errors: [{ message: 'Rate limit 500' }] },
      { errors: [{ message: 'Boom' }] },
      { errors: null },
      {},
      { errors: [{ message: 'a1' }, { message: 'b1' }, { message: 'c1' }, { message: 'd1' }, { message: 'e1' }] },
    ];
    const result = summarizeErrorSignatures(sessions as never);
    expect(result[0]).toEqual({ message: 'Rate limit <n>', count: 2 });
    expect(result).toHaveLength(5);
    expect(result.slice(1).every((s) => s.count === 1)).toBe(true);
    expect(result.slice(1).map((s) => s.message)).toEqual([...result.slice(1).map((s) => s.message)].sort((a, b) => a.localeCompare(b)));
  });
});

describe('buildIncidentContext', () => {
  let db: LooseDb;
  const input = (overrides: Record<string, unknown> = {}) => ({
    db: db as never,
    tenantDbName: 'd',
    tenantId: 't',
    projectId: 'p1',
    rule,
    entityType: 'agent' as const,
    entityKey: 'Pulse Main',
    windowMinutes: 15,
    nowMs: NOW,
    ...overrides,
  });

  const session = (version?: string, errors?: string[]) => ({
    agentVersion: version,
    errors: errors?.map((message) => ({ message })),
  });

  beforeEach(() => {
    __resetAlertExtensionsForTests();
    db = createMockDb() as unknown as LooseDb;
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [], total: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetAlertExtensionsForTests();
  });

  it('has only mode and window for a non-agent target and never touches sessions', async () => {
    const context = await buildIncidentContext(input({ entityType: 'model', entityKey: 'gpt' }));
    expect(context).toEqual({ mode: 'threshold', windowMinutes: 15 });
    expect(db.listAgentTracingSessions).not.toHaveBeenCalled();
  });

  it('reports the mode of the rule condition', async () => {
    const baselineRule = { ...rule, condition: { ...rule.condition, mode: 'baseline' } } as IAlertRule;
    expect((await buildIncidentContext(input({ rule: baselineRule, entityType: null, entityKey: '' }))).mode).toBe('baseline');
  });

  it('queries the project, the exact agent name and the current and previous windows', async () => {
    await buildIncidentContext(input());
    expect(db.listAgentTracingSessions).toHaveBeenCalledTimes(3);
    const calls = db.listAgentTracingSessions.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const windowMs = 15 * 60_000;
    const current = calls.find((c) => c.from === new Date(NOW - windowMs).toISOString() && !c.status)!;
    const previous = calls.find((c) => c.to === new Date(NOW - windowMs).toISOString())!;
    const failed = calls.find((c) => c.status === 'error')!;
    expect(current.to).toBe(new Date(NOW).toISOString());
    expect(previous.from).toBe(new Date(NOW - 2 * windowMs).toISOString());
    for (const c of calls) expect(c.agentNameExact).toBe('Pulse Main');
    expect(failed.includeTotal).toBe(true);
    for (const call of db.listAgentTracingSessions.mock.calls) expect(call[1]).toBe('p1');
  });

  it('detects a version that appeared in this window', async () => {
    db.listAgentTracingSessions.mockImplementation(async (q: { status?: string; to: string }) => {
      if (q.status === 'error') return { sessions: [], total: 0 };
      if (q.to === new Date(NOW).toISOString()) return { sessions: [session('v3'), session('v2')], total: 2 };
      return { sessions: [session('v2')], total: 1 };
    });
    expect((await buildIncidentContext(input())).versionChange).toEqual({ from: 'v2', to: 'v3' });
  });

  it('versionChange is null when the versions did not change or the previous window is empty', async () => {
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [session('v1')], total: 1 });
    expect((await buildIncidentContext(input())).versionChange).toBeNull();

    // Nothing to compare with in an empty previous window: no change is claimed.
    db.listAgentTracingSessions.mockImplementation(async (q: { status?: string; to: string }) =>
      q.to === new Date(NOW).toISOString() && !q.status ? { sessions: [session('v1')], total: 1 } : { sessions: [], total: 0 });
    expect((await buildIncidentContext(input())).versionChange).toBeNull();
  });

  it('summarises error signatures and links the failing sessions by list path, never by id', async () => {
    db.listAgentTracingSessions.mockImplementation(async (q: { status?: string }) =>
      q.status === 'error'
        ? { sessions: [{ _id: 'sess-secret-1', sessionId: 'sess-secret-1', ...session(undefined, ['Timeout 5000']) }, session(undefined, ['Timeout 7000'])], total: 12 }
        : { sessions: [], total: 0 });
    const context = await buildIncidentContext(input());
    expect(context.errorSignatures).toEqual([{ message: 'Timeout <n>', count: 2 }]);
    expect(context.failingSessions?.count).toBe(12);
    expect(context.failingSessions?.listPath).toMatch(/^\/dashboard\/tracing\/sessions\?/);
    expect(context.failingSessions?.listPath).toContain('agent=Pulse+Main');
    expect(context.failingSessions?.listPath).toContain('status=error');
    expect(JSON.stringify(context)).not.toContain('sess-secret-1');
  });

  it('has no failing sessions entry when nothing failed and still builds when the lookup throws', async () => {
    expect((await buildIncidentContext(input())).failingSessions).toBeNull();
    db.listAgentTracingSessions.mockRejectedValue(new Error('db down'));
    expect(await buildIncidentContext(input())).toEqual({ mode: 'threshold', windowMinutes: 15 });
  });

  describe('enterprise enricher', () => {
    it('is called with the target and merged: its fields win, notes and correlations extend', async () => {
      const enricher = vi.fn(async () => ({
        correlations: [{ entityType: 'model', entityKey: 'gpt-4o', metric: 'model_error_rate', change: '+30%' }],
        notes: ['Upstream model regressed'],
      })) as never;
      registerIncidentEnricher(enricher);
      const context = await buildIncidentContext(input());
      expect(enricher).toHaveBeenCalledWith(expect.objectContaining({
        tenantDbName: 'd', tenantId: 't', projectId: 'p1', entityType: 'agent', entityKey: 'Pulse Main', windowMinutes: 15, nowMs: NOW,
      }));
      expect(context.correlations).toHaveLength(1);
      expect(context.notes).toEqual(['Upstream model regressed']);
      expect(context.mode).toBe('threshold');
    });

    it('a rejecting enricher is ignored', async () => {
      registerIncidentEnricher((async () => { throw new Error('boom'); }) as never);
      expect(await buildIncidentContext(input({ entityType: null, entityKey: '' }))).toEqual({ mode: 'threshold', windowMinutes: 15 });
    });

    it('a slow enricher is abandoned after the timeout', async () => {
      vi.useFakeTimers();
      registerIncidentEnricher((() => new Promise(() => { /* never settles */ })) as never);
      const pending = buildIncidentContext(input({ entityType: null, entityKey: '' }));
      await vi.advanceTimersByTimeAsync(ENRICHER_TIMEOUT_MS + 10);
      expect(await pending).toEqual({ mode: 'threshold', windowMinutes: 15 });
      expect(ENRICHER_TIMEOUT_MS).toBe(3000);
    });
  });
});
