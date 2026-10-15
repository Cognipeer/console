import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

/** The mock db with every method as a plain vitest mock: tests feed it partial rows. */
type LooseDb = Record<string, import('vitest').Mock>;
import {
  ENRICHER_TIMEOUT_MS,
  VERSION_CHANGE_LOOKBACK_MS,
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

  it('queries the project and the exact agent name: one bounded scan for versions, one for failures', async () => {
    await buildIncidentContext(input());
    expect(db.listAgentTracingSessions).toHaveBeenCalledTimes(2);
    const calls = db.listAgentTracingSessions.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const windowMs = 15 * 60_000;
    const scan = calls.find((c) => !c.status)!;
    const failed = calls.find((c) => c.status === 'error')!;
    expect(scan.from).toBe(new Date(NOW - VERSION_CHANGE_LOOKBACK_MS).toISOString());
    expect(scan.to).toBe(new Date(NOW).toISOString());
    expect(scan.limit).toBe(2000);
    expect(scan.projection).toEqual({ agentVersion: 1, startedAt: 1 });
    expect(failed.from).toBe(new Date(NOW - windowMs).toISOString());
    for (const c of calls) expect(c.agentNameExact).toBe('Pulse Main');
    expect(failed.includeTotal).toBe(true);
    for (const call of db.listAgentTracingSessions.mock.calls) expect(call[1]).toBe('p1');
  });

  it('scans at least two windows back when the rule window is longer than the lookback', async () => {
    await buildIncidentContext(input({ windowMinutes: 12 * 60 }));
    const scan = db.listAgentTracingSessions.mock.calls.map((c) => c[0] as Record<string, unknown>).find((c) => !c.status)!;
    expect(scan.from).toBe(new Date(NOW - 24 * 60 * 60_000).toISOString());
  });

  describe('version change', () => {
    const MIN = 60_000;
    /** A session that started `minutesAgo` before the alert fired. */
    const at = (version: string | undefined, minutesAgo: number) => ({
      agentVersion: version,
      startedAt: new Date(NOW - minutesAgo * MIN),
    });
    /** The scan returns these (newest first, like the store); the failed-sessions query returns none. */
    const scanReturns = (rows: ReturnType<typeof at>[], total = rows.length) => {
      db.listAgentTracingSessions.mockImplementation(async (q: { status?: string }) =>
        q.status === 'error' ? { sessions: [], total: 0 } : { sessions: rows, total });
    };

    it('detects a version introduced well before the current window, with when it was first seen', async () => {
      scanReturns([at('v3', 1), at('v3', 4), at('v3', 20), at('v2', 25), at('v2', 40)]);
      const { versionChange } = await buildIncidentContext(input({ windowMinutes: 5 }));
      expect(versionChange).toEqual({ from: 'v2', to: 'v3', firstSeenAt: new Date(NOW - 20 * MIN).toISOString() });
    });

    it('is null for a version that has run longer than the horizon and for a brand-new agent', async () => {
      scanReturns([at('v3', 1), at('v3', 120), at('v3', 340)]);
      expect((await buildIncidentContext(input({ windowMinutes: 5 }))).versionChange).toBeNull();
      scanReturns([]);
      expect((await buildIncidentContext(input({ windowMinutes: 5 }))).versionChange).toBeNull();
      scanReturns([at(undefined, 1), at('  ', 30)]);
      expect((await buildIncidentContext(input({ windowMinutes: 5 }))).versionChange).toBeNull();
    });

    it('reports the new version when old and new run side by side in the current window', async () => {
      scanReturns([at('v2', 1), at('v3', 2), at('v2', 3), at('v3', 4), at('v2', 12), at('v2', 30)]);
      expect((await buildIncidentContext(input({ windowMinutes: 5 }))).versionChange)
        .toEqual({ from: 'v2', to: 'v3', firstSeenAt: new Date(NOW - 4 * MIN).toISOString() });
    });

    it('names the version running just before the new one as "from", not the oldest one seen', async () => {
      scanReturns([at('v3', 1), at('v3', 20), at('v2', 40), at('v2', 90), at('v1', 200)]);
      expect((await buildIncidentContext(input({ windowMinutes: 5 }))).versionChange)
        .toEqual({ from: 'v2', to: 'v3', firstSeenAt: new Date(NOW - 20 * MIN).toISOString() });
    });

    it('is null when the same version kept running (a rollback is not a new version)', async () => {
      scanReturns([at('v2', 1), at('v2', 10), at('v3', 40), at('v2', 90)]);
      expect((await buildIncidentContext(input({ windowMinutes: 5 }))).versionChange).toBeNull();
    });

    it('is null for two versions served side by side since before the scan started', async () => {
      // v2 and v3 alternate every 2 min across the whole 6 h horizon: neither is new, the scan just starts mid-run.
      const rows = Array.from({ length: 180 }, (_, i) => at(i % 2 ? 'v2' : 'v3', 1 + i * 2));
      scanReturns(rows);
      expect((await buildIncidentContext(input({ windowMinutes: 5 }))).versionChange).toBeNull();
    });

    it('does not report a version first seen at the edge of a truncated scan', async () => {
      // 2000 rows hit the cap: the oldest scanned session is v2 at ~201 min, and v3 first shows up 3 min later.
      // Sessions older than the cap are missing, so v3 may have been running for hours.
      const rows = [
        ...Array.from({ length: 1999 }, (_, i) => at('v3', 1 + (i * 197) / 1998)),
        at('v2', 201),
      ];
      scanReturns(rows);
      expect((await buildIncidentContext(input({ windowMinutes: 5 }))).versionChange).toBeNull();
    });

    it('still reports a version introduced clear of the edge of a truncated scan', async () => {
      const rows = [
        ...Array.from({ length: 1000 }, (_, i) => at('v3', 1 + i * 0.01)),
        ...Array.from({ length: 1000 }, (_, i) => at('v2', 30 + i * 0.1)),
      ];
      scanReturns(rows);
      expect((await buildIncidentContext(input({ windowMinutes: 5 }))).versionChange?.to).toBe('v3');
    });
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
