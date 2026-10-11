/**
 * Message feedback storage — the contract both database providers must keep
 * (SQLite and MongoDB via mongodb-memory-server). The two mixins are written
 * independently, so the same assertions run against both: one rating per person
 * per message, replaceable; counts and reasons; filters; the "removed" mark; and
 * that a client tool's timeout survives the pending-action round trip.
 */

import { beforeEach, expect, it } from 'vitest';
import type { IAgentMessageFeedback } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

describeForEachProvider('Agent message feedback', (getDb) => {
  let tenantId: string;
  const projectId = 'proj-1';
  const agentKey = 'support-bot';

  beforeEach(async () => {
    const slug = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const row = (overrides: Partial<Omit<IAgentMessageFeedback, '_id' | 'createdAt' | 'updatedAt' | 'removedAt'>> = {}) => ({
    tenantId,
    projectId,
    agentKey,
    agentVersion: 3 as number | null,
    conversationId: 'conv-1',
    messageId: 'msg_a',
    messageIndex: 1,
    userId: 'u1',
    channel: 'portal',
    rating: 'down' as const,
    reasons: ['inaccurate'] as IAgentMessageFeedback['reasons'],
    comment: 'wrong date',
    ...overrides,
  });

  it('stores a rating and reads it back', async () => {
    const db = getDb();
    const { feedback, created } = await db.upsertAgentMessageFeedback(row({ portalId: 'portal-9' }));
    expect(created).toBe(true);
    expect(String(feedback._id)).toMatch(/^fb_/);
    expect(feedback).toMatchObject({
      tenantId, projectId, agentKey, agentVersion: 3, conversationId: 'conv-1', messageId: 'msg_a', messageIndex: 1,
      userId: 'u1', channel: 'portal', portalId: 'portal-9', rating: 'down', reasons: ['inaccurate'], comment: 'wrong date',
    });
    expect(feedback.createdAt).toBeInstanceOf(Date);
    expect(feedback.removedAt ?? null).toBeNull();

    expect(await db.findAgentMessageFeedback('conv-1', 'msg_a', 'u1')).toMatchObject({ rating: 'down' });
    expect(await db.findAgentMessageFeedback('conv-1', 'msg_a', 'u2')).toBeNull();
  });

  it('one rating per person per message: rating again replaces it and keeps its id and creation time', async () => {
    const db = getDb();
    const first = await db.upsertAgentMessageFeedback(row());
    await tick();
    const second = await db.upsertAgentMessageFeedback(row({ rating: 'up', reasons: [], comment: undefined, channel: 'embed' }));
    expect(second.created).toBe(false);
    expect(String(second.feedback._id)).toBe(String(first.feedback._id));
    expect(new Date(second.feedback.createdAt).getTime()).toBe(new Date(first.feedback.createdAt).getTime());
    expect(new Date(second.feedback.updatedAt).getTime()).toBeGreaterThan(new Date(first.feedback.createdAt).getTime());
    expect(second.feedback).toMatchObject({ rating: 'up', reasons: [], channel: 'embed' });
    expect(second.feedback.comment).toBeUndefined();
    expect(await db.listAgentMessageFeedbackByConversation('conv-1')).toHaveLength(1);

    // Another person rates the same message: a second row.
    await db.upsertAgentMessageFeedback(row({ userId: 'u2' }));
    expect(await db.listAgentMessageFeedbackByConversation('conv-1')).toHaveLength(2);
    expect(await db.listAgentMessageFeedbackByConversation('conv-1', { userId: 'u2' })).toHaveLength(1);
  });

  it('withdrawing deletes the rating, and only that person\'s', async () => {
    const db = getDb();
    await db.upsertAgentMessageFeedback(row());
    await db.upsertAgentMessageFeedback(row({ userId: 'u2' }));
    expect(await db.deleteAgentMessageFeedback('conv-1', 'msg_a', 'u1')).toBe(true);
    expect(await db.deleteAgentMessageFeedback('conv-1', 'msg_a', 'u1')).toBe(false);
    expect(await db.findAgentMessageFeedback('conv-1', 'msg_a', 'u2')).not.toBeNull();
  });

  it('lists an agent\'s ratings newest first, with filters and paging', async () => {
    const db = getDb();
    await db.upsertAgentMessageFeedback(row({ messageId: 'm1', messageIndex: 1, rating: 'up', reasons: [], comment: undefined }));
    await tick();
    await db.upsertAgentMessageFeedback(row({ messageId: 'm2', messageIndex: 3, rating: 'down', reasons: ['too_long', 'other'], comment: undefined }));
    await tick();
    await db.upsertAgentMessageFeedback(row({ messageId: 'm3', messageIndex: 5, rating: 'down', reasons: ['inaccurate'], comment: 'bad', portalId: 'p1' }));
    // Other agent / other project: never listed.
    await db.upsertAgentMessageFeedback(row({ agentKey: 'other-bot', messageId: 'm4' }));
    await db.upsertAgentMessageFeedback(row({ projectId: 'proj-2', messageId: 'm5' }));

    const base = { projectId, agentKey };
    const all = await db.listAgentMessageFeedback(base);
    expect(all.total).toBe(3);
    expect(all.items.map((item) => item.messageId)).toEqual(['m3', 'm2', 'm1']);

    expect((await db.listAgentMessageFeedback({ ...base, rating: 'up' })).items.map((item) => item.messageId)).toEqual(['m1']);
    expect((await db.listAgentMessageFeedback({ ...base, reason: 'other' })).items.map((item) => item.messageId)).toEqual(['m2']);
    expect((await db.listAgentMessageFeedback({ ...base, hasComment: true })).items.map((item) => item.messageId)).toEqual(['m3']);
    expect((await db.listAgentMessageFeedback({ ...base, portalId: 'p1' })).items.map((item) => item.messageId)).toEqual(['m3']);
    expect((await db.listAgentMessageFeedback({ ...base, from: new Date(Date.now() + 60_000) })).total).toBe(0);

    const page = await db.listAgentMessageFeedback(base, { limit: 2, skip: 1 });
    expect(page.total).toBe(3);
    expect(page.items.map((item) => item.messageId)).toEqual(['m2', 'm1']);
  });

  it('counts ratings, comments and reasons', async () => {
    const db = getDb();
    await db.upsertAgentMessageFeedback(row({ messageId: 'm1', rating: 'up', reasons: [], comment: undefined }));
    await db.upsertAgentMessageFeedback(row({ messageId: 'm2', reasons: ['too_long', 'other'], comment: undefined }));
    await db.upsertAgentMessageFeedback(row({ messageId: 'm3', reasons: ['inaccurate', 'other'], comment: 'bad' }));
    await db.upsertAgentMessageFeedback(row({ messageId: 'm4', userId: 'u2', reasons: ['inaccurate'], comment: 'also bad' }));

    expect(await db.aggregateAgentMessageFeedback({ projectId, agentKey })).toEqual({
      up: 1, down: 3, withComment: 2, reasons: { too_long: 1, other: 2, inaccurate: 2 },
    });
    expect(await db.aggregateAgentMessageFeedback({ projectId, agentKey, rating: 'down', reason: 'inaccurate' })).toEqual({
      up: 0, down: 2, withComment: 2, reasons: { inaccurate: 2, other: 1 },
    });
    expect(await db.aggregateAgentMessageFeedback({ projectId, agentKey: 'nobody' })).toEqual({ up: 0, down: 0, withComment: 0, reasons: {} });
  });

  it('marks the ratings of messages cut from the transcript, and a new rating of a message is live again', async () => {
    const db = getDb();
    await db.upsertAgentMessageFeedback(row({ messageId: 'm1', messageIndex: 1 }));
    await db.upsertAgentMessageFeedback(row({ messageId: 'm2', messageIndex: 3 }));
    await db.upsertAgentMessageFeedback(row({ messageId: 'm3', messageIndex: 5 }));
    await db.upsertAgentMessageFeedback(row({ conversationId: 'conv-2', messageId: 'm9', messageIndex: 5 }));

    expect(await db.markAgentMessageFeedbackRemoved('conv-1', 3)).toBe(2);
    const marked = await db.listAgentMessageFeedbackByConversation('conv-1');
    expect(marked.map((item) => [item.messageId, Boolean(item.removedAt)])).toEqual([['m1', false], ['m2', true], ['m3', true]]);
    expect(await db.markAgentMessageFeedbackRemoved('conv-1', 3)).toBe(0); // already marked
    expect(Boolean((await db.findAgentMessageFeedback('conv-2', 'm9', 'u1'))?.removedAt)).toBe(false);
    // Removed ratings still count.
    expect((await db.aggregateAgentMessageFeedback({ projectId, agentKey })).down).toBe(4);

    await db.upsertAgentMessageFeedback(row({ messageId: 'm2', messageIndex: 3 }));
    expect(Boolean((await db.findAgentMessageFeedback('conv-1', 'm2', 'u1'))?.removedAt)).toBe(false);
  });

  it('deleting a conversation takes its ratings with it', async () => {
    const db = getDb();
    const conversation = await db.createAgentConversation({
      tenantId, projectId, agentKey, title: 't', messages: [], createdBy: 'u1',
    });
    const conversationId = String(conversation._id);
    await db.upsertAgentMessageFeedback(row({ conversationId }));
    await db.upsertAgentMessageFeedback(row({ conversationId: 'other', messageId: 'x' }));
    expect(await db.deleteAgentConversation(conversationId)).toBe(true);
    expect(await db.listAgentMessageFeedbackByConversation(conversationId)).toEqual([]);
    expect(await db.listAgentMessageFeedbackByConversation('other')).toHaveLength(1);
    expect(await db.deleteAgentMessageFeedbackByConversation('other')).toBe(1);
  });

  it('a client tool action keeps its timeout', async () => {
    const db = getDb();
    const [created] = await db.createAgentPendingActions([{
      tenantId, projectId, agentKey, conversationId: 'conv-1', kind: 'client_tool', sdkId: 'sdk-1', toolCallId: 'call-1',
      toolName: 'get_selection', args: { max: 5 }, status: 'pending', requestedAt: new Date(), expiresAt: new Date(Date.now() + 45_000),
      clientTool: { timeoutSeconds: 30 }, createdBy: 'u1',
    }]);
    const found = await db.findAgentPendingActionById(String(created._id));
    expect(found).toMatchObject({ kind: 'client_tool', toolName: 'get_selection', args: { max: 5 }, clientTool: { timeoutSeconds: 30 } });

    const resolved = await db.updateAgentPendingAction(String(created._id), {
      status: 'resolved', resolution: { output: { text: 'x' }, durationMs: 1200 },
    });
    expect(resolved?.resolution).toEqual({ output: { text: 'x' }, durationMs: 1200 });
    // An approval has none.
    const [approval] = await db.createAgentPendingActions([{
      tenantId, projectId, agentKey, conversationId: 'conv-1', kind: 'tool_approval', sdkId: 'sdk-2',
      status: 'pending', requestedAt: new Date(),
    }]);
    expect((await db.findAgentPendingActionById(String(approval._id)))?.clientTool).toBeUndefined();
  });
});
