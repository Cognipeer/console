/**
 * A conversation that says "running" while nothing runs it (the process died
 * mid-turn) reads as ended: idle, stopReason 'error'. Against a real SQLite
 * provider through the service reads the dashboard and the client API use.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-stale-running-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'stale_running_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import type { DatabaseProvider, IAgentConversation } from '@/lib/database';
import { getConversationById, listConversations } from '@/lib/services/agents/agentService';
import { reserveConversationForSyncTurn } from '@/lib/services/agents/agentRunService';
import { describeSessionRuntime } from '@/server/api/plugins/agent-session-events';
import {
  STALE_RUNNING_AFTER_MS,
  normalizeStaleRunningStatus,
} from '@/lib/services/agents/sessionRuntime';

const DB_NAME = 'stale_running_tenant';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'support-bot';
const MINUTE = 60_000;

let db: DatabaseProvider;
let tenantId: string;

async function newConversation(runtime?: Partial<Pick<IAgentConversation, 'runtimeStatus' | 'stopReason'>>) {
  const conversation = await db.createAgentConversation({
    tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, title: 'chat', messages: [], createdBy: 'user-1',
  });
  if (runtime) await db.updateAgentConversationRuntime(String(conversation._id), runtime);
  return String(conversation._id);
}

/** Moves "now" forward so the conversation (last written a moment ago) has been quiet that long. */
function quietFor(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
}

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'Acme', slug: 'acme-stale', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.switchToTenant(DB_NAME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a "running" conversation with nothing running it', () => {
  it('reads as idle with stopReason "error" once it has been quiet past the threshold, and the correction is stored', async () => {
    const id = await newConversation({ runtimeStatus: 'running' });
    quietFor(STALE_RUNNING_AFTER_MS + MINUTE);

    const read = await getConversationById(DB_NAME, id);
    expect(read).toMatchObject({ runtimeStatus: 'idle', stopReason: 'error' });

    vi.useRealTimers();
    const stored = await db.findAgentConversationById(id);
    expect(stored).toMatchObject({ runtimeStatus: 'idle', stopReason: 'error' });
  });

  it('is what the client session endpoint reports (runtime_status / stop_reason)', async () => {
    const id = await newConversation({ runtimeStatus: 'running' });
    quietFor(STALE_RUNNING_AFTER_MS + MINUTE);

    // `GET /client/v1/agents/sessions/:id` resolves the session with getConversationById, then describes it.
    const conversation = (await getConversationById(DB_NAME, id))!;
    expect(await describeSessionRuntime(DB_NAME, conversation)).toMatchObject({
      runtimeStatus: 'idle', stopReason: 'error', pendingActions: [],
    });
  });

  it('is corrected in the session list too, leaving the other rows alone', async () => {
    const dead = await newConversation({ runtimeStatus: 'running' });
    const waiting = await newConversation({ runtimeStatus: 'requires_action' });
    const idle = await newConversation({ runtimeStatus: 'idle', stopReason: 'end_turn' });
    quietFor(STALE_RUNNING_AFTER_MS + MINUTE);

    const listed = await listConversations(DB_NAME, AGENT_KEY, { projectId: PROJECT_ID });
    const byId = new Map(listed.map((conversation) => [String(conversation._id), conversation]));
    expect(byId.get(dead)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'error' });
    expect(byId.get(waiting)).toMatchObject({ runtimeStatus: 'requires_action' });
    expect(byId.get(idle)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
  });

  it('stays "running" while it holds an active run, however long it has been quiet', async () => {
    const id = await newConversation({ runtimeStatus: 'running' });
    const reservation = await reserveConversationForSyncTurn(db, {
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'work', userId: 'user-1',
    });
    expect(reservation).not.toBeNull();
    quietFor(30 * MINUTE);

    expect(await getConversationById(DB_NAME, id)).toMatchObject({ runtimeStatus: 'running' });
    vi.useRealTimers();
    expect((await db.findAgentConversationById(id))?.runtimeStatus).toBe('running');

    // The turn ends and gives the slot back: now nothing runs it.
    await reservation!.release();
    quietFor(30 * MINUTE);
    expect(await getConversationById(DB_NAME, id)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'error' });
  });

  it('stays "running" within the threshold, without even looking for a run', async () => {
    const id = await newConversation({ runtimeStatus: 'running' });
    quietFor(STALE_RUNNING_AFTER_MS - 10_000);

    const lookup = vi.spyOn(db, 'listAgentRuns');
    const conversation = (await db.findAgentConversationById(id))!;
    expect(await normalizeStaleRunningStatus(db, conversation)).toBe(conversation);
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockRestore();
  });

  it('only looks for an active run through the per-conversation lookup, and only for a "running" row', async () => {
    const running = await newConversation({ runtimeStatus: 'running' });
    const idle = await newConversation({ runtimeStatus: 'idle' });
    const never = await newConversation(); // an old conversation: no runtime fields at all
    quietFor(STALE_RUNNING_AFTER_MS + MINUTE);

    const lookup = vi.spyOn(db, 'listAgentRuns');
    for (const id of [running, idle, never]) {
      await normalizeStaleRunningStatus(db, (await db.findAgentConversationById(id))!);
    }
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith({
      tenantId, projectId: PROJECT_ID, conversationId: running, status: ['queued', 'running'], limit: 1,
    });
    lookup.mockRestore();
  });

  it('does not guess a turn dead when the run lookup fails', async () => {
    const id = await newConversation({ runtimeStatus: 'running' });
    quietFor(STALE_RUNNING_AFTER_MS + MINUTE);
    const lookup = vi.spyOn(db, 'listAgentRuns').mockRejectedValue(new Error('db unavailable'));

    expect(await getConversationById(DB_NAME, id)).toMatchObject({ runtimeStatus: 'running' });
    lookup.mockRestore();
  });

  it('still reports idle when the correction cannot be stored', async () => {
    const id = await newConversation({ runtimeStatus: 'running' });
    quietFor(STALE_RUNNING_AFTER_MS + MINUTE);
    const write = vi.spyOn(db, 'updateAgentConversationRuntime').mockRejectedValue(new Error('read-only'));

    expect(await getConversationById(DB_NAME, id)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'error' });
    write.mockRestore();
  });
});
