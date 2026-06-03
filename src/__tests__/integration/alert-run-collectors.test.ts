/**
 * Integration test for the analysis & evaluation alert metric collectors.
 *
 * Seeds completed/failed runs with known aggregates in a real SQLite tenant DB
 * and asserts the collectors average the right aggregate field (as a 0–100
 * percentage), respect the status filter, exclude null metrics, and honour the
 * projectId scope.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-alert-collectors-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'alert_collectors_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import { AnalysisCollector } from '@/lib/services/alerts/metrics/analysisCollector';
import { EvaluationCollector } from '@/lib/services/alerts/metrics/evaluationCollector';

const TENANT_DB_NAME = 'alert_collectors_tenant';
const TENANT_ID = 'tenant-alert-collectors';

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);

  // Analysis runs (project p1)
  await db.createAnalysisRun({
    tenantId: TENANT_ID, projectId: 'p1', definitionKey: 'd1', status: 'completed', mode: 'sync',
    progress: { total: 2, completed: 2, failed: 0 }, items: [], createdBy: 'sys',
    aggregate: { total: 2, completed: 2, failed: 0, passed: 2, passRate: 1, avgJudgeScore: 0.8, avgExtractionAccuracy: 1 },
  });
  await db.createAnalysisRun({
    tenantId: TENANT_ID, projectId: 'p1', definitionKey: 'd1', status: 'completed', mode: 'sync',
    progress: { total: 2, completed: 2, failed: 0 }, items: [], createdBy: 'sys',
    aggregate: { total: 2, completed: 2, failed: 0, passed: 1, passRate: 0.5, avgJudgeScore: 0.6, avgExtractionAccuracy: null },
  });
  await db.createAnalysisRun({
    tenantId: TENANT_ID, projectId: 'p1', definitionKey: 'd1', status: 'failed', mode: 'sync',
    progress: { total: 1, completed: 0, failed: 1 }, items: [], createdBy: 'sys', error: 'boom',
  });
  await db.createAnalysisRun({
    tenantId: TENANT_ID, projectId: 'p2', definitionKey: 'd2', status: 'completed', mode: 'sync',
    progress: { total: 1, completed: 1, failed: 0 }, items: [], createdBy: 'sys',
    aggregate: { total: 1, completed: 1, failed: 0, passed: 0, passRate: 0, avgJudgeScore: 0, avgExtractionAccuracy: 0 },
  });

  // Evaluation run (project p1)
  await db.createEvaluationRun({
    tenantId: TENANT_ID, projectId: 'p1', suiteKey: 's1', targetKey: 't1', datasetKey: 'ds1',
    status: 'completed', mode: 'sync', progress: { total: 2, completed: 2, failed: 0 }, items: [], createdBy: 'sys',
    aggregate: { total: 2, completed: 2, failed: 0, passed: 1, passRate: 0.6, avgScore: 0.9, avgLatencyMs: 120 },
  });
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('AnalysisCollector', () => {
  const collector = new AnalysisCollector();
  const base = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, windowMinutes: 1440 };

  it('averages passRate over completed runs (excludes failed)', async () => {
    const r = await collector.collect({ ...base, metric: 'analysis_pass_rate', scope: { projectId: 'p1' } });
    expect(r.value).toBeCloseTo(75, 5); // avg(1, 0.5) * 100
    expect(r.sampleCount).toBe(2);
  });

  it('averages judge score', async () => {
    const r = await collector.collect({ ...base, metric: 'analysis_avg_judge_score', scope: { projectId: 'p1' } });
    expect(r.value).toBeCloseTo(70, 5); // avg(0.8, 0.6) * 100
    expect(r.sampleCount).toBe(2);
  });

  it('excludes null metrics from accuracy average', async () => {
    const r = await collector.collect({ ...base, metric: 'analysis_avg_accuracy', scope: { projectId: 'p1' } });
    expect(r.value).toBeCloseTo(100, 5); // only the non-null run (1) counts
    expect(r.sampleCount).toBe(1);
  });

  it('honours the projectId scope', async () => {
    const r = await collector.collect({ ...base, metric: 'analysis_pass_rate', scope: { projectId: 'p2' } });
    expect(r.value).toBeCloseTo(0, 5);
    expect(r.sampleCount).toBe(1);
  });
});

describe('EvaluationCollector', () => {
  const collector = new EvaluationCollector();
  const base = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, windowMinutes: 1440 };

  it('averages passRate and score', async () => {
    const pass = await collector.collect({ ...base, metric: 'evaluation_pass_rate', scope: { projectId: 'p1' } });
    expect(pass.value).toBeCloseTo(60, 5);
    const score = await collector.collect({ ...base, metric: 'evaluation_avg_score', scope: { projectId: 'p1' } });
    expect(score.value).toBeCloseTo(90, 5);
    expect(score.sampleCount).toBe(1);
  });
});
