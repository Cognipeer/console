/**
 * Whose queries the Knowledge Engine query log shows.
 *
 * The log keeps what people asked word for word. All of it is for those who
 * administer the module (`rag` admin); everyone else reads only the queries
 * they made, while the counters still count every query. Decided by the real
 * policy engine with real users, so a tenant admin, a `rag` admin grant and
 * plain members are told apart exactly as the gate would.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-query-log-scope-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'rag_query_log_scope_main';

// ragService pulls in to-markdown, whose file-type CJS import trips vitest's
// ESM resolver. These routes never convert a file.
vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => (typeof input === 'string' ? input : input.toString('utf8')),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider, type IUser } from '@/lib/database';
import { ragApiPlugin } from '@/server/api/plugins/rag';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'rag_query_log_scope_tenant';
const MODULE_KEY = 'kb';

let db: DatabaseProvider;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId = 'pending';
let projectA = 'pending';
const users = {} as Record<'admin' | 'kbAdmin' | 'member' | 'reader', IUser>;

type Who = keyof typeof users;

function headersOf(who: Who) {
  return {
    'x-tenant-db-name': TENANT_DB_NAME,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'rag-query-log-scope',
    'x-user-id': String(users[who]._id),
    'x-user-role': String(users[who].role),
    'x-user-email': String(users[who].email),
    'x-license-type': 'FREE',
    cookie: `active_project_id=${projectA}`,
  };
}

interface LogPage {
  logs: Array<{ query: string; userId?: string }>;
  scope: 'all' | 'own';
  total?: number;
  zeroMatchCount?: number;
}

async function get(who: Who, url: string): Promise<LogPage> {
  const res = await app.inject({ method: 'GET', url: `/api/rag/modules/${MODULE_KEY}${url}`, headers: headersOf(who) });
  expect(res.statusCode).toBe(200);
  return parseJsonBody<LogPage>(res.body);
}

const queriesOf = (page: LogPage) => page.logs.map((log) => log.query).sort();

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'Rag Query Log Scope',
    slug: 'rag-query-log-scope',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
  projectA = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);

  const make = async (who: Who, role: 'admin' | 'user', servicePermissions?: Record<string, string>) => {
    users[who] = await db.createUser({
      tenantId,
      email: `${who}@example.com`,
      name: who,
      password: '$2b$10$x',
      role,
      licenseId: 'FREE',
      features: [],
      ...(servicePermissions ? { servicePermissions } : {}),
    } as never);
    await db.upsertUserProject({ tenantId, userId: String(users[who]._id), projectId: projectA, role: 'member' } as never);
  };
  await make('admin', 'admin');
  await make('kbAdmin', 'user', { rag: 'admin' });
  await make('member', 'user', { rag: 'write' });
  await make('reader', 'user', { rag: 'read' });

  await db.createRagModule({
    tenantId,
    projectId: projectA,
    key: MODULE_KEY,
    name: MODULE_KEY,
    embeddingModelKey: 'embed',
    vectorProviderKey: 'vec',
    vectorIndexKey: 'idx',
    chunkConfig: { strategy: 'recursive_character', chunkSize: 800, chunkOverlap: 100 },
    status: 'active',
    createdBy: 'seed',
  });

  const log = async (query: string, matchCount: number, by: Partial<Record<'userId' | 'apiTokenId', string>>) => {
    await db.createRagQueryLog({
      tenantId,
      projectId: projectA,
      ragModuleKey: MODULE_KEY,
      query,
      topK: 5,
      matchCount,
      preFilterMatchCount: matchCount,
      latencyMs: 10,
      ...by,
    });
    // createdAt is stamped by the store: keep the order newest-first paging relies on.
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  // Oldest first: the log reads newest first.
  await log('member first question', 0, { userId: String(users.member._id) });
  await log('admin question', 2, { userId: String(users.admin._id) });
  await log('reader question', 0, { userId: String(users.reader._id) });
  // An application's call with no person behind it.
  await log('token question', 0, { apiTokenId: 'tok-1' });
  await log('member second question', 1, { userId: String(users.member._id) });

  app = await createFastifyApiTestApp(ragApiPlugin);
}, 30_000);

afterAll(async () => {
  await app.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const EVERY_QUERY = ['admin question', 'member first question', 'member second question', 'reader question', 'token question'];

describe('GET /api/rag/modules/:key/usage', () => {
  it('shows a tenant admin every query', async () => {
    const page = await get('admin', '/usage');
    expect(page.scope).toBe('all');
    expect(queriesOf(page)).toEqual(EVERY_QUERY);
  });

  it('shows a holder of a `rag` admin grant every query', async () => {
    const page = await get('kbAdmin', '/usage');
    expect(page.scope).toBe('all');
    expect(queriesOf(page)).toEqual(EVERY_QUERY);
  });

  it('shows a member only their own queries, beside counters over every query', async () => {
    const page = await get('member', '/usage');
    expect(page.scope).toBe('own');
    expect(queriesOf(page)).toEqual(['member first question', 'member second question']);
    expect(page.total).toBe(5);
    expect(page.zeroMatchCount).toBe(3);
  });

  it('pages within the member\'s own queries', async () => {
    const page = await get('member', '/usage?limit=1');
    expect(page.logs.map((log) => log.query)).toEqual(['member second question']);
  });

  it('shows a reader only their own queries', async () => {
    const page = await get('reader', '/usage');
    expect(page.scope).toBe('own');
    expect(queriesOf(page)).toEqual(['reader question']);
  });
});

describe('GET /api/rag/modules/:key/queries', () => {
  it('lists every query that found nothing for a tenant admin', async () => {
    const page = await get('admin', '/queries?zeroOnly=true');
    expect(page.scope).toBe('all');
    expect(queriesOf(page)).toEqual(['member first question', 'reader question', 'token question']);
  });

  it('lists only the member\'s own misses, never a query no person made', async () => {
    const page = await get('member', '/queries?zeroOnly=true');
    expect(page.scope).toBe('own');
    expect(queriesOf(page)).toEqual(['member first question']);
  });

  it('skips within the member\'s own feed', async () => {
    const page = await get('member', '/queries?limit=1&skip=1');
    expect(page.logs.map((log) => log.query)).toEqual(['member first question']);
  });

  it('gives a reader their own feed only', async () => {
    const page = await get('reader', '/queries');
    expect(page.scope).toBe('own');
    expect(queriesOf(page)).toEqual(['reader question']);
  });

  it('gives a holder of a `rag` admin grant the whole feed', async () => {
    const page = await get('kbAdmin', '/queries');
    expect(page.scope).toBe('all');
    expect(queriesOf(page)).toEqual(EVERY_QUERY);
  });
});
