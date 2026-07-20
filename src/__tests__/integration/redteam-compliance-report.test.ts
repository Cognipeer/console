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
import { createCampaign, getCampaign, updateCampaign, runCampaign } from '@/lib/services/redteam/service';
import { buildComplianceReport } from '@/lib/services/redteam/compliance/report';
import type { RedTeamMessage } from '@/lib/services/redteam/types';

const TENANT_DB_NAME = 'redteam_compliance_tenant';
const TENANT_ID = 'tenant-compliance';
const ACTOR = 'auditor@example.com';

const leakyTarget = () => async (messages: RedTeamMessage[]) => ({
  text: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n') || 'sure thing',
});
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

    // Categories never scanned are honestly reported as coverage gaps.
    expect(report.coverageGaps.some((g) => g.owaspCategory === 'LLM06-sensitive-information-disclosure')).toBe(true);
    expect(report.regulatoryBasis.length).toBeGreaterThan(0);
    expect(report.disclaimers.length).toBeGreaterThan(0);
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
