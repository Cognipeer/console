/**
 * Webhook subscriptions, conversation files and `IAgentRun.attachments` — the
 * contract both database providers must keep (SQLite and MongoDB via
 * mongodb-memory-server). The Mongo mixins and the SQLite ones are written
 * independently; these run the same assertions against both so a query that
 * returns a different set, or the same set in a different order, shows up here.
 */

import { beforeEach, expect, it } from 'vitest';
import type { IFileRecord, IWebhookDelivery, IWebhookEndpoint } from '@/lib/database/provider.interface';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';
import { describeForEachProvider } from './db-parity.helper';

/** createdAt has millisecond resolution: keep two writes apart so "oldest first" is well defined. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

const iso = (value: unknown) => (value ? new Date(value as string | Date).toISOString() : null);

describeForEachProvider('Webhooks / conversation files / run attachments', (getDb) => {
  let tenantId: string;
  let dbName: string;
  const projectId = 'proj-1';
  const agentKey = 'support-bot';

  beforeEach(async () => {
    const slug = `whk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  // ── Webhook endpoints ─────────────────────────────────────────────────

  const endpoint = (overrides: Partial<Omit<IWebhookEndpoint, '_id' | 'createdAt' | 'updatedAt'>> = {}) => ({
    tenantId,
    projectId: projectId as string | null,
    url: 'https://example.com/hook',
    events: ['session.idled'],
    secretSealed: 'sealed',
    status: 'active' as const,
    createdBy: 'u1',
    ...overrides,
  });

  it('creates an endpoint and reads it back with its project scope, events and timestamps', async () => {
    const db = getDb();
    const created = await db.createWebhookEndpoint(endpoint({ description: 'ops', events: ['session.*', 'budget.reached'] }));
    expect(String(created._id)).toMatch(/^whk_/);

    const found = await db.findWebhookEndpointById(String(created._id));
    expect(found).toMatchObject({
      tenantId, projectId, url: 'https://example.com/hook', description: 'ops',
      events: ['session.*', 'budget.reached'], secretSealed: 'sealed', status: 'active', createdBy: 'u1',
    });
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.updatedAt).toBeInstanceOf(Date);
    expect(await db.findWebhookEndpointById('whk_missing')).toBeNull();
  });

  it('lists a tenant\'s endpoints oldest first, by project scope including the tenant-wide (null) ones', async () => {
    const db = getDb();
    const a = await db.createWebhookEndpoint(endpoint({ projectId: 'p1' }));
    await tick();
    const all = await db.createWebhookEndpoint(endpoint({ projectId: null }));
    await tick();
    const b = await db.createWebhookEndpoint(endpoint({ projectId: 'p2', status: 'disabled', disabledReason: 'manual' }));
    await tick();
    const a2 = await db.createWebhookEndpoint(endpoint({ projectId: 'p1' }));
    // Another tenant's endpoint is never listed.
    await db.createWebhookEndpoint(endpoint({ tenantId: 'other-tenant', projectId: 'p1' }));
    const ids = (list: IWebhookEndpoint[]) => list.map((e) => String(e._id));

    expect(ids(await db.listWebhookEndpoints(tenantId))).toEqual([a, all, b, a2].map((e) => String(e._id)));
    expect(ids(await db.listWebhookEndpoints(tenantId, { projectScopes: ['p1'] }))).toEqual([a, a2].map((e) => String(e._id)));
    expect(ids(await db.listWebhookEndpoints(tenantId, { projectScopes: [null] }))).toEqual([String(all._id)]);
    expect(ids(await db.listWebhookEndpoints(tenantId, { projectScopes: ['p1', null] }))).toEqual([a, all, a2].map((e) => String(e._id)));
    expect(ids(await db.listWebhookEndpoints(tenantId, { projectScopes: ['p2', 'p1'] }))).toEqual([a, b, a2].map((e) => String(e._id)));
    expect(await db.listWebhookEndpoints(tenantId, { projectScopes: [] })).toEqual([]);
    expect(await db.listWebhookEndpoints(tenantId, { projectScopes: ['nope'] })).toEqual([]);
    expect(ids(await db.listWebhookEndpoints(tenantId, { status: 'disabled' }))).toEqual([String(b._id)]);
    expect(ids(await db.listWebhookEndpoints(tenantId, { projectScopes: ['p1', null], status: 'active' }))).toEqual([a, all, a2].map((e) => String(e._id)));
  });

  it('a tenant-wide endpoint reads back with projectId null on both providers', async () => {
    const db = getDb();
    const created = await db.createWebhookEndpoint(endpoint({ projectId: null }));
    expect((await db.findWebhookEndpointById(String(created._id)))?.projectId ?? null).toBeNull();
    // Also when the caller leaves the field out.
    const { projectId: _omit, ...withoutProject } = endpoint();
    void _omit;
    const implicit = await db.createWebhookEndpoint(withoutProject);
    expect((await db.findWebhookEndpointById(String(implicit._id)))?.projectId ?? null).toBeNull();
    expect((await db.listWebhookEndpoints(tenantId, { projectScopes: [null] })).length).toBe(2);
  });

  it('updates an endpoint (url, events, status, disabledReason, failingSince, description) and bumps updatedAt', async () => {
    const db = getDb();
    const created = await db.createWebhookEndpoint(endpoint({ description: 'old' }));
    const id = String(created._id);
    await tick();
    const since = new Date('2024-05-01T10:00:00Z');
    const updated = await db.updateWebhookEndpoint(id, {
      url: 'https://example.com/other',
      events: ['agent_run.*'],
      status: 'disabled',
      disabledReason: 'sustained_failure',
      failingSince: since,
      description: '',
    });
    expect(updated).toMatchObject({ url: 'https://example.com/other', events: ['agent_run.*'], status: 'disabled', disabledReason: 'sustained_failure' });
    expect(iso(updated?.failingSince)).toBe(since.toISOString());
    expect(updated!.updatedAt!.getTime()).toBeGreaterThan(created.updatedAt!.getTime());
    expect(updated?.description ?? '').toBe('');

    const cleared = await db.updateWebhookEndpoint(id, { status: 'active', disabledReason: null, failingSince: null });
    expect(cleared?.status).toBe('active');
    expect(cleared?.disabledReason ?? null).toBeNull();
    expect(cleared?.failingSince ?? null).toBeNull();
    expect(await db.updateWebhookEndpoint('whk_missing', { status: 'disabled' })).toBeNull();
  });

  // ── Webhook deliveries ────────────────────────────────────────────────

  const delivery = (endpointId: string, overrides: Partial<Omit<IWebhookDelivery, '_id'>> = {}): Omit<IWebhookDelivery, '_id'> => ({
    tenantId,
    projectId,
    endpointId,
    eventId: `evt_${Math.random().toString(36).slice(2, 10)}`,
    eventType: 'session.idled',
    payload: { id: 'evt', type: 'session.idled', data: { conversationId: 'c1' } },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  });

  it('stores a delivery with its payload, status and timestamps and reads it back', async () => {
    const db = getDb();
    const ep = await db.createWebhookEndpoint(endpoint());
    const next = new Date('2024-05-01T10:00:00Z');
    const [created] = await db.createWebhookDeliveries([delivery(String(ep._id), {
      eventId: 'evt_1', nextAttemptAt: next, payload: { id: 'evt_1', data: { n: 1, nested: { ok: true } } },
    })]);
    expect(String(created._id)).toMatch(/^whd_/);

    const found = await db.findWebhookDeliveryById(String(created._id));
    expect(found).toMatchObject({
      tenantId, projectId, endpointId: String(ep._id), eventId: 'evt_1', eventType: 'session.idled',
      payload: { id: 'evt_1', data: { n: 1, nested: { ok: true } } }, status: 'pending', attempts: 0,
    });
    expect(iso(found?.nextAttemptAt)).toBe(next.toISOString());
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(await db.createWebhookDeliveries([])).toEqual([]);
    expect(await db.findWebhookDeliveryById('whd_missing')).toBeNull();
  });

  it('updates a delivery: attempt bookkeeping, then delivered; a null clears a timestamp', async () => {
    const db = getDb();
    const ep = await db.createWebhookEndpoint(endpoint());
    const [created] = await db.createWebhookDeliveries([delivery(String(ep._id))]);
    const id = String(created._id);
    const retryAt = new Date(Date.now() + 60_000);

    const failed = await db.updateWebhookDelivery(id, {
      attempts: 1, nextAttemptAt: retryAt, lastStatusCode: 500, lastError: 'Endpoint answered HTTP 500', lastDurationMs: 42,
    });
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, lastStatusCode: 500, lastError: 'Endpoint answered HTTP 500', lastDurationMs: 42 });
    expect(iso(failed?.nextAttemptAt)).toBe(retryAt.toISOString());

    const done = await db.updateWebhookDelivery(id, {
      status: 'delivered', attempts: 2, nextAttemptAt: null, lastStatusCode: 200, lastError: null, deliveredAt: new Date(),
    });
    expect(done).toMatchObject({ status: 'delivered', attempts: 2, lastStatusCode: 200 });
    expect(done?.nextAttemptAt ?? null).toBeNull();
    expect(done?.lastError ?? null).toBeNull();
    expect(done?.deliveredAt).toBeInstanceOf(Date);

    // A redelivery puts it back.
    const again = await db.updateWebhookDelivery(id, { status: 'pending', attempts: 0, nextAttemptAt: new Date(), deliveredAt: null });
    expect(again?.status).toBe('pending');
    expect(again?.deliveredAt ?? null).toBeNull();
    expect(await db.updateWebhookDelivery('whd_missing', { attempts: 1 })).toBeNull();
    // Nothing to change is a read.
    expect((await db.updateWebhookDelivery(id, {}))?.status).toBe('pending');
  });

  it('lists an endpoint\'s deliveries newest first with a status filter and skip / limit', async () => {
    const db = getDb();
    const ep = await db.createWebhookEndpoint(endpoint());
    const other = await db.createWebhookEndpoint(endpoint());
    const epId = String(ep._id);
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const [row] = await db.createWebhookDeliveries([delivery(epId, {
        eventId: `evt_${i}`, status: i % 2 === 0 ? 'delivered' : 'failed', createdAt: new Date(Date.now() + i * 10),
      })]);
      made.push(String(row._id));
      await tick();
    }
    await db.createWebhookDeliveries([delivery(String(other._id), { eventId: 'evt_other' })]);
    const ids = (rows: IWebhookDelivery[]) => rows.map((r) => String(r._id));

    expect(ids(await db.listWebhookDeliveries(epId))).toEqual([...made].reverse());
    expect(ids(await db.listWebhookDeliveries(epId, { status: 'delivered' }))).toEqual([made[4], made[2], made[0]]);
    expect(ids(await db.listWebhookDeliveries(epId, { status: 'failed' }))).toEqual([made[3], made[1]]);
    expect(ids(await db.listWebhookDeliveries(epId, { limit: 2 }))).toEqual([made[4], made[3]]);
    expect(ids(await db.listWebhookDeliveries(epId, { limit: 2, skip: 2 }))).toEqual([made[2], made[1]]);
    expect(ids(await db.listWebhookDeliveries(epId, { skip: 4 }))).toEqual([made[0]]);
  });

  it('lists the due deliveries of a tenant by nextAttemptAt, and only pending ones that are due', async () => {
    const db = getDb();
    const ep = await db.createWebhookEndpoint(endpoint());
    const epId = String(ep._id);
    const now = new Date();
    const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
    const [late, early, future, settled, noTime, otherTenant, boundary] = await db.createWebhookDeliveries([
      delivery(epId, { eventId: 'late', nextAttemptAt: at(-10) }),
      delivery(epId, { eventId: 'early', nextAttemptAt: at(-300) }),
      delivery(epId, { eventId: 'future', nextAttemptAt: at(300) }),
      delivery(epId, { eventId: 'settled', status: 'delivered', nextAttemptAt: at(-300) }),
      delivery(epId, { eventId: 'notime', nextAttemptAt: null }),
      delivery(epId, { eventId: 'other', tenantId: 'other-tenant', nextAttemptAt: at(-300) }),
      delivery(epId, { eventId: 'boundary', nextAttemptAt: now }),
    ]);
    void future; void settled; void noTime; void otherTenant;

    const due = await db.listDueWebhookDeliveries(tenantId, now);
    expect(due.map((d) => d.eventId)).toEqual(['early', 'late', 'boundary']);
    expect(due.map((d) => String(d._id))).toEqual([early, late, boundary].map((d) => String(d._id)));
    expect((await db.listDueWebhookDeliveries(tenantId, now, 2)).map((d) => d.eventId)).toEqual(['early', 'late']);
    expect(await db.listDueWebhookDeliveries(tenantId, at(-1000))).toEqual([]);
  });

  it('claims a due delivery once: the lease moves nextAttemptAt, so a second claim and the due list skip it', async () => {
    const db = getDb();
    const ep = await db.createWebhookEndpoint(endpoint());
    const now = new Date();
    const [due, notDue, delivered] = await db.createWebhookDeliveries([
      delivery(String(ep._id), { nextAttemptAt: new Date(now.getTime() - 1000) }),
      delivery(String(ep._id), { nextAttemptAt: new Date(now.getTime() + 60_000) }),
      delivery(String(ep._id), { status: 'delivered', nextAttemptAt: new Date(now.getTime() - 1000) }),
    ]);
    const lease = new Date(now.getTime() + 120_000);

    const claimed = await db.claimWebhookDelivery(String(due._id), now, lease);
    expect(claimed?._id && String(claimed._id)).toBe(String(due._id));
    expect(iso(claimed?.nextAttemptAt)).toBe(lease.toISOString());
    expect(claimed?.status).toBe('pending');
    // Leased: nobody else gets it, and the sweep does not see it.
    expect(await db.claimWebhookDelivery(String(due._id), now, lease)).toBeNull();
    expect(await db.listDueWebhookDeliveries(tenantId, now)).toEqual([]);
    // Not due yet / already settled / unknown.
    expect(await db.claimWebhookDelivery(String(notDue._id), now, lease)).toBeNull();
    expect(await db.claimWebhookDelivery(String(delivered._id), now, lease)).toBeNull();
    expect(await db.claimWebhookDelivery('whd_missing', now, lease)).toBeNull();
    // When the lease runs out it is claimable (and due) again.
    expect((await db.listDueWebhookDeliveries(tenantId, new Date(lease.getTime() + 1))).map((d) => String(d._id)))
      .toEqual([String(notDue._id), String(due._id)]);
  });

  it('fails the pending deliveries of an endpoint and clears their next attempt; settled ones stay as they are', async () => {
    const db = getDb();
    const ep = await db.createWebhookEndpoint(endpoint());
    const other = await db.createWebhookEndpoint(endpoint());
    const [p1, p2, ok, theirs] = await db.createWebhookDeliveries([
      delivery(String(ep._id)),
      delivery(String(ep._id), { attempts: 2 }),
      delivery(String(ep._id), { status: 'delivered', nextAttemptAt: null }),
      delivery(String(other._id)),
    ]);

    expect(await db.failPendingWebhookDeliveries(String(ep._id), 'endpoint disabled')).toBe(2);
    for (const row of [p1, p2]) {
      const stored = await db.findWebhookDeliveryById(String(row._id));
      expect(stored).toMatchObject({ status: 'failed', lastError: 'endpoint disabled' });
      expect(stored?.nextAttemptAt ?? null).toBeNull();
    }
    expect((await db.findWebhookDeliveryById(String(ok._id)))?.status).toBe('delivered');
    expect((await db.findWebhookDeliveryById(String(theirs._id)))?.status).toBe('pending');
    expect(await db.failPendingWebhookDeliveries(String(ep._id), 'again')).toBe(0);
  });

  it('retention deletes settled deliveries older than the cutoff, in batches, and never a pending one', async () => {
    const db = getDb();
    const ep = await db.createWebhookEndpoint(endpoint());
    const old = new Date(Date.now() - 40 * 86_400_000);
    const recent = new Date(Date.now() - 1 * 86_400_000);
    const rows = await db.createWebhookDeliveries([
      delivery(String(ep._id), { eventId: 'old-delivered', status: 'delivered', nextAttemptAt: null, createdAt: old }),
      delivery(String(ep._id), { eventId: 'old-failed', status: 'failed', nextAttemptAt: null, createdAt: old }),
      delivery(String(ep._id), { eventId: 'old-failed-2', status: 'failed', nextAttemptAt: null, createdAt: old }),
      delivery(String(ep._id), { eventId: 'old-pending', status: 'pending', createdAt: old }),
      delivery(String(ep._id), { eventId: 'recent-delivered', status: 'delivered', nextAttemptAt: null, createdAt: recent }),
    ]);
    const cutoff = new Date(Date.now() - 30 * 86_400_000);

    expect((await db.cleanupWebhookDeliveryRetention({ olderThan: cutoff, batchSize: 2 })).deletedCount).toBe(2);
    expect((await db.cleanupWebhookDeliveryRetention({ olderThan: cutoff, batchSize: 2 })).deletedCount).toBe(1);
    expect((await db.cleanupWebhookDeliveryRetention({ olderThan: cutoff })).deletedCount).toBe(0);

    const left = (await db.listWebhookDeliveries(String(ep._id))).map((d) => d.eventId).sort();
    expect(left).toEqual(['old-pending', 'recent-delivered']);
    void rows;
  });

  it('deleting an endpoint deletes its deliveries and nothing else', async () => {
    const db = getDb();
    const ep = await db.createWebhookEndpoint(endpoint());
    const keep = await db.createWebhookEndpoint(endpoint());
    await db.createWebhookDeliveries([delivery(String(ep._id)), delivery(String(keep._id))]);

    expect(await db.deleteWebhookEndpoint(String(ep._id))).toBe(true);
    expect(await db.findWebhookEndpointById(String(ep._id))).toBeNull();
    expect(await db.listWebhookDeliveries(String(ep._id))).toEqual([]);
    expect((await db.listWebhookDeliveries(String(keep._id))).length).toBe(1);
    expect(await db.deleteWebhookEndpoint(String(ep._id))).toBe(false);
  });

  // ── Conversation files ────────────────────────────────────────────────

  const file = (overrides: Partial<Omit<IFileRecord, '_id' | 'createdAt' | 'updatedAt'>> = {}) => ({
    tenantId,
    projectId,
    providerKey: 'builtin-files',
    bucketKey: 'conversation-files',
    key: `conversations/${Math.random().toString(36).slice(2, 10)}/a.txt`,
    name: 'a.txt',
    size: 10,
    contentType: 'text/plain',
    markdownStatus: 'pending' as const,
    purpose: 'conversation' as const,
    conversationId: 'conv-1',
    agentKey,
    expiresAt: new Date(Date.now() + 86_400_000),
    uploadedBy: 'u1',
    createdBy: 'u1',
    ...overrides,
  });

  it('keeps the conversation fields of a file record', async () => {
    const db = getDb();
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    const created = await db.createFileRecord(file({ expiresAt, conversationId: 'conv-x' }));
    const [found] = await db.listFileRecordsByConversation('conv-x');
    expect(String(found._id)).toBe(String(created._id));
    expect(found).toMatchObject({ purpose: 'conversation', conversationId: 'conv-x', agentKey, uploadedBy: 'u1', name: 'a.txt' });
    expect(iso(found.expiresAt)).toBe(expiresAt.toISOString());
  });

  it('lists a conversation\'s files in the order they were uploaded, and only that conversation\'s', async () => {
    const db = getDb();
    const names = ['zeta.txt', 'alpha.txt', 'mid.txt', 'beta.txt', 'omega.txt', 'gamma.txt'];
    for (const name of names) {
      await db.createFileRecord(file({ name, key: `k/${name}` }));
      await tick();
    }
    await db.createFileRecord(file({ name: 'elsewhere.txt', conversationId: 'conv-2' }));
    await db.createFileRecord(file({ name: 'plain.txt', purpose: undefined, conversationId: undefined, expiresAt: undefined }));

    expect((await db.listFileRecordsByConversation('conv-1')).map((f) => f.name)).toEqual(names);
    expect((await db.listFileRecordsByConversation('conv-2')).map((f) => f.name)).toEqual(['elsewhere.txt']);
    expect(await db.listFileRecordsByConversation('conv-none')).toEqual([]);
  });

  it('lists expired conversation files, soonest expiry first, up to the limit — and no other file', async () => {
    const db = getDb();
    const now = Date.now();
    const at = (seconds: number) => new Date(now + seconds * 1000);
    await db.createFileRecord(file({ name: 'expired-b', expiresAt: at(-100) }));
    await db.createFileRecord(file({ name: 'expired-a', expiresAt: at(-500) }));
    await db.createFileRecord(file({ name: 'expired-c', expiresAt: at(-10), conversationId: 'conv-2' }));
    await db.createFileRecord(file({ name: 'live', expiresAt: at(500) }));
    await db.createFileRecord(file({ name: 'no-expiry', expiresAt: undefined }));
    // An expired file that is not a conversation file belongs to someone else's retention.
    await db.createFileRecord(file({ name: 'plain-expired', purpose: undefined, conversationId: undefined, expiresAt: at(-500) }));

    expect((await db.listExpiredConversationFiles(new Date(now), 10)).map((f) => f.name)).toEqual(['expired-a', 'expired-b', 'expired-c']);
    expect((await db.listExpiredConversationFiles(new Date(now), 2)).map((f) => f.name)).toEqual(['expired-a', 'expired-b']);
    expect(await db.listExpiredConversationFiles(new Date(now - 10_000_000), 10)).toEqual([]);
  });

  it('the retention sweep and the session listing agree after a delete', async () => {
    const db = getDb();
    const a = await db.createFileRecord(file({ name: 'a', expiresAt: new Date(Date.now() - 1000) }));
    await tick();
    await db.createFileRecord(file({ name: 'b', expiresAt: new Date(Date.now() - 500) }));
    expect(await db.deleteFileRecord(String(a._id))).toBe(true);
    expect((await db.listFileRecordsByConversation('conv-1')).map((f) => f.name)).toEqual(['b']);
    expect((await db.listExpiredConversationFiles(new Date(), 10)).map((f) => f.name)).toEqual(['b']);
  });

  // ── IAgentRun.attachments ─────────────────────────────────────────────

  const run = (conversationId: string, overrides: Record<string, unknown> = {}) => ({
    mode: 'background' as const,
    tenantId,
    tenantDbName: dbName,
    projectId,
    agentKey,
    conversationId,
    userMessage: 'read these',
    status: 'queued' as const,
    ...overrides,
  });

  it('carries the attachment ids of a run through create, read, claim and finalize', async () => {
    const db = getDb();
    const created = await db.createAgentRun(run('c-att', { attachments: ['file-1', 'file-2'] }));
    expect(created.attachments).toEqual(['file-1', 'file-2']);

    const read = await db.getAgentRunById(String(created._id), tenantId, projectId);
    expect(read?.attachments).toEqual(['file-1', 'file-2']);
    const claimed = await db.claimAgentRun(String(created._id), tenantId, 'w1', new Date());
    expect(claimed?.attachments).toEqual(['file-1', 'file-2']);
    const done = await db.finalizeAgentRun(String(created._id), tenantId, { status: 'succeeded', completedAt: new Date() });
    expect(done?.attachments).toEqual(['file-1', 'file-2']);
  });

  it('a run without attachments (or with an empty list) reads back with none, the same way on both providers', async () => {
    const db = getDb();
    const none = await db.createAgentRun(run('c-none'));
    const empty = await db.createAgentRun(run('c-empty', { attachments: [] }));
    const explicitNull = await db.createAgentRun(run('c-null', { attachments: null }));
    for (const created of [none, empty, explicitNull]) {
      const read = await db.getAgentRunById(String(created._id), tenantId, projectId);
      expect(read?.attachments ?? null).toBeNull();
    }
  });

  // ── Indexes (MongoDB) ─────────────────────────────────────────────────

  it('every new query is served by an index (MongoDB: IXSCAN, never COLLSCAN)', async () => {
    const db = getDb();
    if (!(db instanceof MongoDBProvider)) return;
    const tenantDb = (db as unknown as { getTenantDb(): import('mongodb').Db }).getTenantDb();

    const ep = await db.createWebhookEndpoint(endpoint());
    await db.createWebhookDeliveries([delivery(String(ep._id))]);
    await db.createFileRecord(file());
    await db.createAgentPendingActions([{
      tenantId, projectId, agentKey, conversationId: 'c1', kind: 'tool_approval', sdkId: 's', status: 'pending', requestedAt: new Date(),
    }]);
    await db.createAgentRun(run('c-idx'));
    await db.appendAgentSessionEvents([{
      tenantId, projectId, agentKey, conversationId: 'c1', seq: 1, type: 'user.message', data: {}, createdAt: new Date(), expiresAt: new Date(Date.now() + 1000),
    }]);

    const planOf = async (collection: string, filter: Record<string, unknown>, sort?: Record<string, 1 | -1>) => {
      let cursor = tenantDb.collection(collection).find(filter);
      if (sort) cursor = cursor.sort(sort);
      return JSON.stringify(await cursor.explain('queryPlanner'));
    };
    const now = new Date();
    const queries: Array<[string, string, Record<string, unknown>, Record<string, 1 | -1>?]> = [
      ['endpoints by tenant', 'webhook_endpoints', { tenantId }],
      ['endpoints by tenant and project scopes', 'webhook_endpoints', { tenantId, projectId: { $in: ['p1', null] } }],
      ['due deliveries', 'webhook_deliveries', { tenantId, status: 'pending', nextAttemptAt: { $lte: now } }, { nextAttemptAt: 1 }],
      ['deliveries of an endpoint', 'webhook_deliveries', { endpointId: 'x' }, { createdAt: -1 }],
      ['pending deliveries of an endpoint', 'webhook_deliveries', { endpointId: 'x', status: 'pending' }],
      ['deliveries by event id', 'webhook_deliveries', { tenantId, eventId: 'evt' }],
      ['delivery retention', 'webhook_deliveries', { status: { $in: ['delivered', 'failed'] }, createdAt: { $lt: now } }],
      ['conversation files', 'files', { conversationId: 'conv-1' }],
      ['expired conversation files', 'files', { purpose: 'conversation', expiresAt: { $lt: now } }, { expiresAt: 1 }],
      ['pending actions of a conversation', 'agent_pending_actions', { conversationId: 'c1', status: 'pending' }],
      ['expired pending actions', 'agent_pending_actions', { status: 'pending', expiresAt: { $lt: now } }, { expiresAt: 1 }],
      ['pending actions of a project', 'agent_pending_actions', { tenantId, projectId, status: 'pending' }],
      ['session events retention', 'agent_session_events', { expiresAt: { $lt: now } }],
      ['undelivered run callbacks', 'agent_runs', {
        tenantId, callbackUrl: { $nin: [null, ''] }, callbackStatus: { $in: ['pending', 'failed'] }, updatedAt: { $lt: now },
      }, { updatedAt: 1 }],
    ];
    for (const [label, collection, filter, sort] of queries) {
      const plan = await planOf(collection, filter, sort);
      expect(plan, `${label} should use an index`).toContain('IXSCAN');
      expect(plan, `${label} should not scan the collection`).not.toContain('COLLSCAN');
    }
  });
});
