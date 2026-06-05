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
import type { AnalysisMessage, ModelInvoker } from '@/lib/services/analysis/types';

const TENANT_DB_NAME = 'analysis_e2e_tenant';
const TENANT_ID = 'tenant-analysis-e2e';
const ACTOR = 'tester@example.com';

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
