/**
 * Session event log, pending actions and conversation runtime fields — the
 * contract both database providers must keep (SQLite and MongoDB).
 */

import { it, expect, beforeEach } from 'vitest';
import { AgentSessionEventSeqConflictError } from '@/lib/database/provider/errors';
import type { IAgentPendingAction, IAgentSessionEvent } from '@/lib/database/provider.interface';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';
import { createSessionEventBus, createSessionEventWriter, type SessionEventFrame } from '@/lib/services/agents/sessionEvents';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Agent session events / pending actions', (getDb) => {
  let tenantId: string;
  const projectId = 'proj-1';
  const agentKey = 'support-bot';

  beforeEach(async () => {
    const slug = `sevt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const event = (conversationId: string, seq: number, type = 'agent.tool_use', data: Record<string, unknown> = {}): Omit<IAgentSessionEvent, '_id'> => ({
    tenantId,
    projectId,
    agentKey,
    conversationId,
    seq,
    type,
    data,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  const action = (conversationId: string, overrides: Partial<Omit<IAgentPendingAction, '_id'>> = {}): Omit<IAgentPendingAction, '_id'> => ({
    tenantId,
    projectId,
    agentKey,
    conversationId,
    kind: 'tool_approval',
    sdkId: 'sdk-1',
    toolName: 'sandbox_exec',
    args: { cmd: 'ls' },
    status: 'pending',
    requestedAt: new Date(),
    ...overrides,
  });

  it('appends events, lists them after a seq, filters by type and reports the max seq', async () => {
    const db = getDb();
    const conv = `c-${Math.random().toString(36).slice(2, 8)}`;
    expect(await db.getAgentSessionMaxSeq(conv)).toBe(0);

    await db.appendAgentSessionEvents([
      event(conv, 1, 'user.message', { content: 'hi' }),
      event(conv, 2, 'agent.tool_use', { name: 'a' }),
      event(conv, 3, 'agent.message', { content: 'done' }),
    ]);

    expect(await db.getAgentSessionMaxSeq(conv)).toBe(3);
    const after1 = await db.listAgentSessionEvents(conv, { afterSeq: 1 });
    expect(after1.map((e) => e.seq)).toEqual([2, 3]);
    expect(after1[0].data).toEqual({ name: 'a' });
    const onlyMessages = await db.listAgentSessionEvents(conv, { types: ['agent.message', 'user.message'] });
    expect(onlyMessages.map((e) => e.type)).toEqual(['user.message', 'agent.message']);
    expect((await db.listAgentSessionEvents(conv, { limit: 2 })).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('rejects a duplicate (conversationId, seq) with AgentSessionEventSeqConflictError', async () => {
    const db = getDb();
    const conv = `c-${Math.random().toString(36).slice(2, 8)}`;
    await db.appendAgentSessionEvents([event(conv, 1)]);
    await expect(db.appendAgentSessionEvents([event(conv, 1)])).rejects.toBeInstanceOf(AgentSessionEventSeqConflictError);
    // The same seq in another conversation is fine.
    await expect(db.appendAgentSessionEvents([event(`${conv}-b`, 1)])).resolves.toBeUndefined();
  });

  it('keeps a caller-supplied _id, and a conflict part-way through a batch names the events that were stored', async () => {
    const db = getDb();
    const conv = `c-${Math.random().toString(36).slice(2, 8)}`;
    await db.appendAgentSessionEvents([{ ...event(conv, 2, 'foreign'), _id: 'sevt_foreign' }]);

    // seq 1 is free, seq 2 is taken, seq 3 is free: an ordered insert stops at the second.
    const batch = [
      { ...event(conv, 1, 'a'), _id: 'sevt_a' },
      { ...event(conv, 2, 'b'), _id: 'sevt_b' },
      { ...event(conv, 3, 'c'), _id: 'sevt_c' },
    ];
    const error = await db.appendAgentSessionEvents(batch).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AgentSessionEventSeqConflictError);

    const stored = (await db.listAgentSessionEvents(conv)).map((e) => String(e._id));
    const fromBatch = ['sevt_a', 'sevt_b', 'sevt_c'].filter((id) => stored.includes(id));
    // Whatever the provider kept of the batch is exactly what the error reports.
    expect([...(error as AgentSessionEventSeqConflictError).writtenIds].sort()).toEqual(fromBatch.sort());
    // The event that conflicted was never stored; nothing after it was either.
    expect(stored).not.toContain('sevt_b');
    expect(stored).not.toContain('sevt_c');
    // MongoDB keeps the prefix of an ordered insert; SQLite rolls the whole batch back.
    expect(fromBatch).toEqual(db instanceof MongoDBProvider ? ['sevt_a'] : []);
  });

  it('a writer whose batch conflicts part-way stores every event exactly once, none under a second seq', async () => {
    const db = getDb();
    const conv = `c-${Math.random().toString(36).slice(2, 8)}`;
    const frames: SessionEventFrame[] = [];
    const bus = createSessionEventBus(() => null);
    bus.subscribe(conv, (frame) => frames.push(frame));
    const writer = createSessionEventWriter({ db, tenantId, projectId, agentKey, conversationId: conv, bus, retentionDays: 1 });

    writer.emit('agent.tool_use', { n: 0 });
    await writer.flush(); // seq 1; the writer next expects seq 2
    // Another producer takes seq 3 behind the writer's back.
    await db.appendAgentSessionEvents([event(conv, 3, 'foreign')]);

    writer.emit('agent.tool_use', { n: 1 }); // seq 2: free
    writer.emit('agent.tool_use', { n: 2 }); // seq 3: taken — the insert stops here
    writer.emit('agent.tool_use', { n: 3 }); // seq 4
    await writer.close();

    const log = await db.listAgentSessionEvents(conv);
    const written = log.filter((e) => e.type === 'agent.tool_use');
    // Each of the four events is in the log exactly once.
    expect(written.map((e) => e.data.n)).toEqual([0, 1, 2, 3]);
    // Seqs are unique and strictly ascending across the whole log.
    const seqs = log.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // What followers were told is what is stored: same events, same seqs, once each.
    expect(frames.filter((f) => f.type === 'agent.tool_use').map((f) => [f.seq, f.data.n])).toEqual(written.map((e) => [e.seq, e.data.n]));
    // MongoDB kept the event written before the conflict where it was.
    if (db instanceof MongoDBProvider) {
      expect(written.map((e) => e.seq)).toEqual([1, 2, 4, 5]);
    }
    expect(writer.lastSeq()).toBe(Math.max(...written.map((e) => e.seq)));
  });

  it('retention deletes only events past their expiresAt; deleting a conversation drops its events and actions', async () => {
    const db = getDb();
    const conv = await db.createAgentConversation({ tenantId, projectId, agentKey, messages: [], createdBy: 'u1' });
    const id = String(conv._id);
    await db.appendAgentSessionEvents([
      { ...event(id, 1), expiresAt: new Date(Date.now() - 1000) },
      event(id, 2),
    ]);
    await db.createAgentPendingActions([action(id)]);

    const { deletedCount } = await db.cleanupAgentSessionEventRetention({ olderThan: new Date() });
    expect(deletedCount).toBe(1);
    expect((await db.listAgentSessionEvents(id)).map((e) => e.seq)).toEqual([2]);

    await db.deleteAgentConversation(id);
    expect(await db.listAgentSessionEvents(id)).toEqual([]);
    expect(await db.listAgentPendingActions(id)).toEqual([]);
  });

  it('creates pending actions, resolves them with a compare-and-set and lists the expired ones', async () => {
    const db = getDb();
    const conv = `c-${Math.random().toString(36).slice(2, 8)}`;
    const [a, b] = await db.createAgentPendingActions([
      action(conv, { sdkId: 'sdk-1', expiresAt: new Date(Date.now() - 1000) }),
      action(conv, { sdkId: 'sdk-2', kind: 'user_question', toolName: undefined, args: undefined, questions: [{ question: 'Which?', options: [{ label: 'A' }] }], allowFreeText: true }),
    ]);
    expect(String(a._id)).toMatch(/^act_/);

    const found = await db.findAgentPendingActionById(String(b._id));
    expect(found?.kind).toBe('user_question');
    expect(found?.questions?.[0].question).toBe('Which?');
    expect(found?.allowFreeText).toBe(true);

    expect((await db.listAgentPendingActions(conv, { status: 'pending' })).length).toBe(2);
    expect((await db.listExpiredAgentPendingActions(new Date())).map((x) => String(x._id))).toEqual([String(a._id)]);

    const resolved = await db.updateAgentPendingAction(String(a._id), {
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: 'u1',
      resolution: { decision: 'allow', rememberForSession: true },
    });
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolution).toEqual({ decision: 'allow', rememberForSession: true });

    // Second resolve loses: it is no longer pending.
    expect(await db.updateAgentPendingAction(String(a._id), { status: 'cancelled' })).toBeNull();
    expect((await db.listExpiredAgentPendingActions(new Date())).length).toBe(0);
  });

  it('stores the conversation runtime fields and the paused snapshot (cleared by a normal save)', async () => {
    const db = getDb();
    const conv = await db.createAgentConversation({ tenantId, projectId, agentKey, messages: [], createdBy: 'u1' });
    const id = String(conv._id);

    await db.updateAgentConversationRuntime(id, {
      runtimeStatus: 'requires_action',
      stopReason: 'requires_action',
      pendingActionIds: ['act_1', 'act_2'],
      lastEventSeq: 7,
    });
    const reread = await db.findAgentConversationById(id);
    expect(reread?.runtimeStatus).toBe('requires_action');
    expect(reread?.stopReason).toBe('requires_action');
    expect(reread?.pendingActionIds).toEqual(['act_1', 'act_2']);
    expect(reread?.lastEventSeq).toBe(7);

    await db.updateAgentConversationRuntime(id, { runtimeStatus: 'idle', stopReason: 'end_turn', pendingActionIds: [] });
    const idle = await db.findAgentConversationById(id);
    expect(idle?.runtimeStatus).toBe('idle');
    expect(idle?.pendingActionIds ?? []).toEqual([]);

    await db.saveAgentConversationState({
      conversationId: id, tenantId, projectId, agentKey, snapshot: '{"a":1}', pausedSnapshot: '{"paused":true}', messageCount: 2, sizeBytes: 10,
    });
    expect((await db.findAgentConversationState(id))?.pausedSnapshot).toBe('{"paused":true}');
    await db.saveAgentConversationState({
      conversationId: id, tenantId, projectId, agentKey, snapshot: '{"a":2}', messageCount: 3, sizeBytes: 10,
    });
    const cleared = await db.findAgentConversationState(id);
    expect(cleared?.snapshot).toBe('{"a":2}');
    expect(cleared?.pausedSnapshot).toBeUndefined();
  });

  it('persists stopReason on a finalized agent run', async () => {
    const db = getDb();
    const conv = `c-${Math.random().toString(36).slice(2, 8)}`;
    const run = await db.createAgentRun({
      mode: 'background', tenantId, tenantDbName: 'x', projectId, agentKey, conversationId: conv, userMessage: 'hi', status: 'queued',
    });
    await db.claimAgentRun(String(run._id), tenantId, 'w1', new Date());
    const done = await db.finalizeAgentRun(String(run._id), tenantId, { status: 'succeeded', stopReason: 'limit', completedAt: new Date() });
    expect(done?.stopReason).toBe('limit');
    expect((await db.getAgentRunById(String(run._id), tenantId, projectId))?.stopReason).toBe('limit');
  });
});
