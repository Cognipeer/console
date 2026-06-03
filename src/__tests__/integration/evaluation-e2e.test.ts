/**
 * End-to-end test for the Evaluation service vertical.
 *
 * Backed by a real SQLiteProvider in a temp directory. Exercises CRUD for
 * targets / datasets / suites and a full `runSuite` flow whose target & judge
 * invokers are injected (fakes) so no live model calls are made — verifying
 * persistence, aggregation, and run retrieval against the real DB layer.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + temp dir must be configured BEFORE getDatabase() is ever called.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-eval-e2e-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'eval_e2e_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import {
  createDataset,
  createSuite,
  createTarget,
  deleteTarget,
  getRun,
  listDatasets,
  listRuns,
  listSuites,
  listTargets,
  runSuite,
  updateTarget,
} from '@/lib/services/evaluation/service';

const TENANT_DB_NAME = 'eval_e2e_tenant';
const TENANT_ID = 'tenant-eval-e2e';
const ACTOR = 'tester@example.com';

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Evaluation service — full vertical (SQLite)', () => {
  it('persists targets, datasets and suites then runs an evaluation', async () => {
    const target = await createTarget(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'GPT Eval Target',
      kind: 'model',
      modelKey: 'gpt-test',
    });
    expect(target.id).toBeTruthy();
    expect(target.key).toBe('gpt-eval-target');
    expect(target.kind).toBe('model');

    const dataset = await createDataset(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Smoke Dataset',
      items: [
        { id: 'q1', input: [{ role: 'user', content: 'say ok' }], expected: { mustContain: ['ok'] } },
        { id: 'q2', input: [{ role: 'user', content: 'say ok too' }], expected: { mustContain: ['ok'] } },
      ],
    });
    expect(dataset.id).toBeTruthy();
    expect(dataset.items).toHaveLength(2);

    const suite = await createSuite(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Smoke Suite',
      targetKey: target.key,
      datasetKey: dataset.key,
      scorers: [{ type: 'assertion' }, { type: 'llm-judge', rubric: 'Answer must contain ok.' }],
      judgeModelKey: 'judge-test',
    });
    expect(suite.id).toBeTruthy();
    expect(suite.scorers).toHaveLength(2);

    // Injected fakes: target echoes "ok" only for q1; judge always approves.
    const targetFn = vi.fn(async (item: { id: string }) => ({ text: item.id === 'q1' ? 'ok' : 'nope' }));
    const judgeFn = vi.fn(async () => '{"score":1,"passed":true}');

    const run = await runSuite(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, createdBy: ACTOR, suiteKey: suite.key },
      { buildTargetInvoker: () => targetFn, buildJudgeInvoker: () => judgeFn },
    );

    expect(run.status).toBe('completed');
    expect(run.suiteKey).toBe(suite.key);
    expect(run.aggregate?.total).toBe(2);
    expect(run.aggregate?.completed).toBe(2);
    expect(run.aggregate?.passed).toBe(1); // only q1 passes the assertion
    expect(run.aggregate?.passRate).toBeCloseTo(0.5, 5);
    expect(run.aggregate?.avgScore).toBeCloseTo(0.75, 5); // q1=1.0, q2=0.5
    expect(run.items).toHaveLength(2);
    expect(targetFn).toHaveBeenCalledTimes(2);
    expect(judgeFn).toHaveBeenCalledTimes(2);

    // Run is retrievable by id with its persisted items.
    const fetched = await getRun(TENANT_DB_NAME, run.id);
    expect(fetched?.id).toBe(run.id);
    expect(fetched?.items).toHaveLength(2);
    const q1 = fetched?.items.find((i) => i.itemId === 'q1');
    expect(q1?.passed).toBe(true);
    expect(q1?.scores).toHaveLength(2);
  });

  it('lists entities and round-trips target update/delete', async () => {
    const targets = await listTargets(TENANT_DB_NAME);
    const datasets = await listDatasets(TENANT_DB_NAME);
    const suites = await listSuites(TENANT_DB_NAME);
    const runs = await listRuns(TENANT_DB_NAME);
    expect(targets.length).toBeGreaterThanOrEqual(1);
    expect(datasets.length).toBeGreaterThanOrEqual(1);
    expect(suites.length).toBeGreaterThanOrEqual(1);
    expect(runs.length).toBeGreaterThanOrEqual(1);

    const extra = await createTarget(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Disposable Target',
      kind: 'model',
      modelKey: 'tmp',
    });
    const updated = await updateTarget(TENANT_DB_NAME, extra.id, ACTOR, { description: 'updated desc' });
    expect(updated?.description).toBe('updated desc');

    const deleted = await deleteTarget(TENANT_DB_NAME, extra.id);
    expect(deleted).toBe(true);
    expect(await listTargets(TENANT_DB_NAME, { search: 'Disposable' })).toHaveLength(0);
  });

  it('records a per-item error when the target invoker throws', async () => {
    const target = await createTarget(TENANT_DB_NAME, TENANT_ID, ACTOR, { name: 'Erroring Target', kind: 'model', modelKey: 'x' });
    const dataset = await createDataset(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Error Dataset',
      items: [{ id: 'e1', input: [{ role: 'user', content: 'hi' }] }],
    });
    const suite = await createSuite(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Error Suite',
      targetKey: target.key,
      datasetKey: dataset.key,
      scorers: [{ type: 'assertion' }],
    });

    const run = await runSuite(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, createdBy: ACTOR, suiteKey: suite.key },
      { buildTargetInvoker: () => async () => { throw new Error('model exploded'); } },
    );

    expect(run.status).toBe('completed');
    expect(run.aggregate?.failed).toBe(1);
    expect(run.aggregate?.completed).toBe(0);
    expect(run.items[0].error).toMatch(/model exploded/);
  });
});
