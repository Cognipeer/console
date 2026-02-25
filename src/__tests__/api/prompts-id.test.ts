import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/prompts', () => ({
  getPromptById: vi.fn(),
  updatePrompt: vi.fn(),
  deletePrompt: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return {
    requireProjectContext: vi.fn(),
    ProjectContextError,
  };
});

import { GET, PATCH, DELETE } from '@/app/api/prompts/[id]/route';
import { getPromptById, updatePrompt, deletePrompt } from '@/lib/services/prompts';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const mockGetPromptById = getPromptById as ReturnType<typeof vi.fn>;
const mockUpdatePrompt = updatePrompt as ReturnType<typeof vi.fn>;
const mockDeletePrompt = deletePrompt as ReturnType<typeof vi.fn>;
const mockRequireProjectContext = requireProjectContext as ReturnType<typeof vi.fn>;

const mockParams = { params: Promise.resolve({ id: 'prompt-1' }) };

const mockPrompt = {
  _id: 'prompt-1',
  name: 'Welcome Prompt',
  template: 'Hello {{name}}!',
  projectId: 'project-1',
};

const mockContext = { projectId: 'project-1' };

function makeRequest(opts: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const method = opts.method ?? 'GET';
  return new NextRequest('http://localhost/api/prompts/prompt-1', {
    method,
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': 'tenant-1',
      'x-user-id': 'user-1',
      'content-type': 'application/json',
      ...opts.headers,
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe('GET /api/prompts/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('returns the prompt on success', async () => {
    mockGetPromptById.mockResolvedValue(mockPrompt);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.prompt.name).toBe('Welcome Prompt');
  });

  it('returns 404 when prompt not found', async () => {
    mockGetPromptById.mockResolvedValue(null);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/prompts/prompt-1');
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
    mockGetPromptById.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/prompts/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('updates the prompt and returns 200', async () => {
    const updated = { ...mockPrompt, name: 'Updated Prompt' };
    mockUpdatePrompt.mockResolvedValue(updated);
    const req = makeRequest({ method: 'PATCH', body: { name: 'Updated Prompt' } });
    const res = await PATCH(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.prompt.name).toBe('Updated Prompt');
  });

  it('passes versionComment to updatePrompt', async () => {
    mockUpdatePrompt.mockResolvedValue(mockPrompt);
    const req = makeRequest({
      method: 'PATCH',
      body: { name: 'x', versionComment: 'v2 fix' },
    });
    await PATCH(req, mockParams);
    expect(mockUpdatePrompt).toHaveBeenCalledWith(
      'tenant_acme',
      'project-1',
      'prompt-1',
      expect.objectContaining({ versionComment: 'v2 fix', updatedBy: 'user-1' }),
    );
  });

  it('falls back to comment field for versionComment', async () => {
    mockUpdatePrompt.mockResolvedValue(mockPrompt);
    const req = makeRequest({
      method: 'PATCH',
      body: { comment: 'legacy comment' },
    });
    await PATCH(req, mockParams);
    expect(mockUpdatePrompt).toHaveBeenCalledWith(
      'tenant_acme',
      'project-1',
      'prompt-1',
      expect.objectContaining({ versionComment: 'legacy comment' }),
    );
  });

  it('returns 404 when prompt not found after update', async () => {
    mockUpdatePrompt.mockResolvedValue(null);
    const req = makeRequest({ method: 'PATCH', body: {} });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/prompts/prompt-1', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('Project required', 400),
    );
    const req = makeRequest({ method: 'PATCH', body: {} });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 500 on unexpected error', async () => {
    mockUpdatePrompt.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({ method: 'PATCH', body: {} });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/prompts/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('deletes the prompt and returns success', async () => {
    mockDeletePrompt.mockResolvedValue(true);
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 404 when prompt not found', async () => {
    mockDeletePrompt.mockResolvedValue(false);
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/prompts/prompt-1', {
      method: 'DELETE',
    });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('calls deletePrompt with correct projectId', async () => {
    mockDeletePrompt.mockResolvedValue(true);
    const req = makeRequest({ method: 'DELETE' });
    await DELETE(req, mockParams);
    expect(mockDeletePrompt).toHaveBeenCalledWith('tenant_acme', 'project-1', 'prompt-1');
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('Forbidden', 403),
    );
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    mockDeletePrompt.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(500);
  });
});
