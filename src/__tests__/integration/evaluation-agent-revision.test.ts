/**
 * Agent evaluation targets run the draft or any published version, not only
 * the published one. Backed by a real SQLiteProvider; the target invoker is an
 * injected fake that records what the run handed it, so what is asserted is
 * the selector every item would run on and the revision the run recorded.
 * Also the caller check the routes hand to the service: it is asked before any
 * run row exists, and it never rides on the queued job.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const queue = vi.hoisted(() => ({ publish: vi.fn(async () => undefined) }));
vi.mock('@/lib/core/queue', () => ({
  getQueue: async () => queue,
}));

// SQLite + temp dir must be configured BEFORE getDatabase() is ever called.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-eval-revision-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'eval_revision_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type IAgentConfig } from '@/lib/database';
import { AgentRevisionError } from '@/lib/services/agents/agentRevision';
import type { buildTargetInvoker } from '@/lib/services/evaluation/adapters';
import { enqueueSuiteRun } from '@/lib/services/evaluation/evaluationRunJob';
import {
  createAsyncRun,
  createDataset,
  createSuite,
  createTarget,
  executeRun,
  getRun,
  getTarget,
  listRuns,
  runSuite,
  updateSuite,
  updateTarget,
  type CreateTargetInput,
  type RunSuiteParams,
} from '@/lib/services/evaluation/service';

const TENANT_DB_NAME = 'eval_revision_tenant';
const TENANT_ID = 'tenant-eval-revision';
const PROJECT_ID = 'proj-revision';
const ACTOR = 'tester@example.com';

const configOf = (systemPrompt: string): IAgentConfig => ({ modelKey: 'm1', systemPrompt });

let datasetKey = '';
let counter = 0;

async function seedAgent(key: string, publishedVersion: number | null) {
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);
  const agent = await db.createAgent({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key,
    name: key,
    config: configOf('draft prompt'),
    status: 'active',
    publishedVersion,
    latestVersion: 2,
    createdBy: ACTOR,
  });
  const agentId = String(agent._id);
  for (const version of [1, 2]) {
    await db.createAgentVersion({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      agentId,
      agentKey: key,
      version,
      snapshot: { name: key, config: configOf(`v${version} prompt`), status: 'active' },
      publishedBy: ACTOR,
    });
  }
  return { db, agentId };
}

async function makeSuite(target: Partial<CreateTargetInput>) {
  counter += 1;
  const created = await createTarget(TENANT_DB_NAME, TENANT_ID, ACTOR, {
    name: `Target ${counter}`,
    kind: 'agent',
    agentKey: 'bot',
    projectId: PROJECT_ID,
    ...target,
  });
  const suite = await createSuite(TENANT_DB_NAME, TENANT_ID, ACTOR, {
    name: `Suite ${counter}`,
    targetKey: created.key,
    datasetKey,
    scorers: [{ type: 'assertion' }],
    projectId: PROJECT_ID,
  });
  return { target: created, suite };
}

/** A fake invoker factory that records the options it was built with. */
function recordingInvoker(onItem?: () => Promise<void>) {
  const calls: unknown[] = [];
  const build = vi.fn((_target: unknown, _ctx: unknown, options?: unknown) => {
    calls.push(options);
    const invoke: ReturnType<typeof buildTargetInvoker> = async () => {
      await onItem?.();
      return { text: 'ok' };
    };
    return invoke;
  });
  return { build, calls };
}

const paramsFor = (suiteKey: string, extra: Partial<RunSuiteParams> = {}): RunSuiteParams => ({
  tenantDbName: TENANT_DB_NAME,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  createdBy: ACTOR,
  suiteKey,
  ...extra,
});

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);
  const dataset = await createDataset(TENANT_DB_NAME, TENANT_ID, ACTOR, {
    name: 'Revision Dataset',
    projectId: PROJECT_ID,
    items: [
      { id: 'q1', input: [{ role: 'user', content: 'say ok' }], expected: { mustContain: ['ok'] } },
      { id: 'q2', input: [{ role: 'user', content: 'say ok too' }], expected: { mustContain: ['ok'] } },
    ],
  });
  datasetKey = dataset.key;
  await seedAgent('bot', 2);
  await seedAgent('fresh-bot', null);
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('evaluation targets keep a default revision', () => {
  it('persists a pinned version and the draft, and clearing the pin follows the published version', async () => {
    const pinned = await createTarget(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Pinned', kind: 'agent', agentKey: 'bot', agentVersion: 3, projectId: PROJECT_ID,
    });
    expect((await getTarget(TENANT_DB_NAME, pinned.id))?.agentVersion).toBe(3);

    const draft = await createTarget(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Drafty', kind: 'agent', agentKey: 'bot', agentVersion: 'draft', projectId: PROJECT_ID,
    });
    expect((await getTarget(TENANT_DB_NAME, draft.id))?.agentVersion).toBe('draft');

    const switched = await updateTarget(TENANT_DB_NAME, pinned.id, ACTOR, { agentVersion: 'draft' });
    expect(switched?.agentVersion).toBe('draft');

    const cleared = await updateTarget(TENANT_DB_NAME, pinned.id, ACTOR, { agentVersion: null });
    expect(cleared?.agentVersion ?? null).toBeNull();
    expect((await getTarget(TENANT_DB_NAME, pinned.id))?.agentVersion ?? null).toBeNull();
  });

  it('does not store a pin on a model target', async () => {
    const model = await createTarget(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Model', kind: 'model', modelKey: 'gpt-test', agentVersion: 4, projectId: PROJECT_ID,
    });
    expect((await getTarget(TENANT_DB_NAME, model.id))?.agentVersion ?? null).toBeNull();
  });
});

describe('an agent run pins the revision it tests', () => {
  it('follows the published version by default and records the number that answered', async () => {
    const { suite } = await makeSuite({});
    const { build, calls } = recordingInvoker();
    const run = await runSuite(paramsFor(suite.key), { buildTargetInvoker: build });

    expect(run.status).toBe('completed');
    expect(calls).toEqual([{ agentRun: { version: 2 } }]);
    expect(run.agentRevision).toEqual({ requested: 'published', agentKey: 'bot', version: 2 });
  });

  it('runs the draft when the run asks for it, with a fingerprint of the draft config', async () => {
    const { suite } = await makeSuite({});
    const { build, calls } = recordingInvoker();
    const run = await runSuite(paramsFor(suite.key, { agentVersion: 'draft' }), { buildTargetInvoker: build });

    expect(calls).toEqual([{ agentRun: {} }]);
    expect(run.agentRevision).toMatchObject({ requested: 'draft', version: null });
    expect(run.agentRevision?.draftFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(run.agentRevision?.draftChanged).toBeUndefined();
  });

  it('lets a run override a pinned default with an older version', async () => {
    const { suite } = await makeSuite({ agentVersion: 2 });
    const { build, calls } = recordingInvoker();
    const run = await runSuite(paramsFor(suite.key, { agentVersion: 1 }), { buildTargetInvoker: build });

    expect(calls).toEqual([{ agentRun: { version: 1 } }]);
    expect(run.agentRevision).toEqual({ requested: 1, agentKey: 'bot', version: 1 });
  });

  it('uses the target default when the run does not override it', async () => {
    const draftSuite = await makeSuite({ agentVersion: 'draft' });
    const draftInvoker = recordingInvoker();
    const draftRun = await runSuite(paramsFor(draftSuite.suite.key), { buildTargetInvoker: draftInvoker.build });
    expect(draftInvoker.calls).toEqual([{ agentRun: {} }]);
    expect(draftRun.agentRevision).toMatchObject({ requested: 'draft', version: null });

    const pinnedSuite = await makeSuite({ agentVersion: 1 });
    const pinnedInvoker = recordingInvoker();
    const pinnedRun = await runSuite(paramsFor(pinnedSuite.suite.key), { buildTargetInvoker: pinnedInvoker.build });
    expect(pinnedInvoker.calls).toEqual([{ agentRun: { version: 1 } }]);
    expect(pinnedRun.agentRevision).toEqual({ requested: 1, agentKey: 'bot', version: 1 });
  });

  it('falls back to the draft, and says so, when nothing is published', async () => {
    const { suite } = await makeSuite({ agentKey: 'fresh-bot' });
    const { build, calls } = recordingInvoker();
    const run = await runSuite(paramsFor(suite.key), { buildTargetInvoker: build });

    expect(calls).toEqual([{ agentRun: {} }]);
    expect(run.agentRevision).toMatchObject({ requested: 'published', version: null });
    expect(run.agentRevision?.draftFingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('flags a draft run whose draft was saved while it ran', async () => {
    const { suite } = await makeSuite({ agentKey: 'bot' });
    const { db, agentId } = await seedAgent('edited-bot', 2);
    const { suite: editedSuite } = await makeSuite({ agentKey: 'edited-bot' });
    let edited = false;
    const { build } = recordingInvoker(async () => {
      if (edited) return;
      edited = true;
      await db.updateAgent(agentId, { config: configOf('edited mid-run') });
    });

    const changed = await runSuite(paramsFor(editedSuite.key, { agentVersion: 'draft' }), { buildTargetInvoker: build });
    expect(changed.agentRevision?.draftChanged).toBe(true);
    expect(changed.agentRevision?.version).toBeNull();

    const untouched = await runSuite(paramsFor(suite.key, { agentVersion: 'draft' }), {
      buildTargetInvoker: recordingInvoker().build,
    });
    expect(untouched.agentRevision?.draftChanged).toBeFalsy();
  });

  it('never marks a pinned version as changed', async () => {
    const { suite } = await makeSuite({});
    const run = await runSuite(paramsFor(suite.key, { agentVersion: 1 }), { buildTargetInvoker: recordingInvoker().build });
    expect(run.agentRevision?.draftChanged).toBeUndefined();
  });
});

describe('a run that could not test what it was asked to', () => {
  it('refuses a revision on a model target and creates no run', async () => {
    const { suite } = await makeSuite({ kind: 'model', agentKey: undefined, modelKey: 'gpt-test' });
    await expect(
      runSuite(paramsFor(suite.key, { agentVersion: 'draft' }), { buildTargetInvoker: recordingInvoker().build }),
    ).rejects.toBeInstanceOf(AgentRevisionError);
    expect(await listRuns(TENANT_DB_NAME, { projectId: PROJECT_ID, suiteKey: suite.key })).toHaveLength(0);
  });

  it('refuses a version that was never published and creates no run', async () => {
    const { suite } = await makeSuite({});
    await expect(
      runSuite(paramsFor(suite.key, { agentVersion: 9 }), { buildTargetInvoker: recordingInvoker().build }),
    ).rejects.toThrow(/Version 9 not found/);
    expect(await listRuns(TENANT_DB_NAME, { projectId: PROJECT_ID, suiteKey: suite.key })).toHaveLength(0);
  });

  it('refuses a pinned default whose version is missing', async () => {
    const { suite } = await makeSuite({ agentVersion: 7 });
    await expect(
      runSuite(paramsFor(suite.key), { buildTargetInvoker: recordingInvoker().build }),
    ).rejects.toThrow(/Version 7 not found/);
    expect(await listRuns(TENANT_DB_NAME, { projectId: PROJECT_ID, suiteKey: suite.key })).toHaveLength(0);
  });
});

describe('the concurrent-run guard looks at the revision', () => {
  it('blocks a second run of the same revision but allows another revision', async () => {
    const { target, suite } = await makeSuite({});
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    const running = await db.createEvaluationRun({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      suiteKey: suite.key,
      targetKey: target.key,
      datasetKey,
      status: 'running',
      mode: 'async',
      progress: { total: 2, completed: 0, failed: 0 },
      items: [],
      agentRevision: { requested: 'draft', version: null, draftFingerprint: 'abc123abc123' },
      startedAt: new Date(),
      createdBy: ACTOR,
    });

    await expect(
      runSuite(paramsFor(suite.key, { agentVersion: 'draft' }), { buildTargetInvoker: recordingInvoker().build }),
    ).rejects.toThrow(/already in progress on draft/);

    const published = await runSuite(paramsFor(suite.key), { buildTargetInvoker: recordingInvoker().build });
    expect(published.status).toBe('completed');

    await db.updateEvaluationRun(String(running._id), { status: 'completed', finishedAt: new Date() });
  });

  it('lets a run with no recorded revision block every request', async () => {
    const { target, suite } = await makeSuite({});
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    const legacy = await db.createEvaluationRun({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      suiteKey: suite.key,
      targetKey: target.key,
      datasetKey,
      status: 'running',
      mode: 'async',
      progress: { total: 2, completed: 0, failed: 0 },
      items: [],
      startedAt: new Date(),
      createdBy: ACTOR,
    });

    await expect(
      runSuite(paramsFor(suite.key, { agentVersion: 1 }), { buildTargetInvoker: recordingInvoker().build }),
    ).rejects.toThrow(/already in progress/);

    await db.updateEvaluationRun(String(legacy._id), { status: 'completed', finishedAt: new Date() });
  });
});

describe('a run asks the caller before it creates anything', () => {
  const allow = () => vi.fn(async () => undefined);
  const refuse = () => vi.fn(async () => {
    throw new Error('not allowed');
  });
  const runsOf = (suiteKey: string) => listRuns(TENANT_DB_NAME, { projectId: PROJECT_ID, suiteKey });

  it('asks once for an agent target and goes on when the answer is yes', async () => {
    const { suite } = await makeSuite({});
    const authorize = allow();
    const run = await runSuite(paramsFor(suite.key, { authorizeAgentRun: authorize }), { buildTargetInvoker: recordingInvoker().build });

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('completed');
  });

  it.each([undefined, 'published', 'draft', 1] as const)('writes no run row when the answer is no, asking for revision %j', async (agentVersion) => {
    const { suite } = await makeSuite({});
    const invoker = recordingInvoker();

    await expect(
      runSuite(paramsFor(suite.key, { agentVersion, authorizeAgentRun: refuse() }), { buildTargetInvoker: invoker.build }),
    ).rejects.toThrow('not allowed');

    expect(await runsOf(suite.key)).toHaveLength(0);
    expect(invoker.build).not.toHaveBeenCalled();
  });

  it('writes no run row for an asynchronous run either', async () => {
    const { suite } = await makeSuite({});

    await expect(createAsyncRun(paramsFor(suite.key, { authorizeAgentRun: refuse() }))).rejects.toThrow('not allowed');
    expect(await runsOf(suite.key)).toHaveLength(0);

    await expect(enqueueSuiteRun(paramsFor(suite.key, { authorizeAgentRun: refuse() }))).rejects.toThrow('not allowed');
    expect(await runsOf(suite.key)).toHaveLength(0);
  });

  it('asks before it says whether a version exists, so a refused caller learns nothing about the agent', async () => {
    const { suite } = await makeSuite({});

    await expect(
      runSuite(paramsFor(suite.key, { agentVersion: 9, authorizeAgentRun: refuse() }), { buildTargetInvoker: recordingInvoker().build }),
    ).rejects.toThrow('not allowed');
  });

  it('asks before it reports that a run is already in progress', async () => {
    const { target, suite } = await makeSuite({});
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    const running = await db.createEvaluationRun({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      suiteKey: suite.key,
      targetKey: target.key,
      datasetKey,
      status: 'running',
      mode: 'async',
      progress: { total: 2, completed: 0, failed: 0 },
      items: [],
      agentRevision: { requested: 'published' },
      startedAt: new Date(),
      createdBy: ACTOR,
    });

    await expect(
      runSuite(paramsFor(suite.key, { authorizeAgentRun: refuse() }), { buildTargetInvoker: recordingInvoker().build }),
    ).rejects.toThrow('not allowed');

    await db.updateEvaluationRun(String(running._id), { status: 'completed', finishedAt: new Date() });
  });

  it.each([
    ['model', { kind: 'model' as const, agentKey: undefined, modelKey: 'gpt-test' }],
    ['external', { kind: 'external' as const, agentKey: undefined, external: { protocol: 'webhook' as const, url: 'https://example.test/hook' } }],
  ])('does not ask for a %s target', async (_kind, target) => {
    const { suite } = await makeSuite(target);
    const authorize = refuse(); // it would refuse, were it asked
    const run = await runSuite(paramsFor(suite.key, { authorizeAgentRun: authorize }), { buildTargetInvoker: recordingInvoker().build });

    expect(authorize).not.toHaveBeenCalled();
    expect(run.status).toBe('completed');
  });

  it('answers an unknown suite as not found, without asking', async () => {
    const authorize = refuse();

    await expect(runSuite(paramsFor('no-such-suite', { authorizeAgentRun: authorize }))).rejects.toThrow(/not found/);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('stops a queued run whose suite was pointed at another target while it waited', async () => {
    const { suite } = await makeSuite({ kind: 'model', agentKey: undefined, modelKey: 'gpt-test' });
    const { target: agentTarget } = await makeSuite({});
    const authorize = refuse(); // the caller may not run agents, and is not asked for a model target
    const run = await enqueueSuiteRun(paramsFor(suite.key, { authorizeAgentRun: authorize }));
    expect(authorize).not.toHaveBeenCalled();

    // Re-pointed before the worker picks the job up.
    await updateSuite(TENANT_DB_NAME, suite.id, ACTOR, { targetKey: agentTarget.key });
    const invoker = recordingInvoker();

    await expect(
      executeRun({ ...paramsFor(suite.key), runId: run.id }, { buildTargetInvoker: invoker.build }),
    ).rejects.toThrow(/now points at target/);
    expect(invoker.build).not.toHaveBeenCalled();
    const stopped = await getRun(TENANT_DB_NAME, run.id);
    expect(stopped?.status).toBe('failed');
    expect(stopped?.error).toMatch(/start the run again/);
  });

  it('records the agent a run tested, so retargeting does not rename past runs', async () => {
    const { target, suite } = await makeSuite({});
    const run = await runSuite(paramsFor(suite.key), { buildTargetInvoker: recordingInvoker().build });
    await updateTarget(TENANT_DB_NAME, target.id, ACTOR, { agentKey: 'fresh-bot' });

    expect((await getRun(TENANT_DB_NAME, run.id))?.agentRevision?.agentKey).toBe('bot');
  });

  it('keeps the check out of the queued job', async () => {
    const { suite } = await makeSuite({});
    queue.publish.mockClear();
    const authorize = allow();

    const run = await enqueueSuiteRun(paramsFor(suite.key, { agentVersion: 'draft', authorizeAgentRun: authorize }));

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('pending');
    expect(queue.publish).toHaveBeenCalledTimes(1);
    const payload = (queue.publish.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2];
    expect(payload).toEqual({
      tenantDbName: TENANT_DB_NAME,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      createdBy: ACTOR,
      suiteKey: suite.key,
      agentVersion: 'draft',
      runId: run.id,
    });
  });
});
