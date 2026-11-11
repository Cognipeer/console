/**
 * Run lifecycle of the evaluation service on a real SQLiteProvider: the atomic
 * claim, cancellation (pending and running), the duplicate guard, the empty
 * dataset refusal, compare validation, delete conflicts and the item-less run
 * listing. Target/judge invokers are injected fakes.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const queue = vi.hoisted(() => ({ publish: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('@/lib/core/queue', () => ({
  getQueue: async () => queue,
}));

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-eval-lifecycle-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'eval_lifecycle_main';
process.env.EVALUATION_RUN_CANCEL_POLL_MS = '20';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import { EvaluationConflictError, EvaluationInputError } from '@/lib/services/evaluation/errors';
import { enqueueSuiteRun } from '@/lib/services/evaluation/evaluationRunJob';
import {
  cancelRun,
  compareRuns,
  createAsyncRun,
  createDataset,
  createSuite,
  createTarget,
  deleteDataset,
  deleteSuite,
  deleteTarget,
  executeRun,
  getRun,
  listRunSummaries,
  runSuite,
} from '@/lib/services/evaluation/service';

const TENANT_DB_NAME = 'eval_lifecycle_tenant';
const TENANT_ID = 'tenant-eval-lifecycle';
const ACTOR = 'tester@example.com';

let counter = 0;

const params = (suiteKey: string) => ({
  tenantDbName: TENANT_DB_NAME,
  tenantId: TENANT_ID,
  createdBy: ACTOR,
  actorType: 'user' as const,
  suiteKey,
});

const okTarget = () => async () => ({ text: 'ok' });

async function makeSuite(itemCount = 2) {
  counter += 1;
  const target = await createTarget(TENANT_DB_NAME, TENANT_ID, ACTOR, {
    name: `Target ${counter}`,
    kind: 'model',
    modelKey: 'm',
  });
  const dataset = await createDataset(TENANT_DB_NAME, TENANT_ID, ACTOR, {
    name: `Dataset ${counter}`,
    items: Array.from({ length: itemCount }, (_, i) => ({
      id: `q${i}`,
      input: [{ role: 'user' as const, content: `say ok ${i}` }],
      expected: { mustContain: ['ok'] },
    })),
  });
  const suite = await createSuite(TENANT_DB_NAME, TENANT_ID, ACTOR, {
    name: `Suite ${counter}`,
    targetKey: target.key,
    datasetKey: dataset.key,
    scorers: [{ type: 'assertion' }],
    runConfig: { concurrency: 1 },
  });
  return { target, dataset, suite };
}

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('claiming a run', () => {
  it('executes a pending run once and leaves a second delivery alone', async () => {
    const { suite } = await makeSuite();
    const run = await createAsyncRun(params(suite.key));
    const invoke = vi.fn(okTarget());
    const deps = { buildTargetInvoker: () => invoke };

    const first = await executeRun({ ...params(suite.key), runId: run.id }, deps);
    expect(first.status).toBe('completed');
    expect(invoke).toHaveBeenCalledTimes(2);

    const second = await executeRun({ ...params(suite.key), runId: run.id }, deps);
    expect(second.status).toBe('completed');
    expect(invoke).toHaveBeenCalledTimes(2); // not executed again
  });

  it('does not execute a run that was cancelled while pending', async () => {
    const { suite } = await makeSuite();
    const run = await createAsyncRun(params(suite.key));
    const cancelled = await cancelRun(TENANT_DB_NAME, run.id);
    expect(cancelled?.outcome).toBe('cancelled');
    expect(cancelled?.run.status).toBe('cancelled');

    const invoke = vi.fn(okTarget());
    const result = await executeRun({ ...params(suite.key), runId: run.id }, { buildTargetInvoker: () => invoke });
    expect(result.status).toBe('cancelled');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stamps the heartbeat when it claims', async () => {
    const { suite } = await makeSuite();
    const run = await createAsyncRun(params(suite.key));
    let seen: Date | undefined;
    await executeRun(
      { ...params(suite.key), runId: run.id },
      {
        buildTargetInvoker: () => async () => {
          seen ??= (await getRun(TENANT_DB_NAME, run.id))?.heartbeatAt;
          return { text: 'ok' };
        },
      },
    );
    expect(seen).toBeTruthy();
  });
});

describe('cancelRun', () => {
  it('answers null for a missing run and for another project', async () => {
    expect(await cancelRun(TENANT_DB_NAME, 'does-not-exist')).toBeNull();

    counter += 1;
    const target = await createTarget(TENANT_DB_NAME, TENANT_ID, ACTOR, { name: `PT ${counter}`, kind: 'model', modelKey: 'm', projectId: 'proj-a' });
    const dataset = await createDataset(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: `PD ${counter}`,
      projectId: 'proj-a',
      items: [{ id: 'a', input: [{ role: 'user', content: 'x' }] }],
    });
    const suite = await createSuite(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: `PS ${counter}`,
      targetKey: target.key,
      datasetKey: dataset.key,
      scorers: [{ type: 'assertion' }],
      projectId: 'proj-a',
    });
    const run = await createAsyncRun({ ...params(suite.key), projectId: 'proj-a' });

    expect(await cancelRun(TENANT_DB_NAME, run.id, 'proj-b')).toBeNull();
    expect(await cancelRun(TENANT_DB_NAME, run.id)).toBeNull();
    expect((await cancelRun(TENANT_DB_NAME, run.id, 'proj-a'))?.outcome).toBe('cancelled');
  });

  it('reports an already finished run', async () => {
    const { suite } = await makeSuite();
    const run = await runSuite(params(suite.key), { buildTargetInvoker: () => okTarget() });
    const result = await cancelRun(TENANT_DB_NAME, run.id);
    expect(result?.outcome).toBe('already_finished');
    expect(result?.run.status).toBe('completed');
  });

  it('stops a running run and keeps the items it had processed', async () => {
    const { suite } = await makeSuite(6);
    const run = await createAsyncRun(params(suite.key));
    let calls = 0;
    const result = await executeRun(
      { ...params(suite.key), runId: run.id },
      {
        buildTargetInvoker: () => async () => {
          calls += 1;
          if (calls === 1) {
            const outcome = await cancelRun(TENANT_DB_NAME, run.id);
            expect(outcome?.outcome).toBe('cancel_requested');
          }
          // Long enough for the 20 ms cancel poll to notice the request.
          await new Promise((resolve) => setTimeout(resolve, 120));
          return { text: 'ok' };
        },
      },
    );

    expect(result.status).toBe('cancelled');
    expect(calls).toBeLessThan(6);
    expect(result.items.length).toBe(calls);
    expect(result.aggregate?.total).toBe(calls);
    expect(result.finishedAt).toBeTruthy();
  });
});

describe('duplicate guard', () => {
  it('refuses a second run while one is pending, with a conflict error', async () => {
    const { suite } = await makeSuite();
    await createAsyncRun(params(suite.key));
    const err = await createAsyncRun(params(suite.key)).catch((e) => e);
    expect(err).toBeInstanceOf(EvaluationConflictError);
    expect(String(err.message)).toMatch(/already in progress/);
  });

  it('marks the run failed and rethrows when the job cannot be queued', async () => {
    const { suite } = await makeSuite();
    queue.publish.mockRejectedValueOnce(new Error('redis down'));
    await expect(enqueueSuiteRun(params(suite.key))).rejects.toThrow('redis down');

    const { runs } = await listRunSummaries(TENANT_DB_NAME, { suiteKey: suite.key });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toMatch(/^Could not queue the run: redis down/);
    // The failed run no longer blocks the suite.
    await expect(createAsyncRun(params(suite.key))).resolves.toBeTruthy();
  });
});

describe('input and conflict errors', () => {
  it('refuses a run of an empty dataset with an input error', async () => {
    const { suite, dataset } = await makeSuite(0);
    const err = await createAsyncRun(params(suite.key)).catch((e) => e);
    expect(err).toBeInstanceOf(EvaluationInputError);
    expect(String(err.message)).toBe(`Dataset "${dataset.key}" has no items to evaluate`);
  });

  it('compares only completed runs of the same dataset', async () => {
    const a = await makeSuite();
    const b = await makeSuite();
    const runA = await runSuite(params(a.suite.key), { buildTargetInvoker: () => okTarget() });
    const runA2 = await runSuite(params(a.suite.key), { buildTargetInvoker: () => okTarget() });
    const runB = await runSuite(params(b.suite.key), { buildTargetInvoker: () => okTarget() });
    const pending = await createAsyncRun(params(b.suite.key));

    expect(await compareRuns(TENANT_DB_NAME, runA.id, 'missing')).toBeNull();
    await expect(compareRuns(TENANT_DB_NAME, pending.id, runB.id)).rejects.toBeInstanceOf(EvaluationConflictError);
    await expect(compareRuns(TENANT_DB_NAME, runB.id, runA.id)).rejects.toThrow(/different datasets/);
    expect(await compareRuns(TENANT_DB_NAME, runA2.id, runA.id)).toBeTruthy();
  });

  it('refuses to delete a target or dataset a suite uses, and a suite with an active run', async () => {
    const { suite, target, dataset } = await makeSuite();
    await expect(deleteTarget(TENANT_DB_NAME, target.id)).rejects.toThrow(
      new RegExp(`target "${target.key}" is still used by suite "${suite.key}"`),
    );
    await expect(deleteDataset(TENANT_DB_NAME, dataset.id)).rejects.toBeInstanceOf(EvaluationConflictError);

    await createAsyncRun(params(suite.key));
    await expect(deleteSuite(TENANT_DB_NAME, suite.id)).rejects.toThrow(/run in progress/);
  });
});

describe('listRunSummaries', () => {
  it('pages runs without their items and reports the total', async () => {
    const { suite } = await makeSuite(3);
    await runSuite(params(suite.key), { buildTargetInvoker: () => okTarget() });
    await runSuite(params(suite.key), { buildTargetInvoker: () => okTarget() });
    await runSuite(params(suite.key), { buildTargetInvoker: () => okTarget() });

    const page = await listRunSummaries(TENANT_DB_NAME, { suiteKey: suite.key, limit: 2, skip: 0 });
    expect(page.total).toBe(3);
    expect(page.runs).toHaveLength(2);
    expect(page.runs.every((r) => r.items.length === 0)).toBe(true);
    expect(page.runs[0].aggregate?.total).toBe(3);

    const rest = await listRunSummaries(TENANT_DB_NAME, { suiteKey: suite.key, limit: 2, skip: 2 });
    expect(rest.runs).toHaveLength(1);
  });
});
