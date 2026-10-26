/**
 * The EU compliance report is evidence about the system in service, so a scan
 * of an unpublished agent draft is left out (with a disclaimer), while a scan of
 * the published or a pinned version stays in and names the version that answered.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-redteam-compliance-revision-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'redteam_compliance_revision_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type IAgentConfig } from '@/lib/database';
import { createCampaign, runCampaign } from '@/lib/services/redteam/service';
import { buildComplianceReport } from '@/lib/services/redteam/compliance/report';
import type { AgentRevision } from '@/lib/database';

const TENANT_DB_NAME = 'redteam_compliance_revision_tenant';
const TENANT_ID = 'tenant-compliance-revision';
const PROJECT = 'proj-1';
const ACTOR = 'auditor@example.com';
const DRAFT_NOTE = /1 scan of an unpublished agent draft was excluded/;

const refusingTarget = () => async () => ({ text: "I'm sorry, but I can't help with that request." });
const config = { modelKey: 'm' } as unknown as IAgentConfig;
const base = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: PROJECT, createdBy: ACTOR };

async function scan(name: string, agentVersion?: AgentRevision) {
  const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
    name, targetKind: 'agent', agentKey: 'bot', probeKeys: ['jailbreak'], projectId: PROJECT,
  });
  return runCampaign(
    { ...base, campaignKey: campaign.key, ...(agentVersion !== undefined ? { options: { agentVersion } } : {}) },
    { buildTargetInvoker: refusingTarget },
  );
}

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);
  const agent = await db.createAgent({
    tenantId: TENANT_ID, projectId: PROJECT, key: 'bot', name: 'Bot', config, status: 'active', createdBy: ACTOR,
  });
  const agentId = String(agent._id);
  for (const version of [1, 2]) {
    await db.createAgentVersion({
      tenantId: TENANT_ID, projectId: PROJECT, agentId, agentKey: 'bot', version,
      snapshot: { name: 'Bot', config, status: 'active' }, publishedBy: ACTOR,
    } as never);
  }
  await db.updateAgent(agentId, { publishedVersion: 2, latestVersion: 2 });
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('compliance report and agent revisions', () => {
  it('keeps published and pinned scans, with the version that answered, and says nothing about drafts', async () => {
    const published = await scan('Published scan');
    const pinned = await scan('Pinned scan', 1);

    const report = await buildComplianceReport(TENANT_DB_NAME, new Date('2026-10-25T00:00:00Z'), { projectId: PROJECT });

    expect(report.scope.runsConsidered).toBe(2);
    expect(report.disclaimers.some((d) => /draft/.test(d))).toBe(false);
    const samples = report.byEuCategory.flatMap((c) => c.evidence);
    expect(samples.length).toBeGreaterThan(0);
    const versionOf = (runId: string) => new Set(samples.filter((s) => s.runId === runId).map((s) => s.agentVersion));
    expect(versionOf(published.id)).toEqual(new Set([2]));
    expect(versionOf(pinned.id)).toEqual(new Set([1]));
  });

  it('excludes a draft-requested scan from the evidence and adds a disclaimer', async () => {
    const draft = await scan('Draft scan', 'draft');
    expect(draft.agentRevision?.requested).toBe('draft');

    const report = await buildComplianceReport(TENANT_DB_NAME, new Date('2026-10-25T00:00:00Z'), { projectId: PROJECT });

    expect(report.scope.runsConsidered).toBe(2);
    expect(report.system.campaigns).not.toContain('draft-scan');
    expect(report.byEuCategory.flatMap((c) => c.evidence).every((s) => s.runId !== draft.id)).toBe(true);
    expect(report.disclaimers.some((d) => DRAFT_NOTE.test(d))).toBe(true);
  });

  it('reads past newer draft scans instead of letting them use up the limit', async () => {
    await scan('Draft scan 2', 'draft');
    await scan('Draft scan 3', 'draft');

    // The two newest pages of two are drafts only; the published and pinned scans sit behind them.
    const report = await buildComplianceReport(TENANT_DB_NAME, new Date('2026-10-25T00:00:00Z'), { projectId: PROJECT, limit: 2 });

    expect(report.scope.runsConsidered).toBe(2);
    expect(report.disclaimers.some((d) => /3 scans of an unpublished agent draft were excluded/.test(d))).toBe(true);
  });
});
