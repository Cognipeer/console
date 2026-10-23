/**
 * End-to-end test for the Analysis service vertical.
 *
 * Backed by a real SQLiteProvider in a temp directory. Exercises CRUD for
 * definitions / conversations and a full `runDefinition` flow whose model
 * invokers are injected (fakes) so no live model calls are made — verifying
 * persistence, extraction/judge/accuracy aggregation, store-mode write-back,
 * and run retrieval against the real DB layer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + temp dir must be configured BEFORE getDatabase() is ever called.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-analysis-e2e-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'analysis_e2e_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import {
  createDefinition,
  deleteConversation,
  deleteDefinition,
  getConversation,
  getRun,
  ingestConversations,
  listConversations,
  listDefinitions,
  listRuns,
  runDefinition,
  runScheduledAnalyses,
  updateDefinition,
} from '@/lib/services/analysis/service';
import {
  AnalysisReviewError,
  estimateRun,
  getCalibration,
  getResultDetail,
  listAgentSessionRows,
  listResults,
  saveResultReview,
} from '@/lib/services/analysis/results';
import type { AnalysisMessage, DecisionInvoker, ModelInvoker } from '@/lib/services/analysis/types';
import type { DecisionAnswer } from '@/lib/providers/domains/decision';

const TENANT_DB_NAME = 'analysis_e2e_tenant';
const TENANT_ID = 'tenant-analysis-e2e';
const ACTOR = 'tester@example.com';

/**
 * Fake decision invoker factory. Branches on the transcript text:
 * BILLING picks the "billing" choice, UNSURE answers at 50% confidence,
 * RESOLVED answers yes, EXPLODE makes the call fail.
 */
const fakeBuildDecisionInvoker = (): DecisionInvoker => async ({ input, questions }) => {
  if (input.includes('EXPLODE')) throw new Error('decision backend down');
  const unsure = input.includes('UNSURE');
  const answers: Record<string, DecisionAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      const keys = Object.keys(question.choices);
      const choice = input.includes('BILLING') ? 'billing' : keys[keys.length - 1];
      const rest = keys.filter((k) => k !== choice);
      const top = unsure ? 0.5 : 0.95;
      answers[key] = {
        type: 'choice',
        choice,
        probabilities: { [choice]: top, ...Object.fromEntries(rest.map((k) => [k, (1 - top) / rest.length])) },
        confidence: top,
        confidence_source: 'native',
      };
    } else if (question.type === 'boolean') {
      answers[key] = { type: 'boolean', probability: input.includes('RESOLVED') ? 0.9 : 0.1 };
    } else {
      answers[key] = { type: 'score', score: 1.2, probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 }, confidence: 0.7 };
    }
  }
  return { answers, rationale: 'because', backendKind: 'native' };
};

/** Extraction fake for the text fields of a decision definition. */
const fakeSummaryInvoker = (): ModelInvoker => async () => '{"summary":"short"}';

/** Fake invoker factory: extraction branches on a transcript marker; judge approves. */
const fakeBuildModelInvoker = (
  _modelKey: string | undefined,
  _ctx: unknown,
  role: 'extraction' | 'judge',
): ModelInvoker => {
  if (role === 'judge') {
    return async () => '{"score":0.9,"passed":true,"reasoning":"ok"}';
  }
  return async (messages: AnalysisMessage[]) => {
    const text = messages.map((m) => m.content).join('\n');
    if (text.includes('BILLING')) return '{"intent":"billing","resolved":true}';
    return '{"intent":"support","resolved":false}';
  };
};

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Analysis service — full vertical (SQLite)', () => {
  it('persists a definition + conversations then runs extraction, judge & accuracy', async () => {
    const definition = await createDefinition(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Call Intent Analysis',
      fieldSet: [
        { key: 'intent', type: 'enum', enumValues: ['billing', 'support'], required: true },
        { key: 'resolved', type: 'boolean' },
      ],
      modes: { store: true, judge: { rubric: 'Was the caller helped?' }, accuracy: true },
      extractionModelKey: 'extract-model',
      judgeModelKey: 'judge-model',
    });
    expect(definition.id).toBeTruthy();
    expect(definition.key).toBe('call-intent-analysis');
    expect(definition.modes.judge?.rubric).toContain('caller');

    const [c1, c2] = await ingestConversations(TENANT_DB_NAME, TENANT_ID, ACTOR, [
      {
        name: 'Call 1',
        transcript: [{ role: 'caller', content: 'I have a BILLING issue' }, { role: 'agent', content: 'Refunded.' }],
        referenceFields: { intent: 'billing', resolved: true },
      },
      {
        name: 'Call 2',
        transcript: [{ role: 'caller', content: 'A SUPPORT request' }],
        referenceFields: { intent: 'billing' }, // extracted 'support' → mismatch
      },
    ]);
    expect(c1.id).toBeTruthy();
    expect(c2.key).toBe('call-2');

    const run = await runDefinition(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, createdBy: ACTOR, definitionKey: definition.key },
      { buildModelInvoker: fakeBuildModelInvoker },
    );

    expect(run.status).toBe('completed');
    expect(run.definitionKey).toBe(definition.key);
    expect(run.aggregate?.total).toBe(2);
    expect(run.aggregate?.completed).toBe(2);
    expect(run.aggregate?.failed).toBe(0);
    expect(run.aggregate?.passed).toBe(2); // both extract required intent + judge approves
    expect(run.aggregate?.avgJudgeScore).toBeCloseTo(0.9, 5);
    expect(run.aggregate?.avgExtractionAccuracy).toBeCloseTo(0.5, 5); // c1=1.0, c2=0.0
    expect(run.items).toHaveLength(2);

    // Run is retrievable by id with persisted per-item detail.
    const fetched = await getRun(TENANT_DB_NAME, run.id);
    const item1 = fetched?.items.find((i) => i.conversationKey === c1.key);
    expect(item1?.extractedFields.intent).toBe('billing');
    expect(item1?.accuracy?.score).toBe(1);
    expect(item1?.judge?.passed).toBe(true);

    // Store mode wrote the extracted fields back onto the conversation.
    const storedC1 = await getConversation(TENANT_DB_NAME, c1.id);
    expect(storedC1?.extractedFields?.intent).toBe('billing');
    expect(storedC1?.lastAnalyzedAt).toBeTruthy();
  });

  it('lists entities and round-trips definition update / conversation delete', async () => {
    expect((await listDefinitions(TENANT_DB_NAME)).length).toBeGreaterThanOrEqual(1);
    expect((await listConversations(TENANT_DB_NAME)).length).toBeGreaterThanOrEqual(2);
    expect((await listRuns(TENANT_DB_NAME)).length).toBeGreaterThanOrEqual(1);

    const def = (await listDefinitions(TENANT_DB_NAME))[0];
    const updated = await updateDefinition(TENANT_DB_NAME, def.id, ACTOR, { description: 'nightly IVR analysis' });
    expect(updated?.description).toBe('nightly IVR analysis');

    const [conv] = await ingestConversations(TENANT_DB_NAME, TENANT_ID, ACTOR, [
      { name: 'Disposable', transcript: [{ role: 'caller', content: 'temp' }] },
    ]);
    expect(await deleteConversation(TENANT_DB_NAME, conv.id)).toBe(true);
    expect(await getConversation(TENANT_DB_NAME, conv.id)).toBeNull();
  });

  it('records per-item errors when the extraction model throws', async () => {
    const definition = await createDefinition(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Erroring Analysis',
      fieldSet: [{ key: 'intent', type: 'string', required: true }],
      modes: {},
      extractionModelKey: 'x',
    });
    await ingestConversations(TENANT_DB_NAME, TENANT_ID, ACTOR, [
      { key: 'err-only-conv', transcript: [{ role: 'caller', content: 'hi' }] },
    ]);

    const run = await runDefinition(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, createdBy: ACTOR, definitionKey: definition.key, conversationKeys: ['err-only-conv'] },
      { buildModelInvoker: () => async () => { throw new Error('model exploded'); } },
    );

    expect(run.status).toBe('completed');
    expect(run.aggregate?.total).toBe(1);
    expect(run.aggregate?.failed).toBe(1);
    expect(run.aggregate?.completed).toBe(0);
    expect(run.items[0].error).toMatch(/exploded/);
  });

  it('ingests tags, filters by tag, and honours run selection strategies', async () => {
    const PROJECT = 'sel-test';
    const definition = await createDefinition(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Selection Strategies',
      fieldSet: [{ key: 'intent', type: 'string' }],
      modes: {},
      extractionModelKey: 'extract-model',
      projectId: PROJECT,
    });

    await ingestConversations(
      TENANT_DB_NAME,
      TENANT_ID,
      ACTOR,
      [
        { key: 'sel-1', transcript: [{ role: 'caller', content: 'BILLING' }], tags: ['vip', 'march'] },
        { key: 'sel-2', transcript: [{ role: 'caller', content: 'BILLING' }], tags: ['vip'] },
        { key: 'sel-3', transcript: [{ role: 'caller', content: 'hi' }] },
        { key: 'sel-4', transcript: [{ role: 'caller', content: 'hi' }] },
      ],
      PROJECT,
    );

    // Tags round-trip and the tag filter narrows the corpus.
    const vip = await listConversations(TENANT_DB_NAME, { projectId: PROJECT, tag: 'vip' });
    expect(vip.map((c) => c.key).sort()).toEqual(['sel-1', 'sel-2']);
    const tagged = await listConversations(TENANT_DB_NAME, { projectId: PROJECT });
    expect(tagged.find((c) => c.key === 'sel-1')?.tags).toEqual(['vip', 'march']);

    const deps = { buildModelInvoker: fakeBuildModelInvoker };

    // tag selection → only the 2 vip conversations.
    const tagRun = await runDefinition(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: PROJECT, createdBy: ACTOR, definitionKey: definition.key, selection: { strategy: 'tag', tag: 'vip' } },
      deps,
    );
    expect(tagRun.aggregate?.total).toBe(2);

    // random sample of 1 → exactly 1 conversation analyzed.
    const randomRun = await runDefinition(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: PROJECT, createdBy: ACTOR, definitionKey: definition.key, selection: { strategy: 'random', sampleSize: 1 } },
      deps,
    );
    expect(randomRun.aggregate?.total).toBe(1);

    // explicit keys → exactly those.
    const keysRun = await runDefinition(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: PROJECT, createdBy: ACTOR, definitionKey: definition.key, selection: { strategy: 'keys', conversationKeys: ['sel-3'] } },
      deps,
    );
    expect(keysRun.aggregate?.total).toBe(1);
    expect(keysRun.items[0].conversationKey).toBe('sel-3');

    // all → the whole project corpus (store mode off, so all 4 remain unanalyzed too).
    const allRun = await runDefinition(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: PROJECT, createdBy: ACTOR, definitionKey: definition.key, selection: { strategy: 'all' } },
      deps,
    );
    expect(allRun.aggregate?.total).toBe(4);
  });

  it('persists a cron schedule and fires it via runScheduledAnalyses', async () => {
    const definition = await createDefinition(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Nightly Scheduled',
      fieldSet: [{ key: 'intent', type: 'string' }],
      modes: {},
      extractionModelKey: 'extract-model',
      schedule: { cron: '* * * * *', enabled: true },
    });
    expect(definition.schedule?.enabled).toBe(true); // round-trips through SQLite

    const result = await runScheduledAnalyses(TENANT_DB_NAME, TENANT_ID, new Date(), {
      buildModelInvoker: fakeBuildModelInvoker,
    });
    expect(result.fired).toContain(definition.key);

    const runs = await listRuns(TENANT_DB_NAME, { definitionKey: definition.key });
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe('completed');
  });
});

// ── Decision layer ───────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createDecisionDefinition(input: Parameters<typeof createDefinition>[3]) {
  return createDefinition(TENANT_DB_NAME, TENANT_ID, ACTOR, input);
}

describe('Analysis decision layer — imported conversations (SQLite)', () => {
  const PROJECT = 'dec-test';
  const base = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: PROJECT, createdBy: ACTOR };
  const deps = {
    buildModelInvoker: () => fakeSummaryInvoker(),
    buildDecisionInvoker: fakeBuildDecisionInvoker,
  };
  let definitionKey = '';
  let definitionId = '';

  beforeAll(async () => {
    const definition = await createDecisionDefinition({
      name: 'Decision Intent',
      fieldSet: [
        { key: 'intent', type: 'enum', enumValues: ['billing', 'support'], required: true },
        { key: 'resolved', type: 'boolean' },
        { key: 'tone', type: 'score', levels: ['poor', 'ok', 'great'] },
        { key: 'summary', type: 'string' },
      ],
      modes: { accuracy: true },
      extractionModelKey: 'extract-model',
      decisionModelKey: 'decide-model',
      review: { threshold: 0.7 },
      projectId: PROJECT,
    });
    definitionKey = definition.key;
    definitionId = definition.id;
    await ingestConversations(
      TENANT_DB_NAME,
      TENANT_ID,
      ACTOR,
      [
        { key: 'd-1', name: 'Sure billing', transcript: [{ role: 'caller', content: 'BILLING RESOLVED thanks' }] },
        { key: 'd-2', name: 'Unsure call', transcript: [{ role: 'caller', content: 'UNSURE what this is about' }] },
        { key: 'd-3', name: 'Broken call', transcript: [{ role: 'caller', content: 'EXPLODE' }] },
      ],
      PROJECT,
    );
  });

  it('answers decision fields with the decision model, flags low confidence and writes results', async () => {
    const run = await runDefinition({ ...base, definitionKey, selection: { strategy: 'all' } }, deps);

    expect(run.status).toBe('completed');
    expect(run.aggregate?.total).toBe(3);
    // A failing decision call is an item error, never a failed run.
    expect(run.aggregate?.failed).toBe(1);
    const broken = run.items.find((i) => i.conversationKey === 'd-3');
    expect(broken?.error).toMatch(/decision backend down/);
    expect(run.aggregate?.needsReview).toBe(1);
    expect(run.aggregate?.decisions?.intent.answered).toBe(2);
    expect(run.aggregate?.decisions?.intent.counts).toEqual({ billing: 1, support: 1 });
    expect(run.aggregate?.decisions?.resolved.counts).toEqual({ yes: 1, no: 1 });

    // Run items stay small (no probabilities) and point at their result row.
    const sure = run.items.find((i) => i.conversationKey === 'd-1')!;
    expect(sure.extractedFields.intent).toBe('billing');
    expect(sure.extractedFields.tone).toBe('ok');
    expect(sure.extractedFields.summary).toBe('short');
    expect(sure.decisions?.intent.answer).toBe('billing');
    expect(sure.decisions?.intent).not.toHaveProperty('probabilities');
    expect(sure.needsReview).toBeUndefined();

    // Only analyzed conversations get a result row; the errored one keeps none.
    const { results, total } = await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey });
    expect(total).toBe(2);
    const row1 = results.find((r) => r.sourceId === 'd-1')!;
    expect(row1.sourceKind).toBe('conversation');
    expect(row1.title).toBe('Sure billing');
    expect(row1.needsReview).toBe(false);
    expect(row1.minConfidence).toBeCloseTo(0.7, 5); // the score answer is the least sure
    expect(row1.decisions.intent.probabilities?.billing).toBeCloseTo(0.95, 5);
    expect(row1.rationale).toBe('because');
    expect(sure.resultId).toBe(row1.id);

    const row2 = results.find((r) => r.sourceId === 'd-2')!;
    expect(row2.needsReview).toBe(true);
    expect(row2.reviewReason).toBe('low_confidence');
    expect(row2.decisions.intent.needsReview).toBe(true);
    expect(row2.minConfidence).toBeCloseTo(0.5, 5);

    // The review queue: flagged only, least confident first.
    const queue = await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey, needsReview: true, sort: 'confidence' });
    expect(queue.results.map((r) => r.sourceId)).toEqual(['d-2']);
  });

  it('shows a result with its source, and rejects bad reviews', async () => {
    const { results } = await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey });
    const row = results.find((r) => r.sourceId === 'd-2')!;

    const detail = await getResultDetail(TENANT_DB_NAME, { projectId: PROJECT, id: row.id });
    expect(detail?.definition.key).toBe(definitionKey);
    expect(detail?.definition.decisionModelKey).toBe('decide-model');
    expect(detail?.source.available).toBe(true);
    expect(detail?.source.title).toBe('Unsure call');
    expect(detail?.source.transcript[0].content).toContain('UNSURE');
    expect(detail?.source.href).toMatch(/^\/dashboard\/analysis\/conversations\//);
    // Another project cannot read it.
    expect(await getResultDetail(TENANT_DB_NAME, { projectId: 'other-project', id: row.id })).toBeNull();

    const review = (values: Record<string, unknown>) =>
      saveResultReview(TENANT_DB_NAME, { projectId: PROJECT, id: row.id, userId: 'reviewer', values });
    await expect(review({ intent: 'refund' })).rejects.toBeInstanceOf(AnalysisReviewError);
    await expect(review({ resolved: 'maybe' })).rejects.toThrow(/yes or no/);
    await expect(review({ tone: 'meh' })).rejects.toThrow(/one of/);
    await expect(review({ summary: 'x' })).rejects.toThrow(/Unknown question/);
    expect(await saveResultReview(TENANT_DB_NAME, { projectId: PROJECT, id: 'missing-id', userId: 'r', values: {} })).toBeNull();
  });

  it('keeps a review across re-runs, scores accuracy against it and feeds calibration', async () => {
    const { results } = await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey });
    const row = results.find((r) => r.sourceId === 'd-2')!;

    // Correct the choice; the other questions are confirmed as the model answered them.
    const reviewed = await saveResultReview(TENANT_DB_NAME, {
      projectId: PROJECT,
      id: row.id,
      userId: 'reviewer',
      values: { intent: 'billing', resolved: 'no' },
    });
    expect(reviewed?.needsReview).toBe(false);
    expect(reviewed?.review?.by).toBe('reviewer');
    expect(reviewed?.review?.values).toEqual({ intent: 'billing', resolved: false, tone: 'ok' });

    const rerun = await runDefinition(
      { ...base, definitionKey, selection: { strategy: 'keys', conversationKeys: ['d-2'] } },
      deps,
    );
    const item = rerun.items[0];
    // The model is still unsure, but the standing human review answers it: not flagged, and not counted.
    expect(item.needsReview).toBeUndefined();
    expect(rerun.aggregate?.needsReview).toBe(0);
    expect(item.accuracy?.perField.intent.match).toBe(false); // the reviewed answer is the reference
    expect(item.accuracy?.perField.resolved.match).toBe(true);

    const again = await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey });
    const after = again.results.find((r) => r.sourceId === 'd-2')!;
    expect(after.review?.values.intent).toBe('billing'); // ... but the review stays
    expect(after.needsReview).toBe(false);
    expect(after.runId).toBe(rerun.id);

    const calibration = await getCalibration(TENANT_DB_NAME, { projectId: PROJECT, definitionId });
    expect(calibration?.definitionKey).toBe(definitionKey);
    expect(calibration?.reviewed).toBe(1);
    const intent = calibration?.questions.find((q) => q.key === 'intent');
    expect(intent?.reviewed).toBe(1);
    expect(intent?.accuracy).toBe(0); // the model said support, the human said billing
    expect(calibration?.questions.find((q) => q.key === 'resolved')?.accuracy).toBe(1);
    expect(calibration?.questions.map((q) => q.key)).toEqual(['intent', 'resolved', 'tone']);
    expect(await getCalibration(TENANT_DB_NAME, { projectId: 'other-project', definitionId })).toBeNull();
  });

  it("selects with 'changed': only conversations without a result", async () => {
    const run = await runDefinition({ ...base, definitionKey, selection: { strategy: 'changed' } }, deps);
    expect(run.aggregate?.total).toBe(1);
    expect(run.items[0].conversationKey).toBe('d-3'); // the one that never produced a result
  });

  it('estimates a run from its selection', async () => {
    const estimate = await estimateRun({ ...base, definitionKey, selection: { strategy: 'all' } });
    expect(estimate.conversations).toBe(3);
    expect(estimate.sampled).toBe(3);
    expect(estimate.inputTokens).toBeGreaterThan(0);
    // decision: 15 * (2 + 2 + 3 options) + 120 = 225; extraction: 30 * 1 text field; per conversation.
    expect(estimate.outputTokens).toBe(3 * (225 + 30));
    // No price on record for these model keys: the total is unknown, not zero.
    expect(estimate.cost.total).toBeNull();
    expect(estimate.cost.currency).toBe('USD');
    await expect(estimateRun({ ...base, definitionKey: 'nope' })).rejects.toThrow(/not found/);
  });

  it('removes a definition together with its results', async () => {
    const throwaway = await createDecisionDefinition({
      name: 'Throwaway Decisions',
      fieldSet: [{ key: 'intent', type: 'enum', enumValues: ['billing', 'support'] }],
      modes: {},
      decisionModelKey: 'decide-model',
      projectId: PROJECT,
    });
    await runDefinition(
      { ...base, definitionKey: throwaway.key, selection: { strategy: 'keys', conversationKeys: ['d-1'] } },
      deps,
    );
    expect((await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey: throwaway.key })).total).toBe(1);
    expect(await deleteDefinition(TENANT_DB_NAME, throwaway.id)).toBe(true);
    expect((await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey: throwaway.key })).total).toBe(0);
    // The other definition's results are untouched.
    expect((await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey })).total).toBeGreaterThan(0);
  });

  it('keeps definitions without a decision model as they were, and still records their results', async () => {
    const { results } = await listResults(TENANT_DB_NAME, { projectId: '', definitionKey: 'call-intent-analysis' });
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const row of results) {
      expect(row.decisions).toEqual({});
      expect(row.needsReview).toBe(false);
      expect(row.minConfidence).toBe(1);
      expect(row.extractedFields.intent).toBeTruthy();
    }
    const run = (await listRuns(TENANT_DB_NAME, { definitionKey: 'call-intent-analysis' }))[0];
    expect(run.aggregate?.decisions).toBeUndefined();
    expect(run.items.every((i) => i.decisions === undefined)).toBe(true);
  });
});

describe('Analysis decision layer — agent sessions (SQLite)', () => {
  const PROJECT = 'as-test';
  const AGENT = 'support-bot';
  const base = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: PROJECT, createdBy: ACTOR };
  // A decision-only definition never needs an extraction model.
  const deps = {
    buildModelInvoker: () => {
      throw new Error('no extraction model expected');
    },
    buildDecisionInvoker: fakeBuildDecisionInvoker,
  };
  const ids: Record<string, string> = {};
  let definitionKey = '';
  let agentId = '';

  async function mkSession(
    name: string,
    texts: string[],
    options: { agentKey?: string; source?: string; runtimeStatus?: 'running'; createdBy?: string } = {},
  ): Promise<void> {
    const db = await getDatabase();
    const t = Date.now();
    const conv = await db.createAgentConversation({
      tenantId: TENANT_ID,
      projectId: PROJECT,
      agentKey: options.agentKey ?? AGENT,
      title: name,
      messages: texts.map((content, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content,
        timestamp: new Date(t + i),
      })),
      metadata: options.source ? { source: options.source } : {},
      createdBy: options.createdBy ?? 'user-1',
      ...(options.runtimeStatus ? { runtimeStatus: options.runtimeStatus } : {}),
    });
    ids[name] = String(conv._id);
  }

  beforeAll(async () => {
    const db = await getDatabase();
    const agent = await db.createAgent({
      tenantId: TENANT_ID,
      projectId: PROJECT,
      key: AGENT,
      name: 'Support bot',
      config: {},
      status: 'draft',
      createdBy: ACTOR,
    } as never);
    agentId = String(agent._id);

    const definition = await createDecisionDefinition({
      name: 'Session Quality',
      fieldSet: [
        { key: 'intent', type: 'enum', enumValues: ['billing', 'support'], required: true },
        { key: 'resolved', type: 'boolean' },
      ],
      modes: {},
      decisionModelKey: 'decide-model',
      source: { kind: 'agent_sessions', agentKeys: [AGENT], minMessages: 2, idleMinutes: 0, days: 7 },
      projectId: PROJECT,
    });
    definitionKey = definition.key;

    await mkSession('s1', ['I need BILLING help', 'Sure, done. RESOLVED']);
    await mkSession('s2', ['UNSURE question', 'Let me check', 'ok']);
    await mkSession('s3', ['hi']); // too short
    await mkSession('s4', ['BILLING', 'ok'], { source: 'evaluation' }); // synthetic traffic
    await mkSession('s5', ['BILLING', 'ok'], { runtimeStatus: 'running' }); // mid-turn
    await mkSession('s6', ['BILLING', 'ok'], { agentKey: 'other-bot' }); // not this definition's agent
    await sleep(15);
  });

  it("analyzes new sessions only ('changed'), then skips unchanged ones", async () => {
    const run = await runDefinition({ ...base, definitionKey }, deps);
    expect(run.status).toBe('completed');
    expect(run.target?.kind).toBe('agent_sessions');
    expect(run.aggregate?.total).toBe(2); // s1 and s2: s3 short, s4 synthetic, s5 running, s6 other agent
    expect(run.items.map((i) => i.conversationKey).sort()).toEqual([ids.s1, ids.s2].sort());
    expect(run.aggregate?.needsReview).toBe(1); // s2 is unsure

    const { results } = await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey });
    expect(results).toHaveLength(2);
    const r1 = results.find((r) => r.sourceId === ids.s1)!;
    expect(r1.sourceKind).toBe('agent_session');
    expect(r1.agentKey).toBe(AGENT);
    expect(r1.ownerId).toBe('user-1');
    expect(r1.title).toBe('s1');
    expect(r1.sourceVersion?.messageCount).toBe(2);
    expect(r1.decisions.intent.answer).toBe('billing');
    expect(r1.decisions.resolved.answer).toBe(true);

    await expect(runDefinition({ ...base, definitionKey }, deps)).rejects.toThrow(/no conversations/i);
  });

  it('waits for the idle window before touching a session', async () => {
    const strict = await createDecisionDefinition({
      name: 'Session Quality Idle',
      fieldSet: [{ key: 'intent', type: 'enum', enumValues: ['billing', 'support'] }],
      modes: {},
      decisionModelKey: 'decide-model',
      source: { kind: 'agent_sessions', agentKeys: [AGENT], idleMinutes: 30 },
      projectId: PROJECT,
    });
    await expect(runDefinition({ ...base, definitionKey: strict.key }, deps)).rejects.toThrow(/no conversations/i);
    // A definition of the corpus cannot be pointed at sessions.
    const corpus = await createDefinition(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Corpus Only',
      fieldSet: [{ key: 'intent', type: 'string' }],
      modes: {},
      extractionModelKey: 'x',
      projectId: PROJECT,
    });
    await expect(
      runDefinition({ ...base, definitionKey: corpus.key, target: { kind: 'agent_sessions' } }, deps),
    ).rejects.toThrow(/does not analyze agent sessions/);
  });

  it('lists sessions with their analysis state and pages with a cursor', async () => {
    const all = await listAgentSessionRows(TENANT_DB_NAME, { projectId: PROJECT, definitionKey });
    // s4 (evaluation) and s6 (other agent) are not offered; s3 and s5 are, unanalyzed.
    expect(all.rows.map((r) => r.id).sort()).toEqual([ids.s1, ids.s2, ids.s3, ids.s5].sort());
    expect(all.nextCursor).toBeUndefined();
    const s2 = all.rows.find((r) => r.id === ids.s2)!;
    expect(s2.messageCount).toBe(3);
    expect(s2.origin).toBeNull();
    expect(s2.result?.needsReview).toBe(true);
    expect(s2.result?.stale).toBe(false);
    expect(s2.result?.decisions.intent).not.toHaveProperty('probabilities');
    expect(all.rows.find((r) => r.id === ids.s3)?.result).toBeNull();

    const first = await listAgentSessionRows(TENANT_DB_NAME, { projectId: PROJECT, definitionKey, limit: 3 });
    expect(first.rows).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();
    const second = await listAgentSessionRows(TENANT_DB_NAME, { projectId: PROJECT, definitionKey, limit: 3, cursor: first.nextCursor });
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect([...first.rows, ...second.rows].map((r) => r.id).sort()).toEqual([ids.s1, ids.s2, ids.s3, ids.s5].sort());

    await expect(listAgentSessionRows(TENANT_DB_NAME, { projectId: PROJECT, definitionKey, agentKey: 'other-bot' })).rejects.toThrow(/not analyzed/);
    await expect(listAgentSessionRows(TENANT_DB_NAME, { projectId: PROJECT, definitionKey: 'nope' })).rejects.toThrow(/not found/);
  });

  it('shows the session transcript and links it, honouring who may see the result', async () => {
    const { results } = await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey });
    const r2 = results.find((r) => r.sourceId === ids.s2)!;

    const detail = await getResultDetail(TENANT_DB_NAME, { projectId: PROJECT, id: r2.id });
    expect(detail?.source.kind).toBe('agent_session');
    expect(detail?.source.available).toBe(true);
    expect(detail?.source.agentKey).toBe(AGENT);
    expect(detail?.source.messageCount).toBe(3);
    expect(detail?.source.transcript.map((m) => m.content)).toEqual(['UNSURE question', 'Let me check', 'ok']);
    expect(detail?.source.href).toBe(`/dashboard/agents/${agentId}/sessions/${ids.s2}`);

    const stranger = { userId: 'someone-else', agentKeys: [] as string[] };
    expect((await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey, viewer: stranger })).total).toBe(0);
    expect(await getResultDetail(TENANT_DB_NAME, { projectId: PROJECT, id: r2.id, viewer: stranger })).toBeNull();
    expect(
      await saveResultReview(TENANT_DB_NAME, { projectId: PROJECT, id: r2.id, userId: 'someone-else', values: {}, viewer: stranger }),
    ).toBeNull();
    // The session's starter and a viewer of the agent both see it.
    const owner = { userId: 'user-1', agentKeys: [] as string[] };
    expect((await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey, viewer: owner })).total).toBe(2);
    const agentViewer = { userId: 'someone-else', agentKeys: [AGENT] };
    expect((await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey, viewer: agentViewer })).total).toBe(2);
    expect(await getResultDetail(TENANT_DB_NAME, { projectId: PROJECT, id: r2.id, viewer: agentViewer })).not.toBeNull();
  });

  it('re-analyzes a changed session and drops its stale review, keeping reviews of unchanged ones', async () => {
    const db = await getDatabase();
    const { results } = await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey });
    const r1 = results.find((r) => r.sourceId === ids.s1)!;
    const r2 = results.find((r) => r.sourceId === ids.s2)!;
    for (const row of [r1, r2]) {
      await saveResultReview(TENANT_DB_NAME, { projectId: PROJECT, id: row.id, userId: 'reviewer', values: {} });
    }

    // s1 grows; s2 is left alone.
    const conv = await db.findAgentConversationById(ids.s1);
    await sleep(5);
    await db.updateAgentConversation(ids.s1, {
      messages: [
        ...conv!.messages,
        { role: 'user', content: 'one more thing', timestamp: new Date() },
        { role: 'assistant', content: 'yes?', timestamp: new Date() },
      ],
    });
    await sleep(15);

    const rows = await listAgentSessionRows(TENANT_DB_NAME, { projectId: PROJECT, definitionKey });
    expect(rows.rows.find((r) => r.id === ids.s1)?.result?.stale).toBe(true);
    expect(rows.rows.find((r) => r.id === ids.s2)?.result?.stale).toBe(false);

    const run = await runDefinition({ ...base, definitionKey }, deps);
    expect(run.aggregate?.total).toBe(1);
    expect(run.items[0].conversationKey).toBe(ids.s1);

    const after = (await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey })).results;
    const a1 = after.find((r) => r.sourceId === ids.s1)!;
    expect(a1.sourceVersion?.messageCount).toBe(4);
    expect(a1.review).toBeNull(); // the session changed: the old review no longer describes it
    const a2 = after.find((r) => r.sourceId === ids.s2)!;
    expect(a2.review?.by).toBe('reviewer');

    // An explicit selection of an unchanged session re-runs it and keeps its review;
    // sessions of other agents and synthetic traffic are dropped from the selection.
    const keys = await runDefinition(
      { ...base, definitionKey, selection: { strategy: 'keys', conversationKeys: [ids.s2, ids.s4, ids.s6] } },
      deps,
    );
    expect(keys.items.map((i) => i.conversationKey)).toEqual([ids.s2]);
    const kept = (await listResults(TENANT_DB_NAME, { projectId: PROJECT, definitionKey })).results.find((r) => r.sourceId === ids.s2)!;
    expect(kept.review?.by).toBe('reviewer');
    expect(kept.needsReview).toBe(false);

    await expect(
      runDefinition({ ...base, definitionKey, selection: { strategy: 'keys', conversationKeys: [ids.s4, ids.s6] } }, deps),
    ).rejects.toThrow(/no conversations/i);
  });

  it('estimates and samples agent-session runs', async () => {
    const estimate = await estimateRun({ ...base, definitionKey, selection: { strategy: 'all' } });
    expect(estimate.conversations).toBe(2);
    expect(estimate.sampled).toBe(2);
    expect(estimate.avgChars).toBeGreaterThan(0);
    expect(estimate.outputTokens).toBe(2 * (15 * 4 + 120)); // intent (2) + resolved (2) options, no extraction

    const random = await runDefinition({ ...base, definitionKey, selection: { strategy: 'random', sampleSize: 1 } }, deps);
    expect(random.aggregate?.total).toBe(1);
    const all = await runDefinition({ ...base, definitionKey, selection: { strategy: 'all' } }, deps);
    expect(all.aggregate?.total).toBe(2);
  });

  it('schedules agent-session definitions on new sessions only, without erroring when there are none', async () => {
    const scheduled = await createDecisionDefinition({
      name: 'Scheduled Sessions',
      fieldSet: [{ key: 'intent', type: 'enum', enumValues: ['billing', 'support'] }],
      modes: {},
      decisionModelKey: 'decide-model',
      source: { kind: 'agent_sessions', agentKeys: ['sched-bot'], idleMinutes: 0 },
      schedule: { cron: '* * * * *', enabled: true },
      projectId: PROJECT,
    });
    // Nothing to analyze yet: neither fired nor an error.
    const now = new Date();
    const empty = await runScheduledAnalyses(TENANT_DB_NAME, TENANT_ID, now, deps);
    expect(empty.fired).not.toContain(scheduled.key);
    expect(empty.errors.filter((e) => e.startsWith(scheduled.key))).toEqual([]);

    await mkSession('sched-1', ['BILLING', 'ok'], { agentKey: 'sched-bot' });
    await sleep(15);
    // The empty slot counted as fired: a new session waits for the next slot.
    const sameSlot = await runScheduledAnalyses(TENANT_DB_NAME, TENANT_ID, now, deps);
    expect(sameSlot.fired).not.toContain(scheduled.key);
    const later = new Date(Date.now() + 10 * 60 * 1000);
    const fired = await runScheduledAnalyses(TENANT_DB_NAME, TENANT_ID, later, deps);
    expect(fired.fired).toContain(scheduled.key);
    const runs = await listRuns(TENANT_DB_NAME, { definitionKey: scheduled.key });
    expect(runs[0].target?.kind).toBe('agent_sessions');
    expect(runs[0].aggregate?.total).toBe(1);
  });
});
