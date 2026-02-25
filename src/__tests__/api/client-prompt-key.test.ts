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
  return { requireApiToken: vi.fn(), ApiTokenAuthError };
});

vi.mock('@/lib/services/prompts', () => ({
  resolvePromptForEnvironment: vi.fn(),
}));

import { GET } from '@/app/api/client/v1/prompts/[key]/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { resolvePromptForEnvironment } from '@/lib/services/prompts';

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
};

const ROUTE_CTX = { params: Promise.resolve({ key: 'greeting' }) };

function makeReq(url = 'http://localhost/api/client/v1/prompts/greeting'): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

const MOCK_PROMPT = {
  _id: 'prompt-1',
  key: 'greeting',
  name: 'Greeting Prompt',
  projectId: 'proj-1',
  tenantId: 'tenant-1',
};

const MOCK_VERSION = {
  id: 'ver-1',
  version: 3,
  name: 'v3',
  description: 'Latest',
  isLatest: true,
};

describe('GET /api/client/v1/prompts/:key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  it('returns 200 with prompt and resolved version', async () => {
    (resolvePromptForEnvironment as ReturnType<typeof vi.fn>).mockResolvedValue({
      prompt: MOCK_PROMPT,
      resolvedVersion: MOCK_VERSION,
    });

    const res = await GET(makeReq(), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.prompt).toMatchObject({ key: 'greeting' });
    expect(json.resolvedVersion).toMatchObject({
      id: 'ver-1',
      version: 3,
      isLatest: true,
    });
  });

  it('returns 200 with null resolvedVersion when no version', async () => {
    (resolvePromptForEnvironment as ReturnType<typeof vi.fn>).mockResolvedValue({
      prompt: MOCK_PROMPT,
      resolvedVersion: null,
    });

    const res = await GET(makeReq(), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.resolvedVersion).toBeNull();
  });

  it('returns 404 when prompt is not found (returns null)', async () => {
    (resolvePromptForEnvironment as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await GET(makeReq(), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Prompt not found');
  });

  it('passes environment query param to service', async () => {
    (resolvePromptForEnvironment as ReturnType<typeof vi.fn>).mockResolvedValue({
      prompt: MOCK_PROMPT,
      resolvedVersion: MOCK_VERSION,
    });

    await GET(makeReq('http://localhost/api/client/v1/prompts/greeting?environment=prod'), ROUTE_CTX);

    expect(resolvePromptForEnvironment).toHaveBeenCalledWith(
      'tenant_acme',
      'proj-1',
      'greeting',
      'prod',
      undefined,
    );
  });

  it('passes version query param to service', async () => {
    (resolvePromptForEnvironment as ReturnType<typeof vi.fn>).mockResolvedValue({
      prompt: MOCK_PROMPT,
      resolvedVersion: MOCK_VERSION,
    });

    await GET(makeReq('http://localhost/api/client/v1/prompts/greeting?version=2'), ROUTE_CTX);

    expect(resolvePromptForEnvironment).toHaveBeenCalledWith(
      'tenant_acme',
      'proj-1',
      'greeting',
      undefined,
      2,
    );
  });

  it('returns 400 for invalid environment value', async () => {
    const res = await GET(
      makeReq('http://localhost/api/client/v1/prompts/greeting?environment=unknown'),
      ROUTE_CTX,
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid environment');
  });

  it('returns 400 for invalid version (non-numeric)', async () => {
    const res = await GET(
      makeReq('http://localhost/api/client/v1/prompts/greeting?version=abc'),
      ROUTE_CTX,
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Invalid version');
  });

  it('returns 400 for version = 0', async () => {
    const res = await GET(
      makeReq('http://localhost/api/client/v1/prompts/greeting?version=0'),
      ROUTE_CTX,
    );
    const json = await res.json();

    expect(res.status).toBe(400);
  });

  it.each(['dev', 'staging', 'prod'])('accepts valid environment: %s', async (env) => {
    (resolvePromptForEnvironment as ReturnType<typeof vi.fn>).mockResolvedValue({
      prompt: MOCK_PROMPT,
      resolvedVersion: null,
    });

    const res = await GET(
      makeReq(`http://localhost/api/client/v1/prompts/greeting?environment=${env}`),
      ROUTE_CTX,
    );

    expect(res.status).toBe(200);
  });

  it('returns 401 on auth error', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Unauthorized', 401),
    );

    const res = await GET(makeReq(), ROUTE_CTX);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    (resolvePromptForEnvironment as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB error'),
    );

    const res = await GET(makeReq(), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('DB error');
  });
});
