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

vi.mock('@/lib/services/prompts', () => ({
  listPrompts: vi.fn(),
}));

import { GET } from '@/server/api/routes/client/v1/prompts/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listPrompts } from '@/lib/services/prompts';

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
};

function makeReq(url = 'http://localhost/api/client/v1/prompts'): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

describe('GET /api/client/v1/prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  it('returns 200 with prompts list', async () => {
    const prompts = [
      { _id: 'p1', key: 'greeting', name: 'Greeting Prompt' },
      { _id: 'p2', key: 'summary', name: 'Summary Prompt' },
    ];
    (listPrompts as ReturnType<typeof vi.fn>).mockResolvedValue(prompts);

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.prompts).toEqual(prompts);
  });

  it('calls listPrompts with tenantDbName and projectId', async () => {
    (listPrompts as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await GET(makeReq());

    expect(listPrompts).toHaveBeenCalledWith(
      'tenant_acme',
      'proj-1',
      expect.objectContaining({}),
    );
  });

  it('passes search query param to service', async () => {
    (listPrompts as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await GET(makeReq('http://localhost/api/client/v1/prompts?search=greeting'));

    expect(listPrompts).toHaveBeenCalledWith(
      'tenant_acme',
      'proj-1',
      expect.objectContaining({ search: 'greeting' }),
    );
  });

  it('passes undefined search when not provided', async () => {
    (listPrompts as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await GET(makeReq());

    expect(listPrompts).toHaveBeenCalledWith(
      'tenant_acme',
      'proj-1',
      expect.objectContaining({ search: undefined }),
    );
  });

  it('returns empty array when no prompts found', async () => {
    (listPrompts as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.prompts).toEqual([]);
  });

  it('returns 401 on ApiTokenAuthError with 401', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Invalid token', 401),
    );

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Invalid token');
  });

  it('returns 403 on ApiTokenAuthError with 403', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Feature not available', 403),
    );

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe('Feature not available');
  });

  it('returns 500 on unexpected error', async () => {
    (listPrompts as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Database connection lost'),
    );

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Database connection lost');
  });

  it('returns 500 with generic message on non-Error throw', async () => {
    (listPrompts as ReturnType<typeof vi.fn>).mockRejectedValue('unexpected string error');

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Internal server error');
  });
});
