/**
 * The "Activity" of a person in the Authorization center (lib/iam/activity.ts and GET /api/iam/principals/user/:id/activity),
 * on BOTH SQLite and MongoDB: the rollup by service with the application tokens the calls came through, and the audit rows the
 * person is the subject of - including the calls an application made FOR them, which name the issuer that vouched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import type { DatabaseProvider, IUser } from '@/lib/database';
import { ACTIVITY_MAX_DAYS, getPersonActivity } from '@/lib/iam/activity';
import { iamDirectoryApiPlugin } from '@/server/api/plugins/iam-directory';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from './db-parity.helper';

const ISSUER = 'https://idp.bank.example/realms/retail';
const dayAgo = (days: number): string => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describeForEachProvider('activity of a person', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  let owner: IUser;
  let alice: IUser;
  let bob: IUser;
  let appTokenId: string;
  let otherTokenId: string;
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  const run = <T,>(fn: () => Promise<T>): Promise<T> => db.runWithTenant!(tenantDbName, fn);

  const usage = (user: IUser, extra: Record<string, unknown>) => ({
    tenantId, projectId: 'p1', userId: String(user._id), apiTokenId: '', actorType: 'user', source: 'dashboard', service: 'models', refKey: 'chat-alpha',
    day: dayAgo(1), requests: 1, errors: 0, totalTokens: 0, costUsd: 0, ...extra,
  });

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    tenantDbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: 'Activity', slug, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await run(async () => {
      const mk = (email: string, name: string, role: 'owner' | 'user') =>
        db.createUser({ tenantId, email, name, password: 'x', role, licenseId: 'FREE', features: [] });
      owner = await mk('owner@act.example', 'Owner', 'owner');
      alice = await mk('alice@act.example', 'Alice', 'user');
      bob = await mk('bob@act.example', 'Bob', 'user');
      const project = await db.createProject({ tenantId, key: 'default', name: 'Default', createdBy: 'x' });
      const token = (label: string) => db.createApiToken({
        label, projectId: String(project._id), tenantId, tokenHash: `hash-${label}`, tokenPrefix: `cpeer_${label}`, userId: String(owner._id), servicePermissions: null,
      } as never);
      appTokenId = String((await token('portal-backend'))._id);
      otherTokenId = String((await token('cron-job'))._id);

      await db.incrementUsageDaily([
        // alice herself in the dashboard, and through two application tokens
        usage(alice, { service: 'models', requests: 5, errors: 1, totalTokens: 500, costUsd: 0.25, day: dayAgo(3) }),
        usage(alice, { service: 'models', requests: 10, errors: 0, totalTokens: 1000, costUsd: 0.5, day: dayAgo(1), apiTokenId: appTokenId, actorType: 'api_token', source: 'api' }),
        usage(alice, { service: 'models', requests: 2, totalTokens: 50, costUsd: 0.01, day: dayAgo(1), apiTokenId: otherTokenId, actorType: 'api_token', source: 'api', refKey: 'chat-beta' }),
        usage(alice, { service: 'rag', requests: 7, errors: 2, day: dayAgo(2), apiTokenId: appTokenId, actorType: 'api_token', source: 'api', refKey: 'kb' }),
        // outside the window
        usage(alice, { service: 'tools', requests: 99, day: dayAgo(200) }),
        // somebody else
        usage(bob, { service: 'models', requests: 1000, totalTokens: 9999 }),
      ] as never);

      const audit = (user: IUser, extra: Record<string, unknown>) => db.createAuditLog({
        tenantId, actorType: 'user', actorUserId: String(user._id), actorEmail: user.email, service: 'models', action: 'write',
        event: 'POST /api/models', method: 'POST', path: '/api/models', outcome: 'success', statusCode: 200, ...extra,
      } as never);
      await audit(alice, { event: 'PATCH /api/prompts/x', method: 'PATCH', path: '/api/prompts/x', service: 'prompts' });
      await audit(alice, {
        actorType: 'api_token', apiTokenId: appTokenId, event: 'POST /api/client/v1/chat/completions', method: 'POST', path: '/api/client/v1/chat/completions',
        metadata: { via: { kind: 'delegated', issuer: ISSUER } },
      });
      await audit(alice, { outcome: 'denied', statusCode: 403, event: 'POST /api/agents', method: 'POST', path: '/api/agents', service: 'agents', metadata: { iamEnforce: true, decisionId: 'dec-1' } });
      await audit(bob, { event: 'POST /api/models/bob', path: '/api/models/bob' });
    });

    app = await createFastifyApiTestApp(iamDirectoryApiPlugin);
    await app.ready();
  });
  afterAll(async () => {
    hoisted.getDatabase.mockReset();
    await app?.close();
  });

  it('adds the rollup up by service, with the application tokens the calls came through', async () => {
    const result = await getPersonActivity({ tenantDbName, tenantId }, String(alice._id));
    expect(result).not.toBeNull();
    expect(result!.windowDays).toBe(30);
    expect(result!.usageTruncated).toBe(false);
    const byService = Object.fromEntries(result!.usage.map((row) => [row.service, row]));
    // the 200-day-old tools row is outside the window, and bob's row is bob's
    expect(Object.keys(byService).sort()).toEqual(['models', 'rag']);
    expect(byService.models).toMatchObject({ requests: 17, errors: 1, totalTokens: 1550, lastDay: dayAgo(1) });
    expect(byService.models.costUsd).toBeCloseTo(0.76, 6);
    expect(byService.models.viaTokens).toEqual([
      { id: appTokenId, label: 'portal-backend', requests: 10 },
      { id: otherTokenId, label: 'cron-job', requests: 2 },
    ]);
    expect(byService.rag).toMatchObject({ requests: 7, errors: 2, viaTokens: [{ id: appTokenId, label: 'portal-backend', requests: 7 }] });
    // busiest first
    expect(result!.usage.map((row) => row.service)).toEqual(['models', 'rag']);
  });

  it('lists the rows the person is the subject of, newest first, naming the application token and the issuer', async () => {
    const result = await getPersonActivity({ tenantDbName, tenantId }, String(alice._id));
    const events = result!.events;
    expect(events.map((event) => event.event).sort()).toEqual(['PATCH /api/prompts/x', 'POST /api/agents', 'POST /api/client/v1/chat/completions']);
    const viaApp = events.find((event) => event.path === '/api/client/v1/chat/completions');
    expect(viaApp).toMatchObject({
      method: 'POST', service: 'models', outcome: 'success', statusCode: 200,
      viaToken: { id: appTokenId, label: 'portal-backend' }, via: { kind: 'delegated', issuer: ISSUER },
    });
    const own = events.find((event) => event.path === '/api/prompts/x');
    expect(own?.viaToken).toBeUndefined();
    expect(own?.via).toBeUndefined();
    expect(events.find((event) => event.path === '/api/agents')).toMatchObject({ outcome: 'denied', statusCode: 403, decisionId: 'dec-1' });
    // nothing of bob's
    expect(events.some((event) => event.path === '/api/models/bob')).toBe(false);
    // newest first
    const times = events.map((event) => Date.parse(event.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('bounds the window and the page, and says when there is more', async () => {
    const page = await getPersonActivity({ tenantDbName, tenantId }, String(alice._id), { eventLimit: 2 });
    expect(page!.events).toHaveLength(2);
    expect(page!.hasMoreEvents).toBe(true);
    const wide = await getPersonActivity({ tenantDbName, tenantId }, String(alice._id), { days: 1000 });
    expect(wide!.windowDays).toBe(ACTIVITY_MAX_DAYS);
    const week = await getPersonActivity({ tenantDbName, tenantId }, String(alice._id), { days: 1 });
    expect(week!.usage.find((row) => row.service === 'rag')).toBeUndefined();
    expect(week!.usage.find((row) => row.service === 'models')).toMatchObject({ requests: 12 });
  });

  it('is empty for somebody who did nothing, and nothing for somebody who does not exist or belongs to another workspace', async () => {
    const quiet = await getPersonActivity({ tenantDbName, tenantId }, String(owner._id));
    expect(quiet).toMatchObject({ usage: [], events: [], hasMoreEvents: false });
    expect(await getPersonActivity({ tenantDbName, tenantId }, '0123456789abcdef01234567')).toBeNull();
    expect(await getPersonActivity({ tenantDbName, tenantId }, 'not-an-id')).toBeNull();
    expect(await getPersonActivity({ tenantDbName, tenantId: 'another-workspace' }, String(alice._id))).toBeNull();
  });

  describe('the route', () => {
    const headers = (user: IUser) => ({
      'x-tenant-db-name': tenantDbName,
      'x-tenant-id': tenantId,
      'x-tenant-slug': 'act',
      'x-user-id': String(user._id),
      'x-user-role': String(user.role),
      'x-user-email': String(user.email),
      'x-license-type': 'FREE',
    });
    const get = (url: string, user: IUser) => app.inject({ method: 'GET', url, headers: headers(user) });

    it('answers the owner, and 404 for nobody', async () => {
      const ok = await get(`/api/iam/principals/user/${String(alice._id)}/activity?days=7&limit=5`, owner);
      expect(ok.statusCode, ok.body).toBe(200);
      const body = parseJsonBody<any>(ok.body);
      expect(body.windowDays).toBe(7);
      expect(body.usage.find((row: any) => row.service === 'models')).toMatchObject({ requests: 17 });
      expect(body.events.length).toBeLessThanOrEqual(5);
      expect((await get('/api/iam/principals/user/0123456789abcdef01234567/activity', owner)).statusCode).toBe(404);
      expect((await get('/api/iam/principals/user/not%20an%20id/activity', owner)).statusCode).toBe(404);
    });

    it('is closed to somebody without access to the Authorization center', async () => {
      const refused = await get(`/api/iam/principals/user/${String(alice._id)}/activity`, bob);
      expect(refused.statusCode).toBe(403);
    });
  });
});
