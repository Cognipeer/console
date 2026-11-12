/**
 * GET /api/guardrails/:id/evaluations — the evaluation log of one guardrail.
 *
 * Real SQLite and the live Fastify plugin; only the provider reads behind the
 * route are stubbed, so the assertions are about what the route asks for and
 * what it answers: the project scope, the paging clamp and the passed filter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-guardrail-evals-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'guardrail_evals_main';

const ACTIVE_PROJECT_ID = 'project-active';
const OTHER_PROJECT_ID = 'project-other';

vi.mock('@/lib/services/projects/projectContext', () => ({
  ProjectContextError: class extends Error {
    status = 400;
  },
  resolveProjectContext: vi.fn(async (ctx: { tenantId: string; userId: string }) => ({
    projectId: ACTIVE_PROJECT_ID,
    project: { _id: ACTIVE_PROJECT_ID, tenantId: ctx.tenantId, name: 'Active', key: 'active', status: 'active' },
    user: { _id: ctx.userId, tenantId: ctx.tenantId, email: 'owner@example.com', role: 'owner', status: 'active' },
    userProject: null,
  })),
  requireProjectContext: vi.fn(),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider } from '@/lib/database';
import { guardrailsApiPlugin } from '@/server/api/plugins/guardrails';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'guardrail_evals_tenant';
const TENANT_ID = 'tenant-guardrail-evals';
const HEADERS: Record<string, string> = {
  'x-tenant-db-name': TENANT_DB_NAME,
  'x-tenant-id': TENANT_ID,
  'x-tenant-slug': 'evals',
  'x-user-id': 'pending',
  'x-user-email': 'owner@example.com',
  'x-user-role': 'owner',
  'x-license-type': 'FREE',
};

const now = new Date();
const guardrailRecord = (projectId: string | undefined) => ({
  _id: 'gr-1',
  tenantId: TENANT_ID,
  ...(projectId ? { projectId } : {}),
  key: 'gr-key',
  name: 'Guardrail',
  type: 'preset',
  target: 'input',
  action: 'block',
  enabled: true,
  policy: {},
  createdAt: now,
  updatedAt: now,
});

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let db: DatabaseProvider;
let listLogs: ReturnType<typeof vi.fn>;
let aggregate: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  await db.createTenant({ companyName: 'Evals', slug: 'evals', dbName: TENANT_DB_NAME, licenseType: 'FREE', ownerId: 'pending' });
  await db.switchToTenant(TENANT_DB_NAME);
  const owner = await db.createUser({
    tenantId: TENANT_ID, email: 'owner@example.com', name: 'Owner', password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [],
  });
  HEADERS['x-user-id'] = String(owner._id);
  app = await createFastifyApiTestApp(guardrailsApiPlugin);
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function stubProvider(record: Record<string, unknown> | null) {
  listLogs = vi.fn().mockResolvedValue([{ id: 'log-1', passed: false }]);
  aggregate = vi.fn().mockResolvedValue([{ bucket: '2026-11-01', total: 1 }]);
  vi.spyOn(db, 'findGuardrailById').mockResolvedValue(record as never);
  vi.spyOn(db, 'listGuardrailEvaluationLogs').mockImplementation(listLogs as never);
  vi.spyOn(db, 'aggregateGuardrailEvaluations').mockImplementation(aggregate as never);
}

const get = (query = '') => app.inject({ method: 'GET', url: `/api/guardrails/gr-1/evaluations${query}`, headers: HEADERS });

describe('GET /api/guardrails/:id/evaluations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('answers 404 for a guardrail of another project and reads no log', async () => {
    stubProvider(guardrailRecord(OTHER_PROJECT_ID));
    const res = await get();
    expect(res.statusCode, res.body).toBe(404);
    expect(listLogs).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('answers the logs and their aggregate for a guardrail of the active project', async () => {
    stubProvider(guardrailRecord(ACTIVE_PROJECT_ID));
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    expect(parseJsonBody<{ logs: unknown[]; aggregate: unknown[] }>(res.body)).toEqual({
      logs: [{ id: 'log-1', passed: false }],
      aggregate: [{ bucket: '2026-11-01', total: 1 }],
    });
    expect(listLogs).toHaveBeenCalledWith('gr-1', expect.objectContaining({ limit: 50, skip: 0 }));
    expect(aggregate).toHaveBeenCalledWith('gr-1', expect.objectContaining({ groupBy: 'day' }));
  });

  it('clamps the page size to 200 and passes the paging and the passed filter on', async () => {
    stubProvider(guardrailRecord(undefined));
    const res = await get('?limit=500&skip=20&passed=false&groupBy=hour');
    expect(res.statusCode, res.body).toBe(200);
    expect(listLogs).toHaveBeenCalledWith('gr-1', expect.objectContaining({ limit: 200, skip: 20, passed: false }));
    expect(aggregate).toHaveBeenCalledWith('gr-1', expect.objectContaining({ groupBy: 'hour' }));
  });
});
