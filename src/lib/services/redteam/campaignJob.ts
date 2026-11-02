/**
 * Async red-team scan — queue enqueue + job runner.
 *
 * A scan (probes × attempts × multi-turn × judge panel) can take many model
 * calls, so it must not block the HTTP request:
 *   1. `enqueueCampaignRun` creates a `pending` run and publishes a job.
 *   2. The queue consumer (see `campaignConsumer`) calls `runCampaignJob`, which
 *      loads the campaign and drives `executeRun` to completion.
 *
 * Progress + results live on the run row, so the dashboard polls the normal run
 * detail endpoint to watch a scan finish.
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { createAsyncRun, executeRun, type RunOptions, type WithId } from './service';
import { isDue } from './schedulePlanner';
import { storedAgentRevision } from '@/lib/shared/agentRevision';
import type { IRedTeamRun } from '@/lib/database';

const logger = createLogger('redteam:job');

export const RED_TEAM_QUEUE = 'redteam-scan';
export const RED_TEAM_JOB = 'redteam.run';

export interface RedTeamJobPayload extends QueuePayload {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  createdBy: string;
  /** The API token a client API call started the scan with (its agent target reads knowledge bases as the token). */
  apiTokenId?: string;
  runId: string;
  campaignId: string;
  options?: RunOptions;
}

export interface EnqueueCampaignRunInput {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  createdBy: string;
  /** See RedTeamJobPayload.apiTokenId. */
  apiTokenId?: string;
  campaignKey: string;
  /** Per-run overrides (turns, concurrency, probe/judge selection). */
  options?: RunOptions;
  /** Refuses the scan of an agent campaign before a run exists (see `CreateRunParams`); never queued. */
  authorizeAgentRun?: () => Promise<void>;
}

/**
 * Create the pending run and publish the scan job. Returns the run immediately
 * (status `pending`) so the caller can respond fast.
 */
export async function enqueueCampaignRun(input: EnqueueCampaignRunInput): Promise<WithId<IRedTeamRun>> {
  const { campaign, run } = await createAsyncRun(input);

  const payload: RedTeamJobPayload = {
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    projectId: input.projectId,
    createdBy: input.createdBy,
    ...(input.apiTokenId ? { apiTokenId: input.apiTokenId } : {}),
    runId: run.id,
    campaignId: String(campaign._id),
    options: input.options,
  };

  const queue = await getQueue();
  await queue.publish(RED_TEAM_QUEUE, RED_TEAM_JOB, payload, { attempts: 2, backoffMs: 5000 });
  logger.info('Red-team scan enqueued', { runId: run.id, campaignKey: campaign.key });

  return run;
}

/** Execute one scan job. Throws on a fatal error so the queue can retry. */
export async function runCampaignJob(payload: RedTeamJobPayload): Promise<void> {
  // Queue-consumer context: no request-level tenant scope exists, so bind the
  // tenant for the whole job — switchToTenant alone would let the run
  // updates land in whatever tenant a concurrent request last bound.
  return runWithTenantScope(payload.tenantDbName, async (db) => {
    const campaign = await db.findRedTeamCampaignById(payload.campaignId);
    if (!campaign) {
      logger.error('Red-team scan job: campaign gone', { campaignId: payload.campaignId, runId: payload.runId });
      await db.updateRedTeamRun(payload.runId, { status: 'failed', error: 'campaign not found', finishedAt: new Date() });
      return;
    }

    await executeRun({
      tenantDbName: payload.tenantDbName,
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      createdBy: payload.createdBy,
      ...(payload.apiTokenId ? { apiTokenId: payload.apiTokenId } : {}),
      runId: payload.runId,
      campaign,
      options: payload.options,
    });
    logger.info('Red-team scan completed', { runId: payload.runId, campaignKey: campaign.key });
  });
}

/**
 * Enqueue a scan for every campaign in a tenant whose cron schedule is due.
 * "Due" is decided against the most recent run's timestamp so each slot fires
 * at most once. Used by the background red-team scheduler. A campaign with a
 * scan already in progress is skipped (createAsyncRun throws → caught here), and
 * so is one whose default revision is the draft (a schedule guards what is
 * published).
 */
export async function runScheduledScans(
  tenantDbName: string,
  tenantId: string,
  now: Date = new Date(),
): Promise<{ fired: string[]; errors: string[] }> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const campaigns = await db.listRedTeamCampaigns();
  const fired: string[] = [];
  const errors: string[] = [];
  for (const campaign of campaigns) {
    if (!campaign.schedule?.enabled) continue;
    // Saving refuses this combination; guard again so a campaign that got there
    // some other way never runs unattended against an unpublished draft.
    if (campaign.targetKind === 'agent' && storedAgentRevision(campaign.agentVersion) === 'draft') {
      errors.push(`${campaign.key}: scheduled scans cannot run against the draft; pick Published or a version`);
      continue;
    }
    const recent = await db.listRedTeamRuns({ campaignKey: campaign.key, limit: 1 });
    const last = recent[0]?.startedAt ?? recent[0]?.createdAt ?? null;
    if (!isDue(campaign.schedule, last ? new Date(last) : null, now)) continue;
    try {
      await enqueueCampaignRun({
        tenantDbName,
        tenantId,
        projectId: campaign.projectId,
        createdBy: 'system',
        campaignKey: campaign.key,
      });
      fired.push(campaign.key);
    } catch (err) {
      // "already in progress" is expected when the previous scan still runs.
      errors.push(`${campaign.key}: ${(err as Error).message}`);
    }
  }
  return { fired, errors };
}
