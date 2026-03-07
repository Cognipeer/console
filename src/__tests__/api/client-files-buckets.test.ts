import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireApiToken: vi.fn(),
    ApiTokenAuthError,
  };
});

vi.mock('@/lib/services/files', () => ({
  listFileBuckets: vi.fn(),
}));

import { GET } from '@/server/api/routes/client/v1/files/buckets/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listFileBuckets } from '@/lib/services/files';

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
};

function makeReq(url = 'http://localhost/api/client/v1/files/buckets'): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

describe('GET /api/client/v1/files/buckets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  it('returns 200 with buckets and count', async () => {
    const buckets = [
      { _id: 'b1', key: 'docs', name: 'Documents' },
      { _id: 'b2', key: 'images', name: 'Images' },
    ];
    (listFileBuckets as ReturnType<typeof vi.fn>).mockResolvedValue(buckets);

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.buckets).toEqual(buckets);
    expect(json.count).toBe(2);
  });

  it('calls listFileBuckets with correct args', async () => {
    (listFileBuckets as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await GET(makeReq());

    expect(listFileBuckets).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
    );
  });

  it('returns empty buckets with count 0 when no buckets found', async () => {
    (listFileBuckets as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.buckets).toEqual([]);
    expect(json.count).toBe(0);
  });

  it('returns 401 on ApiTokenAuthError with 401', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Unauthorized', 401),
    );

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized');
  });

  it('returns 403 on ApiTokenAuthError with 403', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Forbidden', 403),
    );

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe('Forbidden');
  });

  it('returns 500 on service error with error message', async () => {
    (listFileBuckets as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Storage not available'),
    );

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Storage not available');
  });

  it('returns 500 with fallback message on non-Error throw', async () => {
    (listFileBuckets as ReturnType<typeof vi.fn>).mockRejectedValue('unknown');

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to list buckets');
  });
});
