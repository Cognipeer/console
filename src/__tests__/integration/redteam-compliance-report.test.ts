/**
 * End-to-end test for the EU AI Act compliance report vertical.
 *
 * Backed by a real SQLiteProvider. Creates a campaign carrying compliance
 * metadata, runs two scans (a leaky/vulnerable target and a refusing/resilient
 * one), then builds the compliance report and asserts it surfaces the declared
 * classification, per-EU-category posture, evidence samples, findings, and
 * coverage gaps — i.e. the full evidence chain an auditor would read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-redteam-compliance-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'redteam_compliance_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import {
  completedInBucket,
  createCampaign,
  getCampaign,
  getOverview,
  normalizeRunLimit,
  updateCampaign,
  runCampaign,
} from '@/lib/services/redteam/service';
import { buildComplianceReport } from '@/lib/services/redteam/compliance/report';
import type { RedTeamMessage } from '@/lib/services/redteam/types';
import { noteRestrictedKnowledge } from '@/lib/services/rag/access/exposure';
import { OWASP_LLM_CATEGORIES } from '@/lib/services/redteam/owasp';

const TENANT_DB_NAME = 'redteam_compliance_tenant';
const TENANT_ID = 'tenant-compliance';
const ACTOR = 'auditor@example.com';

const leakyTarget = () => async (messages: RedTeamMessage[]) => ({
  text: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n') || 'sure thing',
});
const refusingTarget = () => async () => ({ text: "I'm sorry, but I can't help with that request." });
/** The target never answers: every attempt fails, so the scan has nothing to say. */
const downTarget = () => async (): Promise<{ text: string }> => {
  throw new Error('connection refused');
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

describe('EU AI Act compliance report — full vertical (SQLite)', () => {
  it('builds a report with classification, EU posture, evidence, and findings', async () => {
    // A vulnerable campaign (system-prompt leakage) with declared classification.
    const leaky = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Support Bot Leak Scan',
      targetKind: 'model',
      modelKey: 'gpt-support',
      probeKeys: ['system-prompt-leakage'],
      compliance: {
        riskTier: 'high-risk',
        intendedPurpose: 'Customer support chatbot for retail banking',
        deployer: 'Northwind Bank',
        systemCardUrl: 'https://example.com/system-card',
      },
    });
    // Compliance metadata round-trips through persistence.
    const reloaded = await getCampaign(TENANT_DB_NAME, leaky.id);
    expect((reloaded?.metadata?.compliance as { riskTier?: string })?.riskTier).toBe('high-risk');

    await runCampaign(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, createdBy: ACTOR, campaignKey: leaky.key },
      { buildTargetInvoker: leakyTarget },
    );

    // A resilient campaign covering a different family (jailbreak → manipulation).
    const safe = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Jailbreak Regression',
      targetKind: 'model',
      modelKey: 'gpt-support',
      probeKeys: ['jailbreak'],
    });
    await runCampaign(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, createdBy: ACTOR, campaignKey: safe.key },
      { buildTargetInvoker: refusingTarget },
    );

    const report = await buildComplianceReport(TENANT_DB_NAME, new Date('2026-07-19T00:00:00Z'));

    // Header reflects the declared classification and both targets/campaigns.
    expect(report.system.riskTier).toBe('high-risk');
    expect(report.system.deployer).toBe('Northwind Bank');
    expect(report.system.campaigns).toEqual(expect.arrayContaining(['support-bot-leak-scan', 'jailbreak-regression']));
    expect(report.scope.runsConsidered).toBe(2);

    // Posture aggregates both scans; the leaky scan drove vulnerabilities.
    expect(report.posture.totalAttempts).toBeGreaterThan(0);
    expect(report.posture.vulnerable).toBeGreaterThan(0);

    // The leaky system-prompt scan folds onto sensitive-data-disclosure and
    // carries evidence samples with real input/output.
    const sdd = report.byEuCategory.find((c) => c.category === 'sensitive-data-disclosure');
    expect(sdd).toBeDefined();
    expect(sdd!.vulnerable).toBeGreaterThan(0);
    expect(sdd!.articleRefs.length).toBeGreaterThan(0);
    expect(sdd!.evidence.length).toBeGreaterThan(0);
    expect(sdd!.evidence[0].input).toBeTruthy();
    expect(sdd!.evidence[0].output).toBeTruthy();

    // A distinct finding for the leaking probe, with a worst-first severity order.
    const finding = report.findings.find((f) => f.probeKey === 'system-prompt-leakage');
    expect(finding).toBeDefined();
    expect(finding!.euCategories).toContain('sensitive-data-disclosure');
    expect(finding!.example).toBeDefined();

    // Categories never scanned are honestly reported as coverage gaps, over the ten of the 2025 list.
    const gaps = report.coverageGaps.map((g) => g.owaspCategory);
    expect(gaps).toEqual(expect.arrayContaining(['LLM03-supply-chain', 'LLM10-unbounded-consumption']));
    expect(gaps).not.toContain('LLM01-prompt-injection');
    expect(gaps).not.toContain('LLM07-system-prompt-leakage');
    expect(gaps.every((g) => (OWASP_LLM_CATEGORIES as readonly string[]).includes(g))).toBe(true);
    expect(report.owaspReference.label).toBe('OWASP Top 10 for LLM Applications (2025)');
    expect(report.byOwaspCategory.every((c) => (OWASP_LLM_CATEGORIES as readonly string[]).includes(c.category))).toBe(true);
    expect(report.regulatoryBasis.length).toBeGreaterThan(0);
    expect(report.disclaimers.length).toBeGreaterThan(0);
  });

  it('marks an attempt whose answer drew on restricted knowledge base passages, and keeps its text out of the evidence', async () => {
    // The target is an agent that read a document not open to everyone while answering (what its knowledge tools
    // note on the work they run in): the attempt is marked, its finding still counts, its transcript is no evidence.
    const restrictedTarget = () => async (messages: RedTeamMessage[]) => {
      await noteRestrictedKnowledge(['proj-restricted:handbook']);
      return { text: messages.filter((m) => m.role === 'system').map((m) => `handbook says: ${m.content}`).join('\n') || 'sure thing' };
    };
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Restricted Leak Scan',
      targetKind: 'model',
      modelKey: 'gpt-support',
      probeKeys: ['system-prompt-leakage'],
      projectId: 'proj-restricted',
    });
    const run = await runCampaign(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: 'proj-restricted', createdBy: ACTOR, campaignKey: campaign.key },
      { buildTargetInvoker: restrictedTarget },
    );
    expect(run.attempts.length).toBeGreaterThan(0);
    for (const attempt of run.attempts) expect(attempt.kbRestricted).toEqual(['proj-restricted:handbook']);

    const report = await buildComplianceReport(TENANT_DB_NAME, new Date('2026-07-19T00:00:00Z'), { projectId: 'proj-restricted' });
    expect(report.scope.runsConsidered).toBe(1);
    expect(report.posture.vulnerable).toBeGreaterThan(0);
    const finding = report.findings.find((f) => f.probeKey === 'system-prompt-leakage');
    expect(finding).toBeDefined();
    expect(finding!.euCategories).toContain('sensitive-data-disclosure');
    expect(finding!.example).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('handbook says');
  });

  it('takes the latest scan of a campaign as its posture and counts older ones as history only', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'History Scan',
      targetKind: 'model',
      modelKey: 'gpt-support',
      probeKeys: ['system-prompt-leakage'],
      projectId: 'proj-history',
    });
    const params = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: 'proj-history', createdBy: ACTOR, campaignKey: campaign.key };
    // Older: leaks. Newer: holds. The report describes the system as it stands now.
    await runCampaign(params, { buildTargetInvoker: leakyTarget });
    const latest = await runCampaign(params, { buildTargetInvoker: refusingTarget });

    const report = await buildComplianceReport(TENANT_DB_NAME, new Date('2026-07-19T00:00:00Z'), { projectId: 'proj-history' });

    expect(report.scope.runsConsidered).toBe(1);
    expect(report.posture.totalAttempts).toBe(latest.aggregate?.total);
    expect(report.posture.vulnerable).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.history.runs).toBe(1);
    expect(report.history.byCampaign).toEqual([
      expect.objectContaining({ campaignKey: campaign.key, runs: 1, vulnerable: expect.any(Number) }),
    ]);
    expect(report.history.byCampaign[0].vulnerable).toBeGreaterThan(0);
    expect(report.inconclusiveRuns).toEqual([]);
  });

  it('leaves a scan whose rates cannot be trusted out of the posture, and lists it with its reasons', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Untrusted Scan',
      targetKind: 'model',
      modelKey: 'gpt-support',
      probeKeys: ['system-prompt-leakage'],
      projectId: 'proj-untrusted',
    });
    const params = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: 'proj-untrusted', createdBy: ACTOR, campaignKey: campaign.key };
    const trusted = await runCampaign(params, { buildTargetInvoker: refusingTarget });
    const untrusted = await runCampaign(params, { buildTargetInvoker: downTarget });
    expect(untrusted.aggregate?.inconclusive).toBe(true);
    expect(untrusted.aggregate?.attackSuccessRate).toBeNull();

    const report = await buildComplianceReport(TENANT_DB_NAME, new Date('2026-07-19T00:00:00Z'), { projectId: 'proj-untrusted' });

    // The newer scan is untrusted, so the older conclusive one stays the posture.
    expect(report.scope.runsConsidered).toBe(1);
    expect(report.posture.totalAttempts).toBe(trusted.aggregate?.total);
    expect(report.inconclusiveRuns).toEqual([
      expect.objectContaining({ runId: untrusted.id, campaignKey: campaign.key, reasons: expect.arrayContaining(['no-completed-attempts']) }),
    ]);
    expect(report.history.runs).toBe(0);
    expect(report.disclaimers.some((d) => /left out of the posture/.test(d))).toBe(true);
  });

  it('has a null rate, not a perfect score, when no scan can be trusted', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Only Down Scan',
      targetKind: 'model',
      modelKey: 'gpt-support',
      probeKeys: ['system-prompt-leakage'],
      projectId: 'proj-only-down',
    });
    await runCampaign(
      { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: 'proj-only-down', createdBy: ACTOR, campaignKey: campaign.key },
      { buildTargetInvoker: downTarget },
    );

    const report = await buildComplianceReport(TENANT_DB_NAME, new Date('2026-07-19T00:00:00Z'), { projectId: 'proj-only-down' });

    expect(report.scope.runsConsidered).toBe(0);
    expect(report.posture.attackSuccessRate).toBeNull();
    expect(report.posture.resilienceScore).toBeNull();
    expect(report.inconclusiveRuns).toHaveLength(1);
    expect(report.coverageGaps).toHaveLength(OWASP_LLM_CATEGORIES.length);
    expect(report.disclaimers[0]).toMatch(/No completed red-team scans were found/);
  });

  it('merges compliance metadata on update without dropping other metadata', async () => {
    const c = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Update Meta Scan',
      targetKind: 'model',
      modelKey: 'gpt-x',
      probeKeys: ['jailbreak'],
      compliance: { riskTier: 'gpai', provider: 'Acme AI' },
    });
    const updated = await updateCampaign(TENANT_DB_NAME, c.id, ACTOR, {
      compliance: { riskTier: 'gpai-systemic', provider: 'Acme AI', intendedPurpose: 'general assistant' },
    });
    const meta = updated?.metadata?.compliance as { riskTier?: string; intendedPurpose?: string };
    expect(meta.riskTier).toBe('gpai-systemic');
    expect(meta.intendedPurpose).toBe('general assistant');
  });

  it('returns an honest empty report when no scans exist for the scope', async () => {
    const report = await buildComplianceReport(TENANT_DB_NAME, new Date(), { projectId: 'nonexistent-project' });
    expect(report.scope.runsConsidered).toBe(0);
    expect(report.posture.totalAttempts).toBe(0);
    expect(report.disclaimers[0]).toMatch(/No completed red-team scans/i);
  });
});

describe('category completed counts', () => {
  it('counts a legacy bucket without failed as fully completed', () => {
    expect(completedInBucket({ total: 5 })).toBe(5);
    expect(completedInBucket({ total: 5, failed: 2 })).toBe(3);
    expect(completedInBucket({ total: 2, failed: 9 })).toBe(0);
  });

  it('treats a category whose attempts all failed as a coverage gap with no resilience', async () => {
    const PROJECT = 'proj-failed-category';
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    const bucket = (total: number, failed: number | undefined, vulnerable: number) => ({
      total, vulnerable, needsReview: 0, ...(failed === undefined ? {} : { failed }),
    });
    await db.createRedTeamRun({
      tenantId: TENANT_ID, projectId: PROJECT, campaignKey: 'failed-category', targetKind: 'model', targetRef: 'm',
      status: 'completed', mode: 'async', progress: { total: 4, completed: 4, failed: 2 }, attempts: [], createdBy: ACTOR,
      attemptStore: 'collection', finishedAt: new Date(),
      aggregate: {
        total: 4, completed: 2, failed: 2, vulnerable: 1, safe: 1, needsReview: 0,
        attackSuccessRate: 0.5, resilienceScore: 0.5,
        bySeverity: { low: 0, medium: 0, high: 1, critical: 0 },
        byCategory: {
          'LLM01-prompt-injection': bucket(2, 2, 0),
          'LLM02-sensitive-information-disclosure': bucket(2, undefined, 1),
        },
        avgLatencyMs: null,
      },
    } as never);

    const report = await buildComplianceReport(TENANT_DB_NAME, new Date('2026-07-19T00:00:00Z'), { projectId: PROJECT });
    expect(report.byOwaspCategory.map((c) => c.category)).toEqual(['LLM02-sensitive-information-disclosure']);
    expect(report.byOwaspCategory[0].resilience).toBe(0.5);
    expect(report.coverageGaps.map((g) => g.owaspCategory)).toContain('LLM01-prompt-injection');
    expect(report.coverageGaps.map((g) => g.owaspCategory)).not.toContain('LLM02-sensitive-information-disclosure');

    const overview = await getOverview(TENANT_DB_NAME, { projectId: PROJECT });
    expect(overview.byCategory.map((c) => c.category)).toEqual(['LLM02-sensitive-information-disclosure']);
  });
});

describe('run limit paging', () => {
  it('normalises a limit to a whole number in 1..500, else the default', () => {
    expect(normalizeRunLimit(undefined)).toBe(100);
    expect(normalizeRunLimit(Number.NaN)).toBe(100);
    expect(normalizeRunLimit(Number.POSITIVE_INFINITY)).toBe(100);
    expect(normalizeRunLimit(0)).toBe(100);
    expect(normalizeRunLimit(-3)).toBe(100);
    expect(normalizeRunLimit(7.9)).toBe(7);
    expect(normalizeRunLimit(500)).toBe(500);
    expect(normalizeRunLimit(10_000)).toBe(500);
  });
});
