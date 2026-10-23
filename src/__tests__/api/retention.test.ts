/**
 * `/api/retention`: the settings payload, policy save / preview / pending cancel,
 * and the "clean now" purge (preview, typed confirmation, conflict, status, cancel).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({
  db: null as unknown,
  requestPurge: vi.fn(),
  getPurgeStatus: vi.fn(),
  cancelPurge: vi.fn(),
  getLastSweep: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/retention/scheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/retention/scheduler')>();
  return {
    ...actual,
    requestPurge: h.requestPurge,
    getPurgeStatus: h.getPurgeStatus,
    cancelPurge: h.cancelPurge,
    getLastSweep: h.getLastSweep,
  };
});

import { RetentionPurgeConflictError } from '@/lib/retention/scheduler';
import { retentionApiPlugin } from '@/server/api/plugins/retention';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const TENANT = 'tenant-1';
const headers = {
  'x-license-type': 'ENTERPRISE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': TENANT,
  'x-tenant-slug': 'acme',
  'x-user-email': 'owner@acme.test',
  'x-user-id': 'owner-1',
  'x-user-role': 'owner',
};

describe('/api/retention', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: MockDb;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    h.db = db;
    db.findUserById.mockResolvedValue({ _id: 'owner-1', role: 'owner', tenantId: TENANT } as never);
    h.getPurgeStatus.mockResolvedValue(null);
    h.getLastSweep.mockResolvedValue(null);
    // The production JSON parser: handlers get the raw string.
    app = await createFastifyApiTestApp(retentionApiPlugin, { rawJsonBody: true });
  });
  afterEach(async () => {
    await app.close();
  });

  it('GET /api/retention returns classes with their source, every target and legacy entry, and engine state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/retention', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engine).toMatchObject({ dryRun: true, enabled: true });
    expect(body.workspace).toEqual({ slug: 'acme' });
    expect(body.policy.preset).toBe('standard');
    expect(body.classes.find((c: { id: string }) => c.id === 'content')).toMatchObject({ days: 30, source: 'default', editable: true, action: 'redact' });
    expect(body.classes.find((c: { id: string }) => c.id === 'delivery')).toMatchObject({ editable: false });
    expect(body.targets.find((t: { id: string }) => t.id === 'model_usage_logs').phases).toEqual([
      { class: 'telemetry', action: 'delete', days: 90, fixed: false },
      { class: 'content', action: 'redact', days: 30, fixed: false },
    ]);
    expect(body.targets.find((t: { id: string }) => t.id === 'retention_records').phases[0]).toMatchObject({ days: 1095, fixed: true });
    for (const legacy of body.legacy) expect(legacy.days, legacy.id).toBeGreaterThan(0);
    expect(body.presets.standard.content).toBe(30);
  });

  it('PUT /api/retention/policy saves a valid policy and rejects an invalid one', async () => {
    const ok = await app.inject({ method: 'PUT', url: '/api/retention/policy', headers, payload: { preset: 'custom', classes: { telemetry: 180 } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().policy.classes).toEqual({ telemetry: 180 });
    expect(db.iamDocPut).toHaveBeenCalledWith('retention_policies', 'tenant', expect.objectContaining({ updatedBy: 'owner@acme.test' }));

    const bad = await app.inject({ method: 'PUT', url: '/api/retention/policy', headers, payload: { classes: { content: 500 } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details[0].field).toBe('classes.content');

    const malformed = await app.inject({ method: 'PUT', url: '/api/retention/policy', headers: { ...headers, 'content-type': 'application/json' }, payload: '{"preset":' });
    expect(malformed.statusCode).toBe(400);
  });

  it('DELETE /api/retention/policy/pending drops a waiting shortening', async () => {
    db.iamDocGet.mockResolvedValue({
      id: 'tenant',
      updatedAt: new Date(),
      data: {
        preset: 'custom', classes: { telemetry: 90 }, projects: {}, version: 1,
        pending: { preset: 'custom', classes: { telemetry: 30 }, projects: {}, effectiveAt: '2999-01-01T00:00:00.000Z', requestedBy: null },
      },
    });
    const res = await app.inject({ method: 'DELETE', url: '/api/retention/policy/pending', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy.pending).toBeNull();
  });

  it('POST /api/retention/policy/preview counts what a draft would touch', async () => {
    db.retentionCount.mockResolvedValue(3);
    db.retentionCountRedactable.mockResolvedValue(2);
    const res = await app.inject({ method: 'POST', url: '/api/retention/policy/preview', headers, payload: { preset: 'minimal' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deleted).toBeGreaterThan(0);
    expect(body.byClass.content.redacted).toBeGreaterThan(0);
    expect(body.targets.length).toBeGreaterThan(10);
  });

  it('POST /api/retention/purge/preview validates the request and counts', async () => {
    db.retentionCount.mockResolvedValue(1);
    const res = await app.inject({ method: 'POST', url: '/api/retention/purge/preview', headers, payload: { mode: 'olderThan', days: 7, classes: ['telemetry'] } });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().byClass)).toEqual(['telemetry']);

    const bad = await app.inject({ method: 'POST', url: '/api/retention/purge/preview', headers, payload: { mode: 'olderThan', days: -1 } });
    expect(bad.statusCode).toBe(400);
    const badClass = await app.inject({ method: 'POST', url: '/api/retention/purge/preview', headers, payload: { mode: 'policy', classes: ['delivery'] } });
    expect(badClass.statusCode).toBe(400);
  });

  it('POST /api/retention/purge needs the workspace slug typed, starts with 202 and refuses a second one', async () => {
    const unconfirmed = await app.inject({ method: 'POST', url: '/api/retention/purge', headers, payload: { mode: 'policy' } });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().code).toBe('confirmation_required');
    expect(h.requestPurge).not.toHaveBeenCalled();

    h.requestPurge.mockResolvedValueOnce({ id: 'p1', state: 'queued' });
    const started = await app.inject({ method: 'POST', url: '/api/retention/purge', headers, payload: { mode: 'olderThan', days: 30, confirm: 'acme' } });
    expect(started.statusCode).toBe(202);
    expect(h.requestPurge).toHaveBeenCalledWith(
      { tenantDbName: 'tenant_acme', tenantId: TENANT, tenantSlug: 'acme' },
      { mode: { kind: 'olderThan', days: 30 } },
      'owner@acme.test',
      expect.any(Number),
    );

    h.requestPurge.mockRejectedValueOnce(new RetentionPurgeConflictError());
    const again = await app.inject({ method: 'POST', url: '/api/retention/purge', headers, payload: { mode: 'policy', confirm: 'acme' } });
    expect(again.statusCode).toBe(409);
  });

  it('GET and DELETE /api/retention/purge report and cancel the running purge', async () => {
    h.getPurgeStatus.mockResolvedValue({ id: 'p1', state: 'running', deleted: 10 });
    const status = await app.inject({ method: 'GET', url: '/api/retention/purge', headers });
    expect(status.statusCode).toBe(200);
    expect(status.json().purge).toMatchObject({ id: 'p1', state: 'running' });

    h.cancelPurge.mockResolvedValue({ id: 'p1', state: 'running' });
    const cancel = await app.inject({ method: 'DELETE', url: '/api/retention/purge', headers });
    expect(cancel.statusCode).toBe(200);
    expect(h.cancelPurge).toHaveBeenCalledWith('tenant_acme');
  });

  it('GET /api/retention/runs lists the destruction records', async () => {
    db.listAuditLogs.mockResolvedValue([{ _id: 'a1', service: 'retention', event: 'retention.sweep' } as never]);
    const res = await app.inject({ method: 'GET', url: '/api/retention/runs?limit=10', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toEqual([expect.objectContaining({ id: 'a1', event: 'retention.sweep' })]);
    expect(db.listAuditLogs).toHaveBeenCalledWith(expect.objectContaining({ service: 'retention', limit: 10 }));
  });
});
