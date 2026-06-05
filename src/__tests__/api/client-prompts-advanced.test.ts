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
  getPromptByKey: vi.fn(),
  comparePromptVersions: vi.fn(),
  resolvePromptForEnvironment: vi.fn(),
  listPromptVersions: vi.fn(),
  listPromptDeployments: vi.fn(),
  activatePromptDeployment: vi.fn(),
  planPromptDeployment: vi.fn(),
  promotePromptVersion: vi.fn(),
  rollbackPromptDeployment: vi.fn(),
}));

// mustache is used by render route
vi.mock('mustache', () => ({
  default: { render: vi.fn().mockReturnValue('Hello World') },
}));

import { GET as compareGET } from '@/server/api/routes/client/v1/prompts/[key]/compare/route';
import { POST as renderPOST } from '@/server/api/routes/client/v1/prompts/[key]/render/route';
import { GET as versionsGET } from '@/server/api/routes/client/v1/prompts/[key]/versions/route';
import { GET as deploymentsGET, POST as deploymentsPOST } from '@/server/api/routes/client/v1/prompts/[key]/deployments/route';

import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  getPromptByKey,
  comparePromptVersions,
  resolvePromptForEnvironment,
  listPromptVersions,
  listPromptDeployments,
  promotePromptVersion,
} from '@/lib/services/prompts';

const mockRequireApiToken = vi.mocked(requireApiToken);
const mockGetPromptByKey = vi.mocked(getPromptByKey);
const mockComparePromptVersions = vi.mocked(comparePromptVersions);
const mockResolvePromptForEnvironment = vi.mocked(resolvePromptForEnvironment);
const mockListPromptVersions = vi.mocked(listPromptVersions);
const mockListPromptDeployments = vi.mocked(listPromptDeployments);
const mockPromotePromptVersion = vi.mocked(promotePromptVersion);

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { _id: 'tr-1', userId: 'user-1' },
  user: { email: 'test@example.com' },
};

const mockPrompt = {
  id: 'p-1',
  key: 'greeting',
  name: 'Greeting',
  template: 'Hello {{name}}!',
  currentVersion: 3,
};

const mockVersions = [
  { id: 'v-1', version: 1, name: 'v1', description: '', comment: '', isLatest: false, createdAt: new Date(), createdBy: 'user-1' },
  { id: 'v-2', version: 2, name: 'v2', description: '', comment: '', isLatest: false, createdAt: new Date(), createdBy: 'user-1' },
  { id: 'v-3', version: 3, name: 'v3', description: '', comment: '', isLatest: true, createdAt: new Date(), createdBy: 'user-1' },
];

const mockDeployments = [
  { environment: 'prod', versionId: 'v-3', activatedAt: new Date() },
];

const mockComparison = {
  fromVersion: { id: 'v-1', version: 1, template: 'Hello {{name}}!' },
  toVersion: { id: 'v-2', version: 2, template: 'Hi {{name}}!' },
  diff: [{ type: 'change', from: 'Hello', to: 'Hi' }],
};

const keyParams = { params: Promise.resolve({ key: 'greeting' }) };

function makeReq(method: string, path: string, body?: Record<string, unknown>, query?: string) {
  const url = `http://localhost${path}${query ? `?${query}` : ''}`;
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── Compare GET ─────────────────────────────────────────────────────────────

describe('GET /api/client/v1/prompts/[key]/compare', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetPromptByKey.mockResolvedValue(mockPrompt as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockComparePromptVersions.mockResolvedValue(mockComparison as any);
  });

  it('compares two versions', async () => {
    const req = new NextRequest('http://localhost/api/client/v1/prompts/greeting/compare?fromVersionId=v-1&toVersionId=v-2', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    const res = await compareGET(req, keyParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comparison).toBeDefined();
    expect(body.prompt.key).toBe('greeting');
  });

  it('returns 400 when fromVersionId is missing', async () => {
    const req = new NextRequest('http://localhost/api/client/v1/prompts/greeting/compare?toVersionId=v-2', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    const res = await compareGET(req, keyParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when toVersionId is missing', async () => {
    const req = new NextRequest('http://localhost/api/client/v1/prompts/greeting/compare?fromVersionId=v-1', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    const res = await compareGET(req, keyParams);
    expect(res.status).toBe(400);
  });

  it('returns 404 when prompt not found', async () => {
    mockGetPromptByKey.mockResolvedValueOnce(null);
    const req = new NextRequest('http://localhost/api/client/v1/prompts/greeting/compare?fromVersionId=v-1&toVersionId=v-2', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    const res = await compareGET(req, keyParams);
    expect(res.status).toBe(404);
  });

  it('returns 404 when comparison not found', async () => {
    mockComparePromptVersions.mockResolvedValueOnce(null);
    const req = new NextRequest('http://localhost/api/client/v1/prompts/greeting/compare?fromVersionId=v-1&toVersionId=v-2', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    const res = await compareGET(req, keyParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const req = new NextRequest('http://localhost/api/client/v1/prompts/greeting/compare?fromVersionId=v-1&toVersionId=v-2', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    const res = await compareGET(req, keyParams);
    expect(res.status).toBe(401);
  });
});

// ─── Render POST ──────────────────────────────────────────────────────────────

describe('POST /api/client/v1/prompts/[key]/render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockResolvePromptForEnvironment.mockResolvedValue({ prompt: mockPrompt } as any);
  });

  it('renders a prompt template', async () => {
    const res = await renderPOST(
      makeReq('POST', '/api/client/v1/prompts/greeting/render', { data: { name: 'Alice' } }),
      keyParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rendered).toBeDefined();
    expect(body.prompt.key).toBe('greeting');
  });

  it('renders with environment query param', async () => {
    const req = new NextRequest('http://localhost/api/client/v1/prompts/greeting/render?environment=prod', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ name: 'Alice' }),
    });
    const res = await renderPOST(req, keyParams);
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid environment', async () => {
    const req = new NextRequest('http://localhost/api/client/v1/prompts/greeting/render?environment=invalid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({}),
    });
    const res = await renderPOST(req, keyParams);
    expect(res.status).toBe(400);
  });

  it('returns 404 when prompt not found', async () => {
    mockResolvePromptForEnvironment.mockResolvedValueOnce(null);
    const res = await renderPOST(
      makeReq('POST', '/api/client/v1/prompts/greeting/render', {}),
      keyParams,
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await renderPOST(makeReq('POST', '/api/client/v1/prompts/greeting/render', {}), keyParams);
    expect(res.status).toBe(401);
  });
});

// ─── Versions GET ────────────────────────────────────────────────────────────

describe('GET /api/client/v1/prompts/[key]/versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetPromptByKey.mockResolvedValue(mockPrompt as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListPromptVersions.mockResolvedValue(mockVersions as any);
  });

  it('returns list of versions', async () => {
    const res = await versionsGET(makeReq('GET', '/api/client/v1/prompts/greeting/versions'), keyParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions).toHaveLength(3);
    expect(body.prompt.key).toBe('greeting');
  });

  it('returns 404 when prompt not found', async () => {
    mockGetPromptByKey.mockResolvedValueOnce(null);
    const res = await versionsGET(makeReq('GET', '/api/client/v1/prompts/greeting/versions'), keyParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await versionsGET(makeReq('GET', '/api/client/v1/prompts/greeting/versions'), keyParams);
    expect(res.status).toBe(401);
  });
});

// ─── Deployments GET ─────────────────────────────────────────────────────────

describe('GET /api/client/v1/prompts/[key]/deployments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetPromptByKey.mockResolvedValue(mockPrompt as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListPromptDeployments.mockResolvedValue(mockDeployments as any);
  });

  it('returns list of deployments', async () => {
    const res = await deploymentsGET(makeReq('GET', '/api/client/v1/prompts/greeting/deployments'), keyParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deployments).toHaveLength(1);
    expect(body.prompt.key).toBe('greeting');
  });

  it('returns 404 when prompt not found', async () => {
    mockGetPromptByKey.mockResolvedValueOnce(null);
    const res = await deploymentsGET(makeReq('GET', '/api/client/v1/prompts/greeting/deployments'), keyParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await deploymentsGET(makeReq('GET', '/api/client/v1/prompts/greeting/deployments'), keyParams);
    expect(res.status).toBe(401);
  });
});

// ─── Deployments POST (promote) ──────────────────────────────────────────────

describe('POST /api/client/v1/prompts/[key]/deployments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetPromptByKey.mockResolvedValue(mockPrompt as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPromotePromptVersion.mockResolvedValue(mockPrompt as any);
  });

  it('promotes a version to an environment', async () => {
    const res = await deploymentsPOST(
      makeReq('POST', '/api/client/v1/prompts/greeting/deployments', {
        action: 'promote',
        versionId: 'v-3',
        environment: 'prod',
        note: 'release v3',
      }),
      keyParams,
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 when environment is invalid', async () => {
    const res = await deploymentsPOST(
      makeReq('POST', '/api/client/v1/prompts/greeting/deployments', {
        action: 'promote',
        versionId: 'v-3',
        environment: 'prerelease',
      }),
      keyParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when prompt not found', async () => {
    mockGetPromptByKey.mockResolvedValueOnce(null);
    const res = await deploymentsPOST(
      makeReq('POST', '/api/client/v1/prompts/greeting/deployments', { action: 'promote', environment: 'prod', versionId: 'v-3' }),
      keyParams,
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await deploymentsPOST(
      makeReq('POST', '/api/client/v1/prompts/greeting/deployments', { action: 'promote', environment: 'prod', versionId: 'v-3' }),
      keyParams,
    );
    expect(res.status).toBe(401);
  });
});
