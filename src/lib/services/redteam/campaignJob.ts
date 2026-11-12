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
import { runWithTenantScope } from '@/lib/database';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { createAsyncRun, executeRun, type RunOptions, type WithId } from './service';
import { isDue, latestSlot } from './schedulePlanner';
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

  try {
    const queue = await getQueue();
    await queue.publish(RED_TEAM_QUEUE, RED_TEAM_JOB, payload, { attempts: 2, backoffMs: 5000 });
  } catch (error) {
    // A run no worker will ever take is ended here, so it does not hold the campaign as busy.
    logger.error('Red-team scan could not be queued', { runId: run.id, campaignKey: campaign.key, error });
    try {
      await runWithTenantScope(input.tenantDbName, (db) =>
        db.updateRedTeamRunIf(run.id, { status: 'pending' }, {
          status: 'failed',
          error: 'The scan could not be queued; try again.',
          finishedAt: new Date(),
        }));
    } catch (endError) {
      logger.error('Red-team run left pending after a queue failure', { runId: run.id, error: endError });
    }
    throw error;
  }
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
      // Only a run still waiting is ended here; one a worker already took is that worker's to finish.
      await db.updateRedTeamRunIf(payload.runId, { status: 'pending' }, {
        status: 'failed',
        error: 'campaign not found',
        finishedAt: new Date(),
      });
      return;
    }

    const run = await executeRun({
      tenantDbName: payload.tenantDbName,
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      createdBy: payload.createdBy,
      ...(payload.apiTokenId ? { apiTokenId: payload.apiTokenId } : {}),
      runId: payload.runId,
      campaign,
      options: payload.options,
    });
    // A run somebody else already started (a queue retry) comes back as it is, without work done here.
    logger.info('Red-team scan job finished', { runId: payload.runId, campaignKey: campaign.key, status: run.status });
  });
}

/** A claimed slot is remembered for a day, long past the moment every replica has seen it. */
const SLOT_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/** The claim key of one cron slot of one campaign: whoever inserts it first fires the slot. */
export function scheduledSlotKey(tenantDbName: string, campaignId: string, slot: Date): string {
  return `redteam:${tenantDbName}:${campaignId}:${slot.toISOString().slice(0, 16)}`;
}

/**
 * Enqueue a scan for every campaign in a tenant whose cron schedule is due.
 * "Due" is decided against the most recent run's timestamp so each slot fires
 * at most once on one replica; the database claim on the slot makes that hold
 * across replicas too (the replica that loses the claim skips the slot). Used by
 * the background red-team scheduler. A campaign with a scan already in progress
 * is skipped (createAsyncRun throws → caught here), and so is one whose default
 * revision is the draft (a schedule guards what is published).
 */
export async function runScheduledScans(
  tenantDbName: string,
  tenantId: string,
  now: Date = new Date(),
): Promise<{ fired: string[]; errors: string[]; claimedElsewhere: string[] }> {
  return runWithTenantScope(tenantDbName, async (db) => {
    const campaigns = await db.listRedTeamCampaigns();
    const fired: string[] = [];
    const errors: string[] = [];
    const claimedElsewhere: string[] = [];
    for (const campaign of campaigns) {
      if (!campaign.schedule?.enabled) continue;
      // Saving refuses this combination; guard again so a campaign that got there
      // some other way never runs unattended against an unpublished draft.
      if (campaign.targetKind === 'agent' && storedAgentRevision(campaign.agentVersion) === 'draft') {
        errors.push(`${campaign.key}: scheduled scans cannot run against the draft; pick Published or a version`);
        continue;
      }
      // Keys are unique per project, so the last run is looked up in the campaign's own project.
      const recent = await db.listRedTeamRuns({ projectId: campaign.projectId, campaignKey: campaign.key, limit: 1, omitAttempts: true });
      const last = recent[0]?.startedAt ?? recent[0]?.createdAt ?? null;
      if (!isDue(campaign.schedule, last ? new Date(last) : null, now)) continue;
      const slot = latestSlot(campaign.schedule, now);
      if (!slot) continue;
      try {
        const won = await db.claimSchedulerSlot(
          scheduledSlotKey(tenantDbName, String(campaign._id), slot),
          new Date(now.getTime() + SLOT_CLAIM_TTL_MS),
        );
        if (!won) {
          claimedElsewhere.push(campaign.key);
          continue;
        }
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
    return { fired, errors, claimedElsewhere };
  });
}
