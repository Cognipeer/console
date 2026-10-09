/**
 * `GET /api/iam/audit/export`: the CSV stops at a row cap, and a file that was cut says
 * so - in a header AND in the file itself, because the file is what gets forwarded to
 * an auditor - instead of looking complete. Group-filter warnings travel with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({ db: null as unknown, feed: vi.fn() }));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/iam/auditFeed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/auditFeed')>();
  return { ...actual, listAuditFeed: h.feed };
});

import type { AuditFeedItem } from '@/lib/iam/auditFeed';
import { CSV_MAX_ROWS, iamDirectoryApiPlugin } from '@/server/api/plugins/iam-directory';
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

const item = (n: number): AuditFeedItem => ({
  id: `row-${n}`, at: '2026-10-01T10:00:00.000Z', kind: 'denials', principal: null, service: 'agents', action: 'agents.write', summary: `Denied #${n}`,
});

describe('GET /api/iam/audit/export', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const db = createMockDb();
    h.db = db;
    db.findUserById.mockResolvedValue({ _id: 'owner-1', role: 'owner', tenantId: TENANT } as never);
    app = await createFastifyApiTestApp(iamDirectoryApiPlugin);
  });
  afterEach(async () => {
    await app.close();
  });

  const exportCsv = (query = 'kind=denials') => app.inject({ method: 'GET', url: `/api/iam/audit/export?${query}`, headers });
  const lines = (csv: string) => csv.trimEnd().split('\n');

  it('a complete export has a header row plus the rows, and no truncation marker', async () => {
    h.feed.mockImplementation(async (_t: unknown, q: { offset: number }) =>
      q.offset === 0
        ? { items: Array.from({ length: 200 }, (_, i) => item(i)), hasMore: true }
        : { items: Array.from({ length: 50 }, (_, i) => item(200 + i)), hasMore: false });
    const res = await exportCsv();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-export-truncated']).toBeUndefined();
    expect(lines(res.body)).toHaveLength(1 + 250);
    expect(res.body).not.toContain('Export stopped');
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('stops at the cap and says so in a header and in the last line of the file', async () => {
    h.feed.mockImplementation(async (_t: unknown, q: { offset: number; limit: number }) => ({
      items: Array.from({ length: q.limit }, (_, i) => item(q.offset + i)), hasMore: true, // never runs out
    }));
    const res = await exportCsv();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-export-truncated']).toBe('true');
    const rows = lines(res.body);
    expect(rows).toHaveLength(1 + CSV_MAX_ROWS + 1); // header + capped rows + the notice
    expect(rows[rows.length - 1]).toContain(`Export stopped after ${CSV_MAX_ROWS} rows`);
    expect(rows[rows.length - 1]).toContain('narrow the filters');
  });

  it('a feed that ends exactly at the cap is complete, not "truncated"', async () => {
    h.feed.mockImplementation(async (_t: unknown, q: { offset: number; limit: number }) => ({
      items: Array.from({ length: q.limit }, (_, i) => item(q.offset + i)), hasMore: q.offset + q.limit < CSV_MAX_ROWS,
    }));
    const res = await exportCsv();
    expect(res.headers['x-export-truncated']).toBeUndefined();
    expect(lines(res.body)).toHaveLength(1 + CSV_MAX_ROWS);
  });

  it('carries the warnings of the feed (a group filter that looked at part of the group)', async () => {
    h.feed.mockResolvedValue({ items: [item(1)], hasMore: false, warnings: ['group_members_truncated'] });
    const res = await exportCsv('kind=denials&principalType=group&principalId=g1');
    expect(res.headers['x-export-warnings']).toBe('group_members_truncated');
  });

  it('an empty feed still answers a CSV with its header', async () => {
    h.feed.mockResolvedValue({ items: [], hasMore: false });
    const res = await exportCsv();
    expect(res.statusCode).toBe(200);
    expect(lines(res.body)).toHaveLength(1);
    expect(lines(res.body)[0]).toMatch(/^time,kind,/);
  });
});
