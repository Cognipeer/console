/**
 * The whole API wired together - the global session / token hook, every community
 * plugin, the permission gates and the audit hook (fastifyApiPlugin) - over a REAL
 * SQLite database and the REAL engine, with nothing mocked but the boot flag. The
 * engine is the only decision path, so this is the tour that shows the pieces still
 * fit: cookie sessions, API tokens, the Authorization center, the denial trail.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + tmp dir BEFORE getDatabase() is imported.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-engine-smoke-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'engine_smoke_main';

vi.mock('@/server/bootstrap', () => ({ isApplicationReady: () => true }));

import type { FastifyInstance } from 'fastify';
import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type IUser } from '@/lib/database';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { TokenManager } from '@/lib/license/token-manager';
import { hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import { fastifyApiPlugin } from '@/server/api/plugin';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB = 'tenant_engine_smoke';
const SECRET = 'cpeer_smoke_secret_value_0123456789';

let app: FastifyInstance;
let tenantId: string;
let owner: IUser;
let member: IUser;
let memberCookie: string;
let ownerCookie: string;

async function cookieFor(user: IUser): Promise<string> {
  const token = await TokenManager.generateToken({
    userId: String(user._id),
    email: user.email,
    tenantId,
    tenantSlug: 'engine-smoke',
    tenantDbName: TENANT_DB,
    role: user.role as 'owner' | 'user',
    licenseId: 'FREE',
    licenseType: 'FREE',
    features: [],
  });
  return `token=${token}`;
}

const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const tenant = await db.createTenant({ companyName: 'Smoke', slug: 'engine-smoke', dbName: TENANT_DB, licenseType: 'FREE', ownerId: 'pending' });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB);
  owner = await db.createUser({ tenantId, email: 'owner@smoke.example', name: 'Owner', password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [] });
  member = await db.createUser({ tenantId, email: 'member@smoke.example', name: 'Member', password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [] });
  const project = await db.createProject({ tenantId, key: 'default', name: 'Default', createdBy: String(owner._id) });
  await db.upsertUserProject({ tenantId, userId: String(member._id), projectId: String(project._id), role: 'member' } as never);
  await db.createApiToken({
    tenantId,
    userId: String(member._id),
    projectId: String(project._id),
    label: 'member-token',
    tokenHash: hashApiToken(SECRET),
    tokenPrefix: SECRET.slice(0, 8),
    createdBy: String(member._id),
  } as never);

  ownerCookie = await cookieFor(owner);
  memberCookie = await cookieFor(member);
  app = await createFastifyApiTestApp(fastifyApiPlugin);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await drainPendingTasks();
  await app?.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the whole API with the engine as the only decision path', () => {
  it('refuses a request that carries no credentials before any gate runs', async () => {
    expect((await get('/api/projects', {})).statusCode).toBe(401);
    expect((await get('/api/client/v1/models', {})).statusCode).toBe(401);
    expect((await get('/api/health/live', {})).statusCode).toBe(200); // public
  });

  it('the owner\'s session reaches the dashboard and the Authorization center, and sees admin everywhere', async () => {
    const session = await get('/api/auth/session', { cookie: ownerCookie });
    expect(session.statusCode).toBe(200);
    const body = parseJsonBody<{ role: string; effectivePermissions: Record<string, string> | null }>(session.body);
    expect(body.role).toBe('owner');
    expect(Object.values(body.effectivePermissions ?? {}).every((level) => level === 'admin')).toBe(true);
    expect((await get('/api/projects', { cookie: ownerCookie })).statusCode).toBe(200);
    expect((await get('/api/iam/policies', { cookie: ownerCookie })).statusCode).toBe(200);
    const stats = await get('/api/iam/engine/stats', { cookie: ownerCookie });
    expect(stats.statusCode).toBe(200);
    expect(parseJsonBody<{ health: { status: string } }>(stats.body).health.status).toBe('ok');
  });

  it('a member works with the ordinary services and is refused the administration ones, with a decision to quote', async () => {
    const session = await get('/api/auth/session', { cookie: memberCookie });
    const levels = parseJsonBody<{ effectivePermissions: Record<string, string> }>(session.body).effectivePermissions;
    expect(levels).toMatchObject({ agents: 'write', models: 'write', members: 'none', iam: 'none' });
    expect((await get('/api/projects', { cookie: memberCookie })).statusCode).toBe(200);

    const refused = await get('/api/iam/policies', { cookie: memberCookie });
    expect(refused.statusCode).toBe(403);
    const body = parseJsonBody<Record<string, unknown>>(refused.body);
    expect(body).toMatchObject({ code: 'forbidden', service: 'iam', required: 'read', decisionId: expect.any(String) });
    expect(refused.headers['x-decision-id']).toBe(body.decisionId);
    expect((await get('/api/users', { cookie: memberCookie })).statusCode).toBe(403);
  });

  it('the refusal is audited and the owner finds it by its decision id', async () => {
    const refused = await get('/api/iam/policies', { cookie: memberCookie });
    const decisionId = parseJsonBody<{ decisionId: string }>(refused.body).decisionId;
    await drainPendingTasks();
    const decision = await get(`/api/iam/decisions/${decisionId}`, { cookie: ownerCookie });
    expect(decision.statusCode).toBe(200);
    expect(parseJsonBody<Record<string, unknown>>(decision.body)).toMatchObject({
      decisionId, service: 'iam', method: 'GET', route: '/api/iam/policies', code: 'forbidden',
      principal: { type: 'user', id: String(member._id) },
    });
  });

  it('an API token is decided as its owner: the same member, through the client API', async () => {
    const bearer = { authorization: `Bearer ${SECRET}` };
    // the Model Hub is an ordinary service: the member's token may read it
    expect((await get('/api/client/v1/models', bearer)).statusCode).toBe(200);
    // member management is an administration service: the member has no access, and neither does the token
    const refused = await get('/api/client/v1/members', bearer);
    expect(refused.statusCode).toBe(403);
    expect(parseJsonBody<Record<string, unknown>>(refused.body)).toMatchObject({ code: 'forbidden', service: 'members', decisionId: expect.any(String) });
    expect((await get('/api/client/v1/models', { authorization: 'Bearer cpeer_not_a_token' })).statusCode).toBe(401);
  });
});
