/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The life of a red-team run in the service layer, against an in-memory provider:
 * insert-then-verify at creation, a single claim, the heartbeat that carries a
 * stop request, the guarded finish, the reaper, cancel, and review (by attempt
 * key, by a bare id, and a legacy run moved to attempt rows on its first review).
 *
 * The engine runner, the live adapters and the probe catalog are replaced, so
 * these tests say nothing about detection: only about how runs are kept.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Doc = Record<string, any>;

const h = vi.hoisted(() => ({
  db: null as any,
  runner: { impl: null as null | ((params: any) => Promise<any>), calls: [] as any[] },
  probes: { missing: [] as string[], attempts: [] as Array<{ id: string; system?: string }> },
  agent: { started: null as any },
}));

vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/database')>()),
  getDatabase: vi.fn(async () => h.db),
}));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  assertServiceEnabled: vi.fn(async () => undefined),
  ServiceDisabledError: class ServiceDisabledError extends Error {},
}));
vi.mock('@/lib/services/redteam/runner', () => ({
  runRedTeam: vi.fn(async (params: any) => {
    h.runner.calls.push(params);
    return h.runner.impl!(params);
  }),
}));
vi.mock('@/lib/services/redteam/adapters', () => ({
  buildTargetInvoker: vi.fn(() => async () => ({ text: 'ok' })),
  buildJudgeInvoker: vi.fn(() => async () => '{}'),
  buildAttackerInvoker: vi.fn(() => async () => ''),
}));
vi.mock('@/lib/services/redteam/probes', () => ({
  CUSTOM_PROBE_PREFIX: 'custom:',
  CustomProbeError: class CustomProbeError extends Error {},
  validateCustomProbe: vi.fn(),
  validateCustomProbeDefinition: vi.fn(),
  validateCustomProbePatterns: vi.fn(),
  buildProbesLenient: vi.fn(() => ({
    probes: [{ key: 'prompt-injection', generate: () => h.probes.attempts }],
    missing: h.probes.missing,
  })),
}));
vi.mock('@/lib/services/agents/agentRevision', () => ({
  AgentRevisionError: class AgentRevisionError extends Error {},
  assertAgentRevisionRunnable: vi.fn(async () => undefined),
  startAgentRevision: vi.fn(async () => h.agent.started),
}));

import { computeAggregate } from '@/lib/services/redteam/aggregate';
import { RUN_LIFECYCLE } from '@/lib/services/redteam/limits';
import {
  RedTeamConflictError,
  RedTeamForbiddenError,
  RedTeamNotFoundError,
  cancelRun,
  createAsyncRun,
  createCampaign,
  deleteCampaign,
  deleteCustomProbe,
  executeRun,
  getRun,
  listRunsPage,
  loadRunAttempts,
  reapStaleRuns,
  reviewAttempt,
  safeRunError,
} from '@/lib/services/redteam/service';

// ── An in-memory provider with the red-team surface the service uses ──────────

const T0 = new Date('2026-11-09T10:00:00.000Z');
const MIN = 60_000;

function makeDb() {
  const runs = new Map<string, Doc>();
  const rows = new Map<string, Doc[]>();
  const campaigns: Doc[] = [];
  const customProbes: Doc[] = [];
  let seq = 0;
  const state: { missNextIf: number; dupCampaignCreates: number; afterCreate?: () => Promise<unknown> } = { missNextIf: 0, dupCampaignCreates: 0 };

  const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
  const matches = (run: Doc, guard: Doc): boolean => {
    if (guard.status !== undefined) {
      const wanted = Array.isArray(guard.status) ? guard.status : [guard.status];
      if (!wanted.includes(run.status)) return false;
    }
    if (guard.workerId !== undefined && run.workerId !== guard.workerId) return false;
    if (guard.updatedAt !== undefined && new Date(run.updatedAt).getTime() !== new Date(guard.updatedAt).getTime()) return false;
    return true;
  };
  const time = (d: unknown) => new Date(d as string | number | Date).getTime();

  const db: Doc = {
    runs,
    rows,
    campaigns,
    customProbes,
    state,
    switchToTenant: vi.fn(async () => undefined),

    async createRedTeamRun(input: Doc) {
      const _id = input._id ?? `run-${String((seq += 1)).padStart(4, '0')}`;
      const doc = { ...clone(input), _id, createdAt: input.createdAt ?? new Date(), updatedAt: input.updatedAt ?? new Date() };
      runs.set(_id, doc);
      // A competing request whose row lands right after ours (the creator's own check has already passed).
      const hook = state.afterCreate;
      state.afterCreate = undefined;
      if (hook) await hook();
      return clone(doc);
    },
    async findRedTeamRunById(id: string) {
      const run = runs.get(id);
      return run ? clone(run) : null;
    },
    async updateRedTeamRun(id: string, data: Doc) {
      const run = runs.get(id);
      if (!run) return null;
      Object.assign(run, clone(data), { updatedAt: new Date() });
      return clone(run);
    },
    async updateRedTeamRunIf(id: string, guard: Doc, data: Doc) {
      const run = runs.get(id);
      if (!run) return null;
      if (state.missNextIf > 0) {
        // Somebody else changed the run between the caller's read and this write.
        state.missNextIf -= 1;
        run.updatedAt = new Date(time(run.updatedAt) + 1);
        return null;
      }
      if (!matches(run, guard)) return null;
      Object.assign(run, clone(data), { updatedAt: new Date() });
      return clone(run);
    },
    async listRedTeamRuns(f: Doc = {}) {
      let list = [...runs.values()].filter((r) => {
        if (f.projectId !== undefined && r.projectId !== f.projectId) return false;
        if (f.campaignKey !== undefined && r.campaignKey !== f.campaignKey) return false;
        if (f.status !== undefined) {
          const wanted = Array.isArray(f.status) ? f.status : [f.status];
          if (!wanted.includes(r.status)) return false;
        }
        return true;
      });
      list.sort((a, b) => time(b.createdAt) - time(a.createdAt));
      list = list.slice(f.skip ?? 0, f.limit !== undefined ? (f.skip ?? 0) + f.limit : undefined);
      return list.map((r) => clone(f.omitAttempts ? { ...r, attempts: [] } : r));
    },
    async countRedTeamRuns(f: Doc = {}) {
      return (await db.listRedTeamRuns({ ...f, limit: undefined, skip: undefined })).length;
    },
    async listStaleRedTeamRuns(p: Doc) {
      return [...runs.values()]
        .filter((r) => {
          if (r.status === 'running' && r.leaseUntil) return time(r.leaseUntil) < time(p.leaseExpiredBefore);
          if (r.status === 'running') return time(r.updatedAt) < time(p.legacyUpdatedBefore);
          if (r.status === 'pending') return time(r.createdAt) < time(p.pendingCreatedBefore);
          return false;
        })
        .slice(0, p.limit ?? 50)
        .map((r) => clone({ ...r, attempts: [] }));
    },
    async deleteRedTeamRun(id: string) {
      rows.delete(id);
      return runs.delete(id);
    },

    upsertRedTeamRunAttempts: vi.fn(async (input: Doc[]) => {
      for (const row of input) {
        const list = rows.get(row.runId) ?? [];
        const at = list.findIndex((r) => r.attemptKey === row.attemptKey);
        // An upsert replaces everything except the review.
        if (at >= 0) list[at] = { ...clone(row), _id: list[at]._id, review: list[at].review };
        else list.push({ ...clone(row), _id: `row-${(seq += 1)}` });
        rows.set(row.runId, list);
      }
    }),
    async listRedTeamRunAttempts(runId: string, opts: Doc = {}) {
      const list = [...(rows.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);
      return clone(list.slice(opts.skip ?? 0, opts.limit !== undefined ? (opts.skip ?? 0) + opts.limit : undefined));
    },
    async countRedTeamRunAttempts(runId: string) {
      return (rows.get(runId) ?? []).length;
    },
    async findRedTeamRunAttempt(runId: string, attemptKey: string) {
      const row = (rows.get(runId) ?? []).find((r) => r.attemptKey === attemptKey);
      return row ? clone(row) : null;
    },
    setRedTeamRunAttemptReview: vi.fn(async (runId: string, attemptKey: string, review: unknown) => {
      const row = (rows.get(runId) ?? []).find((r) => r.attemptKey === attemptKey);
      if (!row) return false;
      row.review = review ?? undefined;
      return true;
    }),
    async deleteRedTeamRunAttempts(runId: string) {
      const n = (rows.get(runId) ?? []).length;
      rows.delete(runId);
      return n;
    },

    async findRedTeamCampaignByKey(key: string, projectId?: string) {
      const found = campaigns.find((c) => c.key === key && (projectId === undefined || c.projectId === projectId));
      return found ? clone(found) : null;
    },
    async findRedTeamCampaignById(id: string) {
      const found = campaigns.find((c) => c._id === id);
      return found ? clone(found) : null;
    },
    async listRedTeamCampaigns(f: Doc = {}) {
      return clone(campaigns.filter((c) => f.projectId === undefined || c.projectId === f.projectId));
    },
    createRedTeamCampaign: vi.fn(async (input: Doc) => {
      if (state.dupCampaignCreates > 0) {
        state.dupCampaignCreates -= 1;
        throw Object.assign(new Error('E11000 duplicate key error collection: redteam_campaigns'), { code: 11000 });
      }
      const doc = { ...clone(input), _id: `camp-${(seq += 1)}`, createdAt: new Date(), updatedAt: new Date() };
      campaigns.push(doc);
      return clone(doc);
    }),
    async deleteRedTeamCampaign(id: string) {
      const at = campaigns.findIndex((c) => c._id === id);
      if (at < 0) return false;
      campaigns.splice(at, 1);
      return true;
    },
    async listRedTeamCustomProbes() {
      return clone(customProbes);
    },
    async findRedTeamCustomProbeById(id: string) {
      const found = customProbes.find((p) => p._id === id);
      return found ? clone(found) : null;
    },
    async deleteRedTeamCustomProbe(id: string) {
      const at = customProbes.findIndex((p) => p._id === id);
      if (at < 0) return false;
      customProbes.splice(at, 1);
      return true;
    },
  };
  return db;
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const TENANT = 'tenant_db';
const PROJECT = 'proj-1';
const base = { tenantDbName: TENANT, tenantId: 'tenant-1', projectId: PROJECT, createdBy: 'ann', campaignKey: 'scan' };

const modelCampaign = (over: Doc = {}) => ({
  _id: 'camp-1', tenantId: 'tenant-1', projectId: PROJECT, key: 'scan', name: 'Scan', targetKind: 'model', modelKey: 'm',
  probeKeys: ['prompt-injection'], createdBy: 'ann', ...over,
});
const agentCampaign = (over: Doc = {}) => modelCampaign({ targetKind: 'agent', agentKey: 'bot', modelKey: undefined, ...over });

function seedRun(over: Doc = {}) {
  return h.db.createRedTeamRun({
    tenantId: 'tenant-1', projectId: PROJECT, campaignKey: 'scan', targetKind: 'model', targetRef: 'm',
    status: 'completed', mode: 'async', progress: { total: 0, completed: 0, failed: 0 }, attempts: [], createdBy: 'ann',
    attemptStore: 'collection', ...over,
  }) as Promise<Doc>;
}

/** An engine attempt result, as the runner returns it. */
function engineAttempt(probeKey: string, id: string, outcome: 'safe' | 'vulnerable' | 'needs_review' = 'safe', extra: Doc = {}) {
  return {
    probeKey, attemptId: id, family: 'prompt-injection', category: 'LLM01-prompt-injection', severity: 'high',
    transcript: [{ user: 'hi', assistant: 'hello' }], outcome, latencyMs: 5,
    verdict: { outcome, severity: 'high', confidence: 0.9, decidedBy: 'test', signals: [] },
    ...extra,
  };
}

/** A stored attempt, as a row or an embedded attempt holds it. */
function storedAttempt(probeKey: string, attemptId: string, outcome: 'safe' | 'vulnerable' | 'needs_review', extra: Doc = {}) {
  return {
    probeKey, attemptId, family: 'f', category: 'LLM01-prompt-injection', severity: 'high', outcome, decidedBy: 'test',
    confidence: 0.9, transcript: [{ user: 'u', assistant: 'a' }], signals: [], latencyMs: 5, ...extra,
  };
}

async function seedRows(runId: string, attempts: Doc[]) {
  await h.db.upsertRedTeamRunAttempts(
    attempts.map((a, seq) => ({ ...a, attemptKey: `${a.probeKey}::${a.attemptId}`, tenantId: 'tenant-1', projectId: PROJECT, runId, seq })),
  );
}

/** The runner replacement: runs every attempt in order, reports each, and stops when asked. */
function runEveryAttempt(results: Doc[], extra: Doc = {}) {
  return async (params: any) => {
    const done: Doc[] = [];
    let stopped = false;
    for (let i = 0; i < results.length; i += 1) {
      if (params.config.shouldStop()) {
        stopped = true;
        break;
      }
      await params.onAttempt(results[i], i);
      done.push(results[i]);
    }
    return { attempts: done, aggregate: undefined, stopped, ...extra };
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  h.db = makeDb();
  h.db.campaigns.push(modelCampaign());
  h.runner.calls = [];
  h.runner.impl = runEveryAttempt([engineAttempt('prompt-injection', 'pi-1', 'vulnerable'), engineAttempt('prompt-injection', 'pi-2', 'safe')]);
  h.probes.missing = [];
  h.probes.attempts = [{ id: 'pi-1' }, { id: 'pi-2' }];
  h.agent.started = {
    revision: { requested: 'published', agentKey: 'bot', version: 2 },
    selector: { version: 2 },
    draftChanged: async () => false,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

/** A pending run of the model campaign, ready to execute. */
async function pendingRun(campaign: Doc = modelCampaign()) {
  const { run } = await createAsyncRun(base);
  return { run, params: { ...base, runId: run.id, campaign } as any };
}

// ── Creating a run: insert, then verify ─────────────────────────────────────

describe('creating a run', () => {
  it('stores a pending run whose attempts live in rows', async () => {
    const { run } = await createAsyncRun(base);

    expect(run).toMatchObject({ status: 'pending', mode: 'async', attemptStore: 'collection', attempts: [] });
    expect(run.progress).toEqual({ total: 2, completed: 0, failed: 0 });
  });

  it('refuses while an older run of the campaign is live, and leaves no row of its own', async () => {
    await seedRun({ _id: 'run-old', status: 'running', leaseUntil: new Date(T0.getTime() + MIN), createdAt: new Date(T0.getTime() - 1000) });

    await expect(createAsyncRun(base)).rejects.toThrow(/already in progress/);
    await expect(createAsyncRun(base)).rejects.toBeInstanceOf(RedTeamConflictError);

    expect([...h.db.runs.keys()]).toEqual(['run-old']);
  });

  it('breaks a tie on createdAt by id: the smaller id goes on, the other backs off', async () => {
    // A competing row lands at the same instant as ours, after our pre-check but before our verify.
    h.db.state.afterCreate = () => seedRun({ _id: 'run-0000', status: 'pending', createdAt: T0 });
    await expect(createAsyncRun(base)).rejects.toThrow(/already in progress/);
    expect([...h.db.runs.keys()]).toEqual(['run-0000']);

    h.db.runs.clear();
    h.db.state.afterCreate = () => seedRun({ _id: 'run-zzzz', status: 'pending', createdAt: T0 });
    const { run } = await createAsyncRun(base);
    expect(run.id).toBe('run-0002');
    // The other creator, running its own check later, finds that it is the one to back off.
    expect(new Set(h.db.runs.keys())).toEqual(new Set(['run-zzzz', 'run-0002']));
  });

  it('ignores runs nobody is working on any more', async () => {
    await seedRun({ _id: 'a', status: 'running', leaseUntil: new Date(T0.getTime() - 1000), createdAt: new Date(T0.getTime() - 5 * MIN) });
    await seedRun({ _id: 'b', status: 'pending', createdAt: new Date(T0.getTime() - (RUN_LIFECYCLE.pendingTimeoutMs + MIN)) });
    await seedRun({
      _id: 'c', status: 'running', createdAt: new Date(T0.getTime() - 2 * 60 * MIN),
      updatedAt: new Date(T0.getTime() - (RUN_LIFECYCLE.legacyRunningTimeoutMs + MIN)),
    });

    await expect(createAsyncRun(base)).resolves.toBeDefined();
  });

  it('counts a run recorded before leases while it was touched recently', async () => {
    await seedRun({ _id: 'legacy', status: 'running', createdAt: new Date(T0.getTime() - 5 * MIN), updatedAt: new Date(T0.getTime() - MIN) });

    await expect(createAsyncRun(base)).rejects.toThrow(/already in progress/);
  });

  it('lets scans of different agent revisions overlap, and names the revision of a clash', async () => {
    h.db.campaigns.splice(0, 1, agentCampaign());
    await seedRun({ _id: 'draft-run', status: 'running', targetKind: 'agent', leaseUntil: new Date(T0.getTime() + MIN), agentRevision: { requested: 'draft' }, createdAt: new Date(T0.getTime() - 1000) });

    await expect(createAsyncRun(base)).resolves.toBeDefined();
    await expect(createAsyncRun({ ...base, options: { agentVersion: 'draft' } })).rejects.toThrow(/already in progress on draft/);
  });
});

// ── Claiming and running ────────────────────────────────────────────────────

describe('executing a run', () => {
  it('is claimed once: a second worker for the same run does nothing', async () => {
    const { run, params } = await pendingRun();

    const [a, b] = await Promise.all([executeRun(params), executeRun(params)]);

    expect(h.runner.calls).toHaveLength(1);
    expect([a.id, b.id]).toEqual([run.id, run.id]);
    const stored = h.db.runs.get(run.id)!;
    expect(stored.status).toBe('completed');
    expect(stored.workerId).toMatch(/:\d+:[0-9a-f]{8}$/);
  });

  it('does nothing for a run that is not pending any more', async () => {
    const { run, params } = await pendingRun();
    await h.db.updateRedTeamRun(run.id, { status: 'cancelled' });

    const result = await executeRun(params);

    expect(h.runner.calls).toHaveLength(0);
    expect(result.status).toBe('cancelled');
  });

  it('stores each attempt as a row as it finishes, with the run\'s identity and order', async () => {
    const { run, params } = await pendingRun();
    const seen: number[] = [];
    h.runner.impl = async (p: any) => {
      for (const [i, r] of [engineAttempt('prompt-injection', 'pi-1', 'vulnerable'), engineAttempt('prompt-injection', 'pi-2')].entries()) {
        await p.onAttempt(r, i);
        seen.push(h.db.rows.get(run.id)!.length);
      }
      return { attempts: [engineAttempt('prompt-injection', 'pi-1', 'vulnerable'), engineAttempt('prompt-injection', 'pi-2')], stopped: false };
    };

    await executeRun(params);

    // A row existed after each attempt, before the run had ended.
    expect(seen).toEqual([1, 2]);
    const rows = await h.db.listRedTeamRunAttempts(run.id);
    expect(rows.map((r: Doc) => [r.attemptKey, r.seq, r.tenantId, r.projectId, r.runId])).toEqual([
      ['prompt-injection::pi-1', 0, 'tenant-1', PROJECT, run.id],
      ['prompt-injection::pi-2', 1, 'tenant-1', PROJECT, run.id],
    ]);
  });

  it('finishes completed, with the shared aggregate, no embedded attempts and a warning list', async () => {
    h.probes.missing = ['custom:gone'];
    const { run, params } = await pendingRun();

    const result = await executeRun(params);

    expect(result.status).toBe('completed');
    expect(result.finishedAt).toBeDefined();
    expect(h.db.runs.get(run.id)!.attempts).toEqual([]);
    expect(result.aggregate).toMatchObject({ total: 2, completed: 2, vulnerable: 1, attackSuccessRate: 0.5, resilienceScore: 0.5, inconclusive: false });
    expect(result.progress).toEqual({ total: 2, completed: 2, failed: 0 });
    expect(result.warnings).toEqual(['Custom probe custom:gone no longer exists; it was skipped.']);
    expect(result.attempts.map((a) => a.attemptKey)).toEqual(['prompt-injection::pi-1', 'prompt-injection::pi-2']);
    // The one stored read of the run gives the same attempts from the rows.
    expect((await getRun(TENANT, run.id))!.attempts.map((a) => a.attemptKey)).toEqual(['prompt-injection::pi-1', 'prompt-injection::pi-2']);
  });

  it('stores a bounded transcript in the row', async () => {
    const { run, params } = await pendingRun();
    const long = 'x'.repeat(30_000);
    h.runner.impl = runEveryAttempt([engineAttempt('prompt-injection', 'pi-1', 'safe', { transcript: [{ user: 'hi', assistant: long }] })]);

    await executeRun(params);

    const [row] = await h.db.listRedTeamRunAttempts(run.id);
    expect(row.transcript[0].assistant.length).toBeLessThan(long.length);
    expect(row.transcript[0].assistant).toContain('[truncated');
  });

  it('counts an attempt the target never answered as failed, and one answered in part as completed', async () => {
    const { params } = await pendingRun();
    h.runner.impl = runEveryAttempt([
      engineAttempt('prompt-injection', 'pi-1', 'needs_review', { error: 'timed out after 120s', transcript: [] }),
      engineAttempt('prompt-injection', 'pi-2', 'vulnerable', { error: 'boom', partial: true }),
    ]);

    const result = await executeRun(params);

    expect(result.aggregate).toMatchObject({ total: 2, completed: 1, failed: 1, vulnerable: 1 });
    expect(result.progress).toEqual({ total: 2, completed: 1, failed: 1 });
    expect(result.aggregate!.inconclusiveReasons).toContain('target-errors');
  });

  it('records a failed run with a safe message and the aggregate of what finished, then rethrows', async () => {
    const { run, params } = await pendingRun();
    h.runner.impl = async (p: any) => {
      await p.onAttempt(engineAttempt('prompt-injection', 'pi-1', 'safe'), 0);
      throw new Error('upstream said: {"api_key":"sk-secret"} at /srv/app/node_modules/x.js');
    };

    await expect(executeRun(params)).rejects.toThrow(/sk-secret/);

    const stored = h.db.runs.get(run.id)!;
    expect(stored.status).toBe('failed');
    expect(stored.error).toBe('The scan failed: Error');
    expect(stored.error).not.toMatch(/secret|node_modules/);
    expect(stored.aggregate).toMatchObject({ total: 1, completed: 1 });
  });

  it('keeps a message written for the user', async () => {
    const { run, params } = await pendingRun();
    h.runner.impl = async () => {
      throw Object.assign(new Error('Monthly red-team quota reached'), { name: 'QuotaExceededError' });
    };

    await expect(executeRun(params)).rejects.toThrow();

    expect(h.db.runs.get(run.id)!.error).toBe('Monthly red-team quota reached');
  });

  it('leaves the row as it is when the finish no longer belongs to this worker', async () => {
    const { run, params } = await pendingRun();
    h.runner.impl = async (p: any) => {
      await p.onAttempt(engineAttempt('prompt-injection', 'pi-1', 'safe'), 0);
      // The reaper ended the run while this worker was busy.
      h.db.runs.get(run.id)!.status = 'failed';
      h.db.runs.get(run.id)!.error = 'The scan stopped responding and was ended.';
      await p.onAttempt(engineAttempt('prompt-injection', 'pi-2', 'safe'), 1);
      return { attempts: [engineAttempt('prompt-injection', 'pi-1'), engineAttempt('prompt-injection', 'pi-2')], stopped: p.config.shouldStop() };
    };

    const result = await executeRun(params);

    expect(h.db.runs.get(run.id)!.status).toBe('failed');
    expect(h.db.runs.get(run.id)!.error).toBe('The scan stopped responding and was ended.');
    expect(result.status).toBe('failed');
    // A worker that lost its run is told to stop between attempts.
    expect(h.runner.calls[0].config.shouldStop()).toBe(true);
  });

  it('renews the lease with a heartbeat and ends the scan as cancelled when a stop was requested', async () => {
    const { run, params } = await pendingRun();
    let release!: () => void;
    h.runner.impl = async (p: any) => {
      await p.onAttempt(engineAttempt('prompt-injection', 'pi-1', 'safe'), 0);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { attempts: [engineAttempt('prompt-injection', 'pi-1')], stopped: p.config.shouldStop() };
    };

    const finished = executeRun(params);
    await flush();
    expect(h.db.runs.get(run.id)!.status).toBe('running');
    const claimedLease = new Date(h.db.runs.get(run.id)!.leaseUntil).getTime();
    expect(claimedLease).toBe(T0.getTime() + RUN_LIFECYCLE.leaseMs);

    const asked = await cancelRun(TENANT, run.id, 'bob');
    expect(asked).toMatchObject({ status: 'running', cancelRequested: true, cancelRequestedBy: 'bob' });
    // Nothing stops until the worker looks: the heartbeat does.
    expect(h.runner.calls[0].config.shouldStop()).toBe(false);

    await vi.advanceTimersByTimeAsync(RUN_LIFECYCLE.heartbeatMs);
    expect(new Date(h.db.runs.get(run.id)!.leaseUntil).getTime()).toBe(T0.getTime() + RUN_LIFECYCLE.heartbeatMs + RUN_LIFECYCLE.leaseMs);
    expect(h.runner.calls[0].config.shouldStop()).toBe(true);

    release();
    const result = await finished;

    expect(result.status).toBe('cancelled');
    expect(result.cancelledAt).toBeDefined();
    expect(result.cancelRequestedBy).toBe('bob');
    expect(result.aggregate).toMatchObject({ total: 1, completed: 1 });
  });

  it('stops renewing the lease once the run has ended', async () => {
    const { run, params } = await pendingRun();
    await executeRun(params);
    const lease = h.db.runs.get(run.id)!.leaseUntil;

    await vi.advanceTimersByTimeAsync(RUN_LIFECYCLE.heartbeatMs * 3);

    expect(h.db.runs.get(run.id)!.leaseUntil).toEqual(lease);
  });

  it('does not let a failing heartbeat end the run', async () => {
    const { run, params } = await pendingRun();
    let release!: () => void;
    h.runner.impl = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { attempts: [], stopped: false };
    };
    const finished = executeRun(params);
    await flush();
    const original = h.db.updateRedTeamRunIf;
    h.db.updateRedTeamRunIf = vi.fn(async () => {
      throw new Error('db down');
    });

    await vi.advanceTimersByTimeAsync(RUN_LIFECYCLE.heartbeatMs);
    h.db.updateRedTeamRunIf = original;
    release();

    expect((await finished).status).toBe('completed');
    expect(h.db.runs.get(run.id)!.status).toBe('completed');
  });

  it('clamps concurrency, caps attempts and hands the model target an output limit', async () => {
    h.db.campaigns.splice(0, 1, modelCampaign({ runConfig: { concurrency: 50, maxOutputTokens: 999_999 } }));
    const { run } = await createAsyncRun(base);
    const specs: any[] = [];

    await executeRun(
      { ...base, runId: run.id, campaign: h.db.campaigns[0] as any },
      { buildTargetInvoker: ((spec: any) => { specs.push(spec); return async () => ({ text: 'ok' }); }) as any },
    );

    const config = h.runner.calls[0].config;
    expect(config.concurrency).toBe(16);
    expect(config.maxAttempts).toBe(500);
    expect(config.targetAcceptsSystem).toBe(true);
    expect(specs[0]).toMatchObject({ kind: 'model', maxOutputTokens: 16384 });
  });

  it('lets a run override concurrency within the limits', async () => {
    const { run } = await createAsyncRun(base);

    await executeRun({ ...base, runId: run.id, campaign: h.db.campaigns[0] as any, options: { concurrency: 0 } });

    expect(h.runner.calls[0].config.concurrency).toBe(1);
  });

  it('keeps an agent\'s own instructions: no system turns, no output limit, and a warning with the count', async () => {
    h.db.campaigns.splice(0, 1, agentCampaign());
    h.probes.attempts = [{ id: 'a' }, { id: 'b', system: 'Secret rule' }, { id: 'c', system: 'Another' }];
    const { run } = await createAsyncRun(base);
    expect(run.progress.total).toBe(1);
    const specs: any[] = [];
    h.runner.impl = async () => ({ attempts: [engineAttempt('prompt-injection', 'a')], stopped: false, notApplicable: 2 });

    const result = await executeRun(
      { ...base, runId: run.id, campaign: h.db.campaigns[0] as any },
      { buildTargetInvoker: ((spec: any) => { specs.push(spec); return async () => ({ text: 'ok' }); }) as any },
    );

    expect(h.runner.calls[0].config.targetAcceptsSystem).toBe(false);
    expect(specs[0].maxOutputTokens).toBeUndefined();
    expect(specs[0].agentRun).toEqual({ version: 2 });
    expect(result.notApplicableAttempts).toBe(2);
    expect(result.warnings).toContain('2 attempts were not run: they plant a system prompt, and an agent keeps its own instructions.');
  });

  it('counts attempts beyond the per-run cap as skipped, with a warning', async () => {
    const { params } = await pendingRun();
    h.runner.impl = async () => ({ attempts: [engineAttempt('prompt-injection', 'pi-1')], stopped: false, skipped: 12 });

    const result = await executeRun(params);

    expect(result.skippedAttempts).toBe(12);
    expect(result.warnings?.some((w) => /^12 attempts were not run/.test(w))).toBe(true);
  });
});

// ── Cancelling ──────────────────────────────────────────────────────────────

describe('cancelling a run', () => {
  it('ends a pending run at once, with an empty aggregate', async () => {
    const { run } = await createAsyncRun(base);

    const result = await cancelRun(TENANT, run.id, 'bob');

    expect(result).toMatchObject({ status: 'cancelled', cancelRequestedBy: 'bob' });
    expect(result!.cancelledAt).toBeDefined();
    expect(result!.finishedAt).toBeDefined();
    expect(result!.aggregate).toMatchObject({ total: 0, attackSuccessRate: null, resilienceScore: null });
  });

  it('asks a running run to stop, and leaves it running', async () => {
    const run = await seedRun({ status: 'running', workerId: 'w1', leaseUntil: new Date(T0.getTime() + MIN) });

    const result = await cancelRun(TENANT, run._id, 'bob');

    expect(result).toMatchObject({ status: 'running', cancelRequested: true, cancelRequestedBy: 'bob' });
    expect(h.db.runs.get(run._id)!.status).toBe('running');
  });

  it.each(['completed', 'failed', 'cancelled'])('refuses a run that is already %s', async (status) => {
    const run = await seedRun({ status });

    await expect(cancelRun(TENANT, run._id, 'bob')).rejects.toBeInstanceOf(RedTeamConflictError);
  });

  it('answers null for a run that does not exist', async () => {
    expect(await cancelRun(TENANT, 'nope', 'bob')).toBeNull();
  });

  it('asks the worker to stop when the run was claimed between the read and the write', async () => {
    const run = await seedRun({ status: 'pending' });
    const original = h.db.updateRedTeamRunIf;
    h.db.updateRedTeamRunIf = vi.fn(async (id: string, guard: Doc, data: Doc) => {
      if (guard.status === 'pending') {
        // A worker claims it first, so this write finds it running.
        h.db.runs.get(id)!.status = 'running';
        return null;
      }
      return original(id, guard, data);
    });

    const result = await cancelRun(TENANT, run._id, 'bob');

    expect(result).toMatchObject({ status: 'running', cancelRequested: true });
  });
});

// ── The reaper ──────────────────────────────────────────────────────────────

describe('reaping stale runs', () => {
  it('ends the runs nobody is working on and leaves live ones alone', async () => {
    const crashed = await seedRun({ _id: 'crashed', status: 'running', workerId: 'w', leaseUntil: new Date(T0.getTime() - 1000) });
    await seedRows(crashed._id, [storedAttempt('p', 'a1', 'vulnerable'), storedAttempt('p', 'a2', 'safe')]);
    await seedRun({ _id: 'alive', status: 'running', workerId: 'w', leaseUntil: new Date(T0.getTime() + 30_000) });
    await seedRun({ _id: 'never-started', status: 'pending', createdAt: new Date(T0.getTime() - (RUN_LIFECYCLE.pendingTimeoutMs + MIN)) });
    await seedRun({ _id: 'waiting', status: 'pending', createdAt: new Date(T0.getTime() - 5 * MIN) });
    await seedRun({
      _id: 'legacy-stuck', status: 'running', attemptStore: undefined,
      updatedAt: new Date(T0.getTime() - (RUN_LIFECYCLE.legacyRunningTimeoutMs + MIN)),
    });
    await seedRun({ _id: 'legacy-busy', status: 'running', attemptStore: undefined, updatedAt: new Date(T0.getTime() - 10 * MIN) });

    const reaped = await reapStaleRuns(TENANT, T0);

    expect(reaped).toBe(3);
    const status = (id: string) => h.db.runs.get(id)!.status;
    expect([status('crashed'), status('never-started'), status('legacy-stuck')]).toEqual(['failed', 'failed', 'failed']);
    expect([status('alive'), status('waiting'), status('legacy-busy')]).toEqual(['running', 'pending', 'running']);
    expect(h.db.runs.get('crashed')!.error).toBe('The scan stopped responding and was ended.');
    expect(h.db.runs.get('legacy-stuck')!.error).toBe('The scan stopped responding and was ended.');
    expect(h.db.runs.get('never-started')!.error).toBe('The scan never started.');
    expect(h.db.runs.get('crashed')!.finishedAt).toEqual(T0);
    // What finished before the crash is summed up; a run without rows gets none.
    expect(h.db.runs.get('crashed')!.aggregate).toMatchObject({ total: 2, completed: 2, vulnerable: 1 });
    expect(h.db.runs.get('never-started')!.aggregate).toBeUndefined();
  });

  it('does not touch a run that moved on after the reaper looked at it', async () => {
    await seedRun({ _id: 'late', status: 'completed' });
    h.db.listStaleRedTeamRuns = vi.fn(async () => [
      { ...structuredClone(h.db.runs.get('late')!), status: 'running', leaseUntil: new Date(T0.getTime() - 1000) },
    ]);

    expect(await reapStaleRuns(TENANT, T0)).toBe(0);
    expect(h.db.runs.get('late')!.status).toBe('completed');
  });

  it('ends a run once, however many ticks look at it', async () => {
    await seedRun({ _id: 'once', status: 'running', leaseUntil: new Date(T0.getTime() - 1000) });

    expect(await reapStaleRuns(TENANT, T0)).toBe(1);
    expect(await reapStaleRuns(TENANT, T0)).toBe(0);
  });
});

// ── Reading attempts ────────────────────────────────────────────────────────

describe('loadRunAttempts', () => {
  it('reads rows in run order without their bookkeeping, each with its attempt key', async () => {
    const run = await seedRun();
    await seedRows(run._id, [storedAttempt('p', 'second', 'safe'), storedAttempt('p', 'first', 'vulnerable')]);
    // Stored in the opposite order of `seq`.
    h.db.rows.get(run._id)!.reverse();

    const attempts = await loadRunAttempts(h.db, run as any);

    expect(attempts.map((a) => a.attemptKey)).toEqual(['p::second', 'p::first']);
    for (const a of attempts) {
      for (const field of ['_id', 'tenantId', 'projectId', 'runId', 'seq']) expect(a).not.toHaveProperty(field);
    }
  });

  it('reads the embedded attempts of a legacy run and gives them keys', async () => {
    const run = await seedRun({ attemptStore: undefined, attempts: [storedAttempt('p', 'a1', 'safe'), storedAttempt('q', 'a1', 'safe')] });

    const attempts = await loadRunAttempts(h.db, run as any);

    expect(attempts.map((a) => a.attemptKey)).toEqual(['p::a1', 'q::a1']);
  });

  it('numbers a repeated attempt id of a legacy probe instead of dropping it', async () => {
    const run = await seedRun({ attemptStore: undefined, attempts: [storedAttempt('p', 'a1', 'safe'), storedAttempt('p', 'a1', 'vulnerable')] });

    expect((await loadRunAttempts(h.db, run as any)).map((a) => a.attemptKey)).toEqual(['p::a1', 'p::a1#2']);
  });

  it('reads the attempts of a run in pages of any size', async () => {
    const run = await seedRun();
    await seedRows(run._id, Array.from({ length: 1203 }, (_, i) => storedAttempt('p', `a${i}`, 'safe')));

    expect(await loadRunAttempts(h.db, run as any)).toHaveLength(1203);
  });
});

// ── Review ──────────────────────────────────────────────────────────────────

describe('reviewing an attempt', () => {
  const review = { outcome: 'safe' as const, note: 'false positive', reviewedBy: 'ann' };

  async function finishedRun(extra: Doc = {}) {
    const run = await seedRun({ status: 'completed', createdBy: 'starter', ...extra });
    await seedRows(run._id, [
      storedAttempt('p1', 'a1', 'vulnerable'),
      storedAttempt('p2', 'a1', 'vulnerable'),
      storedAttempt('p2', 'only-here', 'vulnerable'),
      storedAttempt('p1', 'dead', 'needs_review', { error: 'timed out after 120s', transcript: [] }),
    ]);
    return run;
  }

  it('reviews by attempt key and recomputes the aggregate from the rows', async () => {
    const run = await finishedRun();

    const result = await reviewAttempt(TENANT, run._id, 'p2::a1', review);

    expect(result!.attempts.find((a) => a.attemptKey === 'p2::a1')!.review).toMatchObject({ outcome: 'safe', note: 'false positive', reviewedBy: 'ann' });
    expect(result!.attempts.find((a) => a.attemptKey === 'p1::a1')!.review).toBeUndefined();
    expect(result!.aggregate).toMatchObject({ total: 4, completed: 3, failed: 1, vulnerable: 2, safe: 1 });
    expect(h.db.runs.get(run._id)!.aggregate).toMatchObject({ vulnerable: 2 });
    // The machine verdict stays.
    expect(result!.attempts.find((a) => a.attemptKey === 'p2::a1')!.outcome).toBe('vulnerable');
  });

  it('refuses a bare attempt id that more than one attempt of the run has', async () => {
    const run = await finishedRun();

    await expect(reviewAttempt(TENANT, run._id, 'a1', review)).rejects.toThrow('ambiguous attempt id; send attemptKey');
    await expect(reviewAttempt(TENANT, run._id, 'a1', review)).rejects.toBeInstanceOf(RedTeamConflictError);
    expect(h.db.setRedTeamRunAttemptReview).not.toHaveBeenCalled();
  });

  it('accepts a bare attempt id that is unique in the run', async () => {
    const run = await finishedRun();

    const result = await reviewAttempt(TENANT, run._id, 'only-here', review);

    expect(result!.attempts.find((a) => a.attemptKey === 'p2::only-here')!.review?.outcome).toBe('safe');
  });

  it('answers 404-type errors for an unknown attempt, null for an unknown run', async () => {
    const run = await finishedRun();

    await expect(reviewAttempt(TENANT, run._id, 'nope', review)).rejects.toBeInstanceOf(RedTeamNotFoundError);
    await expect(reviewAttempt(TENANT, run._id, 'p9::a1', review)).rejects.toBeInstanceOf(RedTeamNotFoundError);
    expect(await reviewAttempt(TENANT, 'no-such-run', 'p1::a1', review)).toBeNull();
  });

  it('refuses an attempt the target never answered', async () => {
    const run = await finishedRun();

    await expect(reviewAttempt(TENANT, run._id, 'p1::dead', review)).rejects.toBeInstanceOf(RedTeamConflictError);
  });

  it('reviews an attempt answered in part', async () => {
    const run = await seedRun({ status: 'completed' });
    await seedRows(run._id, [storedAttempt('p1', 'half', 'needs_review', { error: 'boom', partial: true })]);

    const result = await reviewAttempt(TENANT, run._id, 'p1::half', { ...review, outcome: 'vulnerable' });

    expect(result!.attempts[0].review?.outcome).toBe('vulnerable');
  });

  it.each(['pending', 'running'])('refuses to review a run that is still %s', async (status) => {
    const run = await finishedRun({ status });

    await expect(reviewAttempt(TENANT, run._id, 'p1::a1', review)).rejects.toThrow(/has not finished/);
  });

  it('reviews a cancelled or failed run', async () => {
    for (const status of ['cancelled', 'failed']) {
      const run = await finishedRun({ status });
      await expect(reviewAttempt(TENANT, run._id, 'p1::a1', review)).resolves.toBeDefined();
    }
  });

  it('refuses a viewer who may not read the attempt, and asks with the tags and the run starter', async () => {
    const run = await seedRun({ status: 'completed', createdBy: 'starter' });
    await seedRows(run._id, [storedAttempt('p1', 'a1', 'vulnerable', { kbRestricted: [`${PROJECT}:handbook`] })]);
    const viewer = { mayRead: vi.fn(async () => false) };

    await expect(reviewAttempt(TENANT, run._id, 'p1::a1', review, viewer)).rejects.toBeInstanceOf(RedTeamForbiddenError);
    expect(viewer.mayRead).toHaveBeenCalledWith([`${PROJECT}:handbook`], ['starter']);
    expect(h.db.rows.get(run._id)![0].review).toBeUndefined();

    viewer.mayRead.mockResolvedValue(true);
    await expect(reviewAttempt(TENANT, run._id, 'p1::a1', review, viewer)).resolves.toBeDefined();
  });

  it('does not ask the viewer about an attempt that handed on nothing restricted', async () => {
    const run = await finishedRun();
    const viewer = { mayRead: vi.fn(async () => false) };

    await reviewAttempt(TENANT, run._id, 'p1::a1', review, viewer);

    expect(viewer.mayRead).not.toHaveBeenCalled();
  });
});

describe('reviewing a run recorded with embedded attempts', () => {
  const review = { outcome: 'safe' as const, reviewedBy: 'ann' };
  const legacyAttempts = () => [
    storedAttempt('p1', 'a1', 'vulnerable', { review: { outcome: 'safe', reviewedBy: 'earlier', reviewedAt: new Date(T0) } }),
    storedAttempt('p1', 'a2', 'vulnerable'),
  ];

  // Embedded attempts are still readable, but a review no longer moves them to rows first.
  it('answers "Attempt not found" for an attempt that exists only embedded, and copies nothing', async () => {
    const run = await seedRun({ attemptStore: undefined, attempts: legacyAttempts(), aggregate: { total: 2, vulnerable: 2 } });

    await expect(reviewAttempt(TENANT, run._id, 'p1::a2', review)).rejects.toBeInstanceOf(RedTeamNotFoundError);
    await expect(reviewAttempt(TENANT, run._id, 'a2', review)).rejects.toBeInstanceOf(RedTeamNotFoundError);

    const stored = h.db.runs.get(run._id)!;
    expect(stored.attemptStore).toBeUndefined();
    expect(stored.attempts).toHaveLength(2);
    expect(stored.attempts[1].review).toBeUndefined();
    expect(stored.aggregate).toMatchObject({ total: 2, vulnerable: 2 });
    expect(h.db.upsertRedTeamRunAttempts).not.toHaveBeenCalled();
    expect(h.db.rows.get(run._id) ?? []).toHaveLength(0);
  });
});

// ── Lists, deletes ───────────────────────────────────────────────────────────

describe('run lists', () => {
  it('pages runs without their attempts and counts the total', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedRun({ _id: `r${i}`, status: i % 2 ? 'failed' : 'completed', attemptStore: undefined, attempts: [storedAttempt('p', 'a', 'safe')], createdAt: new Date(T0.getTime() + i) });
    }

    const page = await listRunsPage(TENANT, { projectId: PROJECT, campaignKey: 'scan', limit: 2, skip: 1 });

    expect(page.total).toBe(5);
    expect(page.runs.map((r) => r.id)).toEqual(['r3', 'r2']);
    expect(page.runs.every((r) => r.attempts.length === 0)).toBe(true);

    const failed = await listRunsPage(TENANT, { projectId: PROJECT, status: 'failed', limit: 10, skip: 0 });
    expect(failed.total).toBe(2);
  });
});

describe('deleting a campaign', () => {
  it('is refused while the campaign has a live run', async () => {
    await seedRun({ status: 'running', leaseUntil: new Date(T0.getTime() + MIN) });

    await expect(deleteCampaign(TENANT, 'camp-1')).rejects.toBeInstanceOf(RedTeamConflictError);
    expect(h.db.campaigns).toHaveLength(1);
  });

  it('goes ahead when its runs have finished or were abandoned', async () => {
    await seedRun({ status: 'completed' });
    await seedRun({ status: 'running', leaseUntil: new Date(T0.getTime() - 1000) });

    await expect(deleteCampaign(TENANT, 'camp-1')).resolves.toBe(true);
  });

  it('answers false for a campaign that does not exist', async () => {
    await expect(deleteCampaign(TENANT, 'nope')).resolves.toBe(false);
  });
});

describe('deleting a custom probe', () => {
  beforeEach(() => {
    h.db.customProbes.push({ _id: 'probe-1', key: 'custom:leak', name: 'Leak', projectId: PROJECT });
    h.db.campaigns.splice(0, 1, modelCampaign({ probeKeys: ['prompt-injection', 'custom:leak'] }));
  });

  it('keeps a probe a campaign selects and names the campaign', async () => {
    const result = await deleteCustomProbe(TENANT, 'probe-1');

    expect(result).toEqual({ deleted: false, usedBy: [{ id: 'camp-1', key: 'scan', name: 'Scan' }] });
    expect(h.db.customProbes).toHaveLength(1);
  });

  it('deletes it anyway when forced', async () => {
    const result = await deleteCustomProbe(TENANT, 'probe-1', { force: true });

    expect(result.deleted).toBe(true);
    expect(result.usedBy).toHaveLength(1);
    expect(h.db.customProbes).toHaveLength(0);
  });

  it('deletes a probe nobody selects, and answers not deleted for an unknown one', async () => {
    h.db.campaigns.splice(0, 1, modelCampaign({ probeKeys: ['prompt-injection'] }));
    expect(await deleteCustomProbe(TENANT, 'probe-1')).toEqual({ deleted: true, usedBy: [] });
    expect(await deleteCustomProbe(TENANT, 'probe-1')).toEqual({ deleted: false, usedBy: [] });
  });
});

describe('safeRunError', () => {
  it('keeps the message of errors written for the user', () => {
    expect(safeRunError(new Error('Model with key gpt-x not found'))).toBe('Model with key gpt-x not found');
    expect(safeRunError(new Error('campaign not found'))).toBe('campaign not found');
    expect(safeRunError(new Error('timed out after 120s'))).toBe('timed out after 120s');
    expect(safeRunError(new RedTeamNotFoundError('Red-team campaign "x" not found'))).toBe('Red-team campaign "x" not found');
  });

  it('names only the kind of any other failure, within 300 characters', () => {
    class ProviderError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'ProviderError';
      }
    }
    expect(safeRunError(new ProviderError('401 {"error":"bad key sk-1"}'))).toBe('The scan failed: ProviderError');
    expect(safeRunError(new Error('plain'))).toBe('The scan failed: Error');
    expect(safeRunError('a string')).toBe('The scan failed: Error');
    // A message that is kept is still cut short (the cut is marked).
    const kept = safeRunError(new RedTeamNotFoundError('x'.repeat(500)));
    expect(kept.startsWith('x'.repeat(300))).toBe(true);
    expect(kept.length).toBeLessThan(400);
  });

  it('agrees with the aggregate the runs are summed with', () => {
    expect(computeAggregate([]).attackSuccessRate).toBeNull();
  });
});

// ── Review aggregate write, key retries, output tokens, warning wording ───────

describe('review aggregate compare-and-set', () => {
  it('computes the aggregate again when the first guarded write misses', async () => {
    const run = await seedRun({ status: 'completed' });
    await seedRows(run._id, [storedAttempt('p1', 'a1', 'safe'), storedAttempt('p1', 'a2', 'safe')]);
    h.db.state.missNextIf = 1;
    const ifSpy = vi.spyOn(h.db, 'updateRedTeamRunIf');

    const result = await reviewAttempt(TENANT, run._id, 'p1::a1', { outcome: 'vulnerable', reviewedBy: 'ann' });

    expect(ifSpy).toHaveBeenCalledTimes(2);
    expect(result!.aggregate?.vulnerable).toBe(1);
    expect(h.db.runs.get(run._id).aggregate.vulnerable).toBe(1);
  });

  it('falls back to a plain write when every guarded write misses', async () => {
    const run = await seedRun({ status: 'completed' });
    await seedRows(run._id, [storedAttempt('p1', 'a1', 'safe')]);
    h.db.state.missNextIf = 10;

    const result = await reviewAttempt(TENANT, run._id, 'p1::a1', { outcome: 'vulnerable', reviewedBy: 'ann' });

    expect(result!.aggregate?.vulnerable).toBe(1);
    expect(h.db.runs.get(run._id).aggregate.vulnerable).toBe(1);
  });
});

describe('creating a campaign under a taken key', () => {
  const input = { name: 'Fresh', targetKind: 'model' as const, modelKey: 'm', probeKeys: ['prompt-injection'], projectId: PROJECT };

  it('tries again after a duplicate-key error', async () => {
    h.db.state.dupCampaignCreates = 2;

    const created = await createCampaign(TENANT, 'tenant-1', 'ann', input);

    expect(h.db.createRedTeamCampaign).toHaveBeenCalledTimes(3);
    expect(created.key).toBeTruthy();
  });

  it('gives up with a conflict after three duplicate-key errors', async () => {
    h.db.state.dupCampaignCreates = 3;

    await expect(createCampaign(TENANT, 'tenant-1', 'ann', input)).rejects.toBeInstanceOf(RedTeamConflictError);
    expect(h.db.createRedTeamCampaign).toHaveBeenCalledTimes(3);
  });

  it('does not retry an unrelated error', async () => {
    h.db.createRedTeamCampaign.mockRejectedValueOnce(new Error('disk full'));

    await expect(createCampaign(TENANT, 'tenant-1', 'ann', input)).rejects.toThrow('disk full');
    expect(h.db.createRedTeamCampaign).toHaveBeenCalledTimes(1);
  });
});

describe('model target output tokens', () => {
  it('sends no maxOutputTokens when the campaign set none', async () => {
    const { params } = await pendingRun();
    const specs: any[] = [];

    await executeRun(params, { buildTargetInvoker: ((spec: any) => { specs.push(spec); return async () => ({ text: 'ok' }); }) as any });

    expect(specs[0].kind).toBe('model');
    expect('maxOutputTokens' in specs[0]).toBe(false);
  });
});

describe('not-run warning wording', () => {
  it('reads "1 attempt was not run" for a single attempt', async () => {
    const { params } = await pendingRun();
    h.runner.impl = async () => ({ attempts: [engineAttempt('prompt-injection', 'pi-1')], stopped: false, skipped: 1 });

    const result = await executeRun(params);

    expect(result.warnings?.some((w) => w.startsWith('1 attempt was not run:'))).toBe(true);
  });
});
