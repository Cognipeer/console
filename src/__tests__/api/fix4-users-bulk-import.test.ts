/**
 * POST /api/users/bulk-import — the route-level half of the CSV import.
 *
 * The parser and insert loop are unit-tested; this pins what the route adds:
 * the row cap answers 400 with the cap, the quota is charged for exactly the
 * rows the loop will create (name-only rows already present are not counted),
 * a re-upload with nothing new never 429s, and a mid-batch halt is reported
 * rather than hidden.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
  DEFAULT_PROJECT_KEY: '__default__',
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('$hash'), compare: vi.fn() },
  hash: vi.fn().mockResolvedValue('$hash'),
  compare: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { MAX_BULK_IMPORT_ROWS } from '@/lib/services/users/csvImport';
import { usersApiPlugin } from '@/server/api/plugins/users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const OWNER = { _id: 'owner-1', role: 'owner', tenantId: 'tenant-1', name: 'Owner', email: 'o@x.com' };
const TENANT = { _id: 'tenant-1', slug: 'acme', dbName: 'tenant_acme', licenseType: 'STARTER', companyName: 'Acme' };

const HEADERS = {
  'content-type': 'application/json',
  'x-license-type': 'STARTER',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'owner-1',
  'x-user-role': 'owner',
};

type ImportReply = {
  created: unknown[]; createdCount: number; skippedExisting: string[];
  halted?: { reason: string; remaining: number }; error?: string; maxRows?: number;
};

describe('POST /api/users/bulk-import', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockResolvedValue(OWNER as never);
    db.findTenantById.mockResolvedValue(TENANT as never);
    db.listUsers.mockResolvedValue([OWNER] as never);
    db.createUser.mockImplementation(async (input: Record<string, unknown>) => ({ _id: `id-${String(input.name)}`, ...input }) as never);
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    app = await createFastifyApiTestApp(usersApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (csv: string, headers: Record<string, string> = HEADERS) => app.inject({
    method: 'POST',
    url: '/api/users/bulk-import',
    headers,
    payload: JSON.stringify({ csv }),
  });

  it('refuses a file past the row cap with a 400 that names the cap', async () => {
    const csv = Array.from({ length: MAX_BULK_IMPORT_ROWS + 1 }, (_, i) => `p${i}@x.com`).join('\n');
    const res = await post(csv);
    expect(res.statusCode).toBe(400);
    const body = parseJsonBody<ImportReply>(res.body);
    expect(body.maxRows).toBe(MAX_BULK_IMPORT_ROWS);
    expect(body.error).toMatch(/split/i);
    expect(db.createUser).not.toHaveBeenCalled();
  });

  it('charges the quota only for rows the insert loop will create', async () => {
    // "Ada Lovelace" already exists WITHOUT an email; her name-only row is
    // skipped by the loop, so it must not be counted as a newcomer either.
    db.listUsers.mockResolvedValue([OWNER, { _id: 'u-ada', name: 'Ada Lovelace', email: '' }] as never);
    const res = await post('Ada Lovelace\ngrace@x.com,Grace Hopper\n');
    expect(res.statusCode).toBe(201);
    // existing (2) + newcomers (1) - 1
    expect((checkResourceQuota as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(2);
    const body = parseJsonBody<ImportReply>(res.body);
    expect(body.createdCount).toBe(1);
    expect(body.skippedExisting).toEqual(['Ada Lovelace']);
  });

  it('does not check the quota for a re-upload that creates nobody', async () => {
    db.listUsers.mockResolvedValue([OWNER, { _id: 'u-g', name: 'Grace Hopper', email: 'grace@x.com' }] as never);
    const res = await post('grace@x.com,Grace Hopper\n');
    expect(res.statusCode).toBe(201);
    expect(checkResourceQuota).not.toHaveBeenCalled();
    expect(parseJsonBody<ImportReply>(res.body).createdCount).toBe(0);
  });

  it('reports a mid-batch quota halt instead of overshooting', async () => {
    // The up-front check sees existing + newcomers - 1 = 1 + 60 - 1 = 60 and
    // passes; the in-loop re-check at 50 creations sees existing + created =
    // 51 — as if a concurrent import had eaten the headroom — and refuses.
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockImplementation(async (_ctx, _res, count: number) => (
      count === 51 ? { allowed: false, reason: 'users limit reached' } : { allowed: true }
    ));
    const csv = Array.from({ length: 60 }, (_, i) => `p${i}@x.com`).join('\n');
    const res = await post(csv);
    expect(res.statusCode).toBe(201);
    const body = parseJsonBody<ImportReply>(res.body);
    expect(body.createdCount).toBe(50);
    expect(body.halted).toEqual({ reason: 'users limit reached', remaining: 10 });
    expect((checkResourceQuota as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])).toEqual([60, 51]);
  });

  it('rejects non-admin sessions', async () => {
    const res = await post('a@x.com', { ...HEADERS, 'x-user-role': 'user', 'x-user-id': 'user-1' });
    expect(res.statusCode).toBe(403);
  });
});
