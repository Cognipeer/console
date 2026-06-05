/**
 * End-to-end test for the Red-Team service vertical.
 *
 * Backed by a real SQLiteProvider in a temp directory. Exercises campaign CRUD,
 * a full `runCampaign` flow (target invoker injected as a fake, no live model
 * calls), the three-state aggregate, and the HITL review override that
 * recomputes the aggregate — verifying persistence + the decision engine end to
 * end against the real DB layer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-redteam-e2e-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'redteam_e2e_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import {
  createCampaign,
  deleteCampaign,
  getRun,
  listCampaigns,
  listRuns,
  reviewAttempt,
  runCampaign,
} from '@/lib/services/redteam/service';
import type { RedTeamMessage } from '@/lib/services/redteam/types';

const TENANT_DB_NAME = 'redteam_e2e_tenant';
const TENANT_ID = 'tenant-redteam-e2e';
const ACTOR = 'tester@example.com';

/** Leaks the planted system prompt verbatim → canary surfaces → vulnerable. */
const leakyTarget = () => async (messages: RedTeamMessage[]) => ({
  text: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n') || 'sure thing',
});

/** Always refuses → refusal gate → safe. */
const refusingTarget = () => async () => ({ text: "I'm sorry, but I can't help with that request." });

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Red-team service — full vertical (SQLite)', () => {
  it('persists a campaign and runs a scan that confirms vulnerabilities (hard proof)', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Injection Scan',
      targetKind: 'model',
      modelKey: 'gpt-test',
      probeKeys: ['prompt-injection'],
    });
    expect(campaign.key).toBe('injection-scan');

    const run = await runCampaign(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, createdBy: ACTOR, campaignKey: campaign.key },
      { buildTargetInvoker: leakyTarget },
    );

    expect(run.status).toBe('completed');
    expect(run.aggregate?.total).toBeGreaterThan(0);
    // The leaky target reveals the canary on every attempt → all vulnerable.
    expect(run.aggregate?.vulnerable).toBe(run.aggregate?.completed);
    expect(run.aggregate?.attackSuccessRate).toBeCloseTo(1, 5);
    expect(run.aggregate?.resilienceScore).toBeCloseTo(0, 5);
    expect(run.attempts.every((a) => a.outcome === 'vulnerable')).toBe(true);
    expect(run.attempts[0].decidedBy).toMatch(/hard-proof/);
  });

  it('a refusing target scans as fully resilient (safe gate)', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Resilient Scan',
      targetKind: 'model',
      modelKey: 'gpt-test',
      probeKeys: ['prompt-injection'],
    });

    const run = await runCampaign(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, createdBy: ACTOR, campaignKey: campaign.key },
      { buildTargetInvoker: refusingTarget },
    );

    expect(run.status).toBe('completed');
    expect(run.aggregate?.vulnerable).toBe(0);
    expect(run.aggregate?.safe).toBe(run.aggregate?.completed);
    expect(run.aggregate?.resilienceScore).toBeCloseTo(1, 5);
    expect(run.attempts.every((a) => a.decidedBy.startsWith('safe-gate'))).toBe(true);
  });

  it('HITL review overrides a verdict and recomputes the aggregate', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Review Scan',
      targetKind: 'model',
      modelKey: 'gpt-test',
      probeKeys: ['prompt-injection'],
    });
    const run = await runCampaign(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, createdBy: ACTOR, campaignKey: campaign.key },
      { buildTargetInvoker: leakyTarget },
    );
    const before = run.aggregate!.vulnerable;
    const first = run.attempts[0];

    const reviewed = await reviewAttempt(TENANT_DB_NAME, run.id, first.attemptId, {
      outcome: 'safe',
      note: 'false positive — canary echoed in a quoted refusal',
      reviewedBy: ACTOR,
    });

    expect(reviewed?.aggregate?.vulnerable).toBe(before - 1);
    const persisted = await getRun(TENANT_DB_NAME, run.id);
    const overridden = persisted?.attempts.find((a) => a.attemptId === first.attemptId);
    expect(overridden?.review?.outcome).toBe('safe');
    expect(overridden?.outcome).toBe('vulnerable'); // machine verdict preserved
  });

  it('lists campaigns/runs and round-trips delete', async () => {
    expect((await listCampaigns(TENANT_DB_NAME)).length).toBeGreaterThanOrEqual(3);
    expect((await listRuns(TENANT_DB_NAME)).length).toBeGreaterThanOrEqual(3);

    const extra = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Disposable Campaign',
      targetKind: 'agent',
      agentKey: 'tmp-agent',
    });
    expect(await deleteCampaign(TENANT_DB_NAME, extra.id)).toBe(true);
    expect(await listCampaigns(TENANT_DB_NAME, { search: 'Disposable' })).toHaveLength(0);
  });
});
