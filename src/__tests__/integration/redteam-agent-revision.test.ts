/**
 * Red-team scans of an agent on a chosen revision (published / draft / a
 * version), over a real SQLite store. The target invoker is faked and records
 * the spec it was built with, which is what decides the config every attempt
 * of the scan hits. The queue is stubbed for the scheduler cases. Also the
 * caller check the routes hand to the service: it is asked before any run row
 * exists, and it never rides on the queued job.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const queue = vi.hoisted(() => ({ publish: vi.fn(async () => undefined) }));
vi.mock('@/lib/core/queue', () => ({
  getQueue: async () => queue,
}));

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-redteam-agent-revision-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'redteam_agent_revision_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type IAgentConfig } from '@/lib/database';
import { AgentRevisionError } from '@/lib/services/agents/agentRevision';
import {
  createAsyncRun,
  createCampaign,
  getCampaign,
  getRun,
  listRuns,
  runCampaign,
  updateCampaign,
  type RunCampaignDeps,
} from '@/lib/services/redteam/service';
import { enqueueCampaignRun, runScheduledScans } from '@/lib/services/redteam/campaignJob';
import type { RedTeamTargetSpec } from '@/lib/services/redteam/adapters';

const TENANT_DB_NAME = 'redteam_agent_revision_tenant';
const TENANT_ID = 'tenant-redteam-agent-revision';
const PROJECT = 'proj-1';
const ACTOR = 'tester@example.com';
const AGENT_KEY = 'support-bot';

const config = (prompt: string) => ({ modelKey: 'm', systemPrompt: prompt }) as unknown as IAgentConfig;

let agentId = '';

/** A target that always refuses; records the spec the scan built it with. */
function recordingDeps(onCall?: () => Promise<void>) {
  const specs: RedTeamTargetSpec[] = [];
  const deps: RunCampaignDeps = {
    buildTargetInvoker: (spec) => {
      specs.push(spec);
      return async () => {
        await onCall?.();
        return { text: "I'm sorry, but I can't help with that request." };
      };
    },
  };
  return { specs, deps };
}

const base = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: PROJECT, createdBy: ACTOR };
const campaignInput = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  targetKind: 'agent' as const,
  agentKey: AGENT_KEY,
  probeKeys: ['prompt-injection'],
  projectId: PROJECT,
  ...extra,
});

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);
  const agent = await db.createAgent({
    tenantId: TENANT_ID, projectId: PROJECT, key: AGENT_KEY, name: 'Support bot',
    config: config('draft prompt'), status: 'active', createdBy: ACTOR,
  });
  agentId = String(agent._id);
  for (const version of [1, 2]) {
    await db.createAgentVersion({
      tenantId: TENANT_ID, projectId: PROJECT, agentId, agentKey: AGENT_KEY, version,
      snapshot: { name: 'Support bot', config: config(`v${version} prompt`), status: 'active' }, publishedBy: ACTOR,
    } as never);
  }
  await db.updateAgent(agentId, { publishedVersion: 2, latestVersion: 2 });
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('red-team campaign default revision', () => {
  it('persists a pinned version and the draft, and nothing for published', async () => {
    const pinned = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Pinned', { agentVersion: 2 }));
    const draft = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Draft default', { agentVersion: 'draft' }));
    const published = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Follows published', { agentVersion: null }));
    const model = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'A model', targetKind: 'model', modelKey: 'm', agentVersion: 3, projectId: PROJECT,
    });

    expect(pinned.agentVersion).toBe(2);
    expect(draft.agentVersion).toBe('draft');
    expect(published.agentVersion ?? null).toBeNull();
    // Only an agent campaign has a revision.
    expect(model.agentVersion ?? null).toBeNull();
  });

  it('reads the default back from the store through edits', async () => {
    const created = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Edited', { agentVersion: 'draft' }));
    const stored = async () => (await getCampaign(TENANT_DB_NAME, created.id))?.agentVersion ?? null;

    expect(await stored()).toBe('draft');
    await updateCampaign(TENANT_DB_NAME, created.id, ACTOR, { agentVersion: 1 });
    expect(await stored()).toBe(1);
    // An edit that leaves the key out leaves the pin alone.
    await updateCampaign(TENANT_DB_NAME, created.id, ACTOR, { name: 'Edited again' });
    expect(await stored()).toBe(1);
    // `null` is how an edit goes back to following the published version.
    await updateCampaign(TENANT_DB_NAME, created.id, ACTOR, { agentVersion: null });
    expect(await stored()).toBeNull();
  });
});

describe('red-team scan revision', () => {
  it('pins a published-default campaign to the version published at the start', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Published run'));
    const { specs, deps } = recordingDeps();

    const run = await runCampaign({ ...base, campaignKey: campaign.key }, deps);

    expect(specs).toHaveLength(1);
    expect(specs[0].agentRun).toEqual({ version: 2 });
    expect(run.status).toBe('completed');
    expect(run.agentRevision).toEqual({ requested: 'published', agentKey: AGENT_KEY, version: 2 });
    expect((await getRun(TENANT_DB_NAME, run.id))?.agentRevision).toEqual({ requested: 'published', agentKey: AGENT_KEY, version: 2 });
  });

  it('runs a pinned-default campaign on that version even when another is published', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Pinned run', { agentVersion: 1 }));
    const { specs, deps } = recordingDeps();

    const run = await runCampaign({ ...base, campaignKey: campaign.key }, deps);

    expect(specs[0].agentRun).toEqual({ version: 1 });
    expect(run.agentRevision).toEqual({ requested: 1, agentKey: AGENT_KEY, version: 1 });
  });

  it('lets a run override the default with the draft', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Draft override'));
    const { specs, deps } = recordingDeps();

    const run = await runCampaign({ ...base, campaignKey: campaign.key, options: { agentVersion: 'draft' } }, deps);

    expect(specs[0].agentRun).toEqual({});
    expect(run.agentRevision?.requested).toBe('draft');
    expect(run.agentRevision?.version).toBeNull();
    expect(run.agentRevision?.draftFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(run.agentRevision?.draftChanged).toBeUndefined();
  });

  it('flags a draft that was saved while the scan was running', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Draft edited'));
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    let edited = false;
    const { deps } = recordingDeps(async () => {
      if (edited) return;
      edited = true;
      await db.updateAgent(agentId, { config: config('edited mid-scan') });
    });

    const run = await runCampaign({ ...base, campaignKey: campaign.key, options: { agentVersion: 'draft' } }, deps);

    expect(run.status).toBe('completed');
    expect(run.agentRevision?.draftChanged).toBe(true);
  });

  it('refuses a revision override on a model campaign without creating a run', async () => {
    const model = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Model override', targetKind: 'model', modelKey: 'm', probeKeys: ['prompt-injection'], projectId: PROJECT,
    });

    await expect(createAsyncRun({ ...base, campaignKey: model.key, options: { agentVersion: 'draft' } })).rejects.toBeInstanceOf(AgentRevisionError);
    expect(await listRuns(TENANT_DB_NAME, { projectId: PROJECT, campaignKey: model.key })).toEqual([]);
  });

  it('fails fast on a version that does not exist, without creating a run', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Missing version'));

    await expect(createAsyncRun({ ...base, campaignKey: campaign.key, options: { agentVersion: 9 } })).rejects.toThrow(/Version 9 not found/);
    expect(await listRuns(TENANT_DB_NAME, { projectId: PROJECT, campaignKey: campaign.key })).toEqual([]);
  });
});

describe('red-team concurrency guard per revision', () => {
  async function runningRun(campaignKey: string, agentRevision?: { requested: 'draft' | 'published' | number }, startedAt = new Date()) {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    return db.createRedTeamRun({
      tenantId: TENANT_ID, projectId: PROJECT, campaignKey, targetKind: 'agent', targetRef: AGENT_KEY,
      status: 'running', mode: 'async', startedAt, progress: { total: 1, completed: 0, failed: 0 }, attempts: [], createdBy: ACTOR,
      ...(agentRevision ? { agentRevision } : {}),
    });
  }

  it('lets a scan of another revision start, and blocks the same one', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Guarded'));
    await runningRun(campaign.key, { requested: 'draft' });

    const published = await createAsyncRun({ ...base, campaignKey: campaign.key });
    expect(published.run.agentRevision).toEqual({ requested: 'published', agentKey: AGENT_KEY });

    await expect(createAsyncRun({ ...base, campaignKey: campaign.key, options: { agentVersion: 'draft' } }))
      .rejects.toThrow(/already in progress on draft/);
  });

  it('blocks when the running scan recorded no revision', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Guarded legacy'));
    await runningRun(campaign.key);

    await expect(createAsyncRun({ ...base, campaignKey: campaign.key })).rejects.toThrow(/already in progress on published/);
  });

  it('ignores a scan that has been running for over an hour', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Guarded stale'));
    await runningRun(campaign.key, { requested: 'published' }, new Date(Date.now() - 2 * 60 * 60 * 1000));

    await expect(createAsyncRun({ ...base, campaignKey: campaign.key })).resolves.toBeDefined();
  });
});

describe('scheduled scans', () => {
  it('skips a due campaign that defaults to the draft and fires a due published one', async () => {
    queue.publish.mockClear();
    const schedule = { cron: '* * * * *', enabled: true };
    const draft = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Scheduled draft', { agentVersion: 'draft', schedule }));
    const published = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Scheduled published', { schedule }));

    const result = await runScheduledScans(TENANT_DB_NAME, TENANT_ID, new Date());

    expect(result.fired).toEqual([published.key]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(new RegExp(`^${draft.key}: .*draft`));
    expect(queue.publish).toHaveBeenCalledTimes(1);
    // The scheduler passes no override: the campaign's default decides.
    const payload = (queue.publish.mock.calls[0] as unknown as [string, string, { options?: unknown }])[2];
    expect(payload.options).toBeUndefined();
    expect(await listRuns(TENANT_DB_NAME, { projectId: PROJECT, campaignKey: draft.key })).toEqual([]);
  });
});

describe('a scan asks the caller before it creates anything', () => {
  const allow = () => vi.fn(async () => undefined);
  const refuse = () => vi.fn(async () => {
    throw new Error('not allowed');
  });
  const runsOf = (campaignKey: string) => listRuns(TENANT_DB_NAME, { projectId: PROJECT, campaignKey });

  it('asks once for an agent campaign and goes on when the answer is yes', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Asked yes'));
    const authorize = allow();

    const { run } = await createAsyncRun({ ...base, campaignKey: campaign.key, authorizeAgentRun: authorize });

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('pending');
  });

  it.each([undefined, 'published', 'draft', 1] as const)('writes no run row when the answer is no, asking for revision %j', async (agentVersion) => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput(`Asked no ${String(agentVersion)}`));

    await expect(
      createAsyncRun({ ...base, campaignKey: campaign.key, authorizeAgentRun: refuse(), ...(agentVersion !== undefined ? { options: { agentVersion } } : {}) }),
    ).rejects.toThrow('not allowed');

    expect(await runsOf(campaign.key)).toEqual([]);
  });

  it('writes no run row for a synchronous scan either', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Asked no sync'));
    const { specs, deps } = recordingDeps();

    await expect(runCampaign({ ...base, campaignKey: campaign.key, authorizeAgentRun: refuse() }, deps)).rejects.toThrow('not allowed');

    expect(await runsOf(campaign.key)).toEqual([]);
    expect(specs).toHaveLength(0);
  });

  it('asks before it says whether a version exists, so a refused caller learns nothing about the agent', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Asked first'));

    await expect(
      createAsyncRun({ ...base, campaignKey: campaign.key, options: { agentVersion: 9 }, authorizeAgentRun: refuse() }),
    ).rejects.toThrow('not allowed');
  });

  it('asks before it reports that a scan is already in progress', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Asked before conflict'));
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    await db.createRedTeamRun({
      tenantId: TENANT_ID, projectId: PROJECT, campaignKey: campaign.key, targetKind: 'agent', targetRef: AGENT_KEY,
      status: 'running', mode: 'async', startedAt: new Date(), progress: { total: 1, completed: 0, failed: 0 }, attempts: [],
      createdBy: ACTOR, agentRevision: { requested: 'published' },
    });

    await expect(createAsyncRun({ ...base, campaignKey: campaign.key, authorizeAgentRun: refuse() })).rejects.toThrow('not allowed');
  });

  it('does not ask for a model campaign', async () => {
    const model = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, {
      name: 'Model no question', targetKind: 'model', modelKey: 'm', probeKeys: ['prompt-injection'], projectId: PROJECT,
    });
    const authorize = refuse(); // it would refuse, were it asked

    const { run } = await createAsyncRun({ ...base, campaignKey: model.key, authorizeAgentRun: authorize });

    expect(authorize).not.toHaveBeenCalled();
    expect(run.status).toBe('pending');
  });

  it('answers an unknown campaign as not found, without asking', async () => {
    const authorize = refuse();

    await expect(createAsyncRun({ ...base, campaignKey: 'no-such-campaign', authorizeAgentRun: authorize })).rejects.toThrow(/not found/);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('keeps the check out of the queued job', async () => {
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Queued without check'));
    queue.publish.mockClear();
    const authorize = allow();

    const run = await enqueueCampaignRun({ ...base, campaignKey: campaign.key, options: { agentVersion: 'draft' }, authorizeAgentRun: authorize });

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(queue.publish).toHaveBeenCalledTimes(1);
    const payload = (queue.publish.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2];
    expect(payload).toEqual({
      tenantDbName: TENANT_DB_NAME,
      tenantId: TENANT_ID,
      projectId: PROJECT,
      createdBy: ACTOR,
      runId: run.id,
      campaignId: campaign.id,
      options: { agentVersion: 'draft' },
    });
  });

  it('does not ask for a scheduled scan: the schedule has no caller, which is why saving the campaign asked', async () => {
    queue.publish.mockClear();
    const schedule = { cron: '* * * * *', enabled: true };
    const campaign = await createCampaign(TENANT_DB_NAME, TENANT_ID, ACTOR, campaignInput('Scheduled without caller', { schedule }));

    const result = await runScheduledScans(TENANT_DB_NAME, TENANT_ID, new Date());

    expect(result.fired).toContain(campaign.key);
  });
});
