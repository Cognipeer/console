/**
 * A record addressed by id answers only in the active project, for an owner too.
 *
 * Owners and admins used to reach any project's agent, MCP server, guardrail, word list, PII
 * policy, OCR job or tool by id, whatever project was active. A detail page of project A stayed
 * open after switching to project B, and saving it ran B's checks (models, guardrails, buckets)
 * against A's record. Now the active project decides for every role; an owner reaches another
 * project by switching to it. A record stored without a project stays reachable from any.
 *
 * Real SQLite, the live Fastify plugins; only the by-id lookups are stubbed to hand back a record
 * of the project under test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-by-id-scope-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'by_id_scope_main';

const ACTIVE_PROJECT_ID = 'project-active';
const OTHER_PROJECT_ID = 'project-other';
let currentUserRole: 'owner' | 'admin' | 'member' = 'owner';

vi.mock('@/lib/services/projects/projectContext', () => ({
  ProjectContextError: class extends Error {
    status = 400;
  },
  resolveProjectContext: vi.fn(async (ctx: { tenantId: string; userId: string }) => ({
    projectId: ACTIVE_PROJECT_ID,
    project: { _id: ACTIVE_PROJECT_ID, tenantId: ctx.tenantId, name: 'Active', key: 'active', status: 'active' },
    user: { _id: ctx.userId, tenantId: ctx.tenantId, email: 'owner@example.com', role: currentUserRole, status: 'active' },
    userProject: null,
  })),
  requireProjectContext: vi.fn(),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider } from '@/lib/database';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { guardrailsApiPlugin } from '@/server/api/plugins/guardrails';
import { mcpApiPlugin } from '@/server/api/plugins/mcp';
import { ocrJobsApiPlugin } from '@/server/api/plugins/ocr-jobs';
import { piiApiPlugin } from '@/server/api/plugins/pii';
import { toolsApiPlugin } from '@/server/api/plugins/tools';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'by_id_scope_tenant';
const TENANT_ID = 'tenant-by-id-scope';
const HEADERS: Record<string, string> = {
  'x-tenant-db-name': TENANT_DB_NAME,
  'x-tenant-id': TENANT_ID,
  'x-tenant-slug': 'scope',
  'x-user-id': 'pending',
  'x-user-email': 'owner@example.com',
  'x-user-role': 'owner',
  'x-license-type': 'FREE',
};

const now = new Date();
const base = (projectId: string | undefined) => ({
  _id: 'rec-1',
  tenantId: TENANT_ID,
  ...(projectId ? { projectId } : {}),
  key: 'rec-key',
  name: 'Record',
  createdAt: now,
  updatedAt: now,
});

/** Each by-id route, the provider lookup behind it, and a record of the given project. */
const CASES: Array<{ name: string; url: string; finder: keyof DatabaseProvider; record: (projectId?: string) => Record<string, unknown> }> = [
  { name: 'agent', url: '/api/agents/rec-1', finder: 'findAgentById', record: (p) => ({ ...base(p), status: 'active', config: { kind: 'native', modelKey: 'm' } }) },
  { name: 'MCP server', url: '/api/mcp/rec-1', finder: 'findMcpServerById', record: (p) => ({ ...base(p), status: 'active', transport: 'http', tools: [] }) },
  { name: 'guardrail', url: '/api/guardrails/rec-1', finder: 'findGuardrailById', record: (p) => ({ ...base(p), type: 'preset', target: 'input', action: 'block', enabled: true, policy: {} }) },
  { name: 'PII policy', url: '/api/pii/policies/rec-1', finder: 'findPiiPolicyById', record: (p) => ({ ...base(p), enabled: true, rules: [] }) },
  { name: 'OCR job', url: '/api/ocr-jobs/rec-1', finder: 'findOcrJobById', record: (p) => ({ ...base(p), status: 'completed', items: [] }) },
  { name: 'tool', url: '/api/tools/rec-1', finder: 'findToolById', record: (p) => ({ ...base(p), type: 'openapi', status: 'active', actions: [] }) },
];

const allPlugins: FastifyPluginAsync = async (app) => {
  for (const plugin of [agentsApiPlugin, mcpApiPlugin, guardrailsApiPlugin, piiApiPlugin, ocrJobsApiPlugin, toolsApiPlugin]) {
    await app.register(plugin);
  }
};

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let db: DatabaseProvider;

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  await db.createTenant({ companyName: 'Scope', slug: 'scope', dbName: TENANT_DB_NAME, licenseType: 'FREE', ownerId: 'pending' });
  await db.switchToTenant(TENANT_DB_NAME);
  const owner = await db.createUser({
    tenantId: TENANT_ID, email: 'owner@example.com', name: 'Owner', password: '$2b$10$x', role: 'owner', licenseId: 'FREE', features: [],
  });
  HEADERS['x-user-id'] = String(owner._id);
  app = await createFastifyApiTestApp(allPlugins);
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function get(url: string, finder: keyof DatabaseProvider, record: Record<string, unknown>) {
  const lookups = db as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const spy = vi.spyOn(lookups, finder as string).mockResolvedValue(record);
  try {
    return await app.inject({ method: 'GET', url, headers: HEADERS });
  } finally {
    spy.mockRestore();
  }
}

describe.each(['owner', 'admin', 'member'] as const)('a record by id, as %s', (role) => {
  it.each(CASES)('$name of another project answers 404', async ({ url, finder, record }) => {
    currentUserRole = role;
    const res = await get(url, finder, record(OTHER_PROJECT_ID));
    expect(res.statusCode, res.body).toBe(404);
  });

  it.each(CASES)('$name of the active project is found', async ({ url, finder, record }) => {
    currentUserRole = role;
    const res = await get(url, finder, record(ACTIVE_PROJECT_ID));
    expect(res.statusCode, res.body).toBe(200);
  });

  it.each(CASES)('$name stored without a project is found', async ({ url, finder, record }) => {
    currentUserRole = role;
    const res = await get(url, finder, record(undefined));
    expect(res.statusCode, res.body).toBe(200);
  });
});
