import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/prompts', () => ({
  listPromptVersions: vi.fn(),
  setPromptLatestVersion: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return { requireProjectContext: vi.fn(), ProjectContextError };
});

import { GET, POST } from '@/server/api/routes/prompts/[id]/versions/route';
import { listPromptVersions, setPromptLatestVersion } from '@/lib/services/prompts';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const mockListPromptVersions = listPromptVersions as ReturnType<typeof vi.fn>;
const mockSetPromptLatestVersion = setPromptLatestVersion as ReturnType<typeof vi.fn>;
const mockRequireProjectContext = requireProjectContext as ReturnType<typeof vi.fn>;

const mockParams = { params: Promise.resolve({ id: 'prompt-1' }) };
const mockContext = { projectId: 'project-1' };

const mockVersions = [
  { _id: 'v1', version: 1, template: 'Hello {{name}}', createdAt: new Date() },
  { _id: 'v2', version: 2, template: 'Hi {{name}} from {{company}}', createdAt: new Date() },
];

function makeRequest(opts: { method?: string; body?: unknown; } = {}) {
  const method = opts.method ?? 'GET';
  return new NextRequest('http://localhost/api/prompts/prompt-1/versions', {
    method,
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': 'tenant-1',
      'x-user-id': 'user-1',
      'content-type': 'application/json',
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe('GET /api/prompts/[id]/versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('returns versions list on success', async () => {
    mockListPromptVersions.mockResolvedValue(mockVersions);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0].version).toBe(1);
  });

  it('returns empty list when no versions', async () => {
    mockListPromptVersions.mockResolvedValue([]);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.versions).toHaveLength(0);
  });

  it('calls service with correct args', async () => {
    mockListPromptVersions.mockResolvedValue(mockVersions);
    const req = makeRequest();
    await GET(req, mockParams);
    expect(mockListPromptVersions).toHaveBeenCalledWith(
      'tenant_acme',
      'project-1',
      'prompt-1',
    );
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/prompts/prompt-1/versions');
    const res = await GET(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('No project', 400),
    );
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 500 on unexpected error', async () => {
    mockListPromptVersions.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/prompts/[id]/versions (set latest version)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('sets latest version and returns 200', async () => {
    const updatedPrompt = { _id: 'prompt-1', latestVersionId: 'v2' };
    mockSetPromptLatestVersion.mockResolvedValue(updatedPrompt);
    const req = makeRequest({ method: 'POST', body: { versionId: 'v2' } });
    const res = await POST(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.prompt.latestVersionId).toBe('v2');
  });

  it('returns 400 when versionId missing', async () => {
    const req = makeRequest({ method: 'POST', body: {} });
    const res = await POST(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('calls setPromptLatestVersion with correct args', async () => {
    mockSetPromptLatestVersion.mockResolvedValue({ _id: 'prompt-1' });
    const req = makeRequest({ method: 'POST', body: { versionId: 'v2' } });
    await POST(req, mockParams);
    expect(mockSetPromptLatestVersion).toHaveBeenCalledWith(
      'tenant_acme',
      'project-1',
      'prompt-1',
      'v2',
      'user-1',
    );
  });

  it('returns 404 when prompt not found after update', async () => {
    mockSetPromptLatestVersion.mockResolvedValue(null);
    const req = makeRequest({ method: 'POST', body: { versionId: 'v2' } });
    const res = await POST(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/prompts/prompt-1/versions', {
      method: 'POST',
      body: JSON.stringify({ versionId: 'v2' }),
    });
    const res = await POST(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('Forbidden', 403),
    );
    const req = makeRequest({ method: 'POST', body: { versionId: 'v2' } });
    const res = await POST(req, mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    mockSetPromptLatestVersion.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({ method: 'POST', body: { versionId: 'v2' } });
    const res = await POST(req, mockParams);
    expect(res.status).toBe(500);
  });
});
