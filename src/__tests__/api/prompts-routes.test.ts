import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/prompts', () => ({
  createPrompt: vi.fn(),
  listPrompts: vi.fn(),
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

import { GET, POST } from '@/app/api/prompts/route';
import { createPrompt, listPrompts } from '@/lib/services/prompts';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

function makeReq(path: string, method = 'GET', body?: object, headers: Record<string, string> = HEADERS) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const MOCK_PROJECT = { projectId: 'proj-1' };
const MOCK_PROMPT = {
  _id: 'prompt-1',
  name: 'Welcome Email',
  key: 'welcome-email',
  template: 'Hello {{name}}, welcome!',
  projectId: 'proj-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
  (listPrompts as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_PROMPT]);
  (createPrompt as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROMPT);
});

describe('GET /api/prompts', () => {
  it('returns prompts list 200', async () => {
    const req = makeReq('/api/prompts');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.prompts).toHaveLength(1);
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/prompts', 'GET', undefined, {});
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('passes search param to listPrompts', async () => {
    const req = makeReq('/api/prompts?search=welcome');
    await GET(req);
    expect(listPrompts).toHaveBeenCalledWith('tenant_acme', 'proj-1', expect.objectContaining({ search: 'welcome' }));
  });

  it('calls listPrompts with correct project', async () => {
    const req = makeReq('/api/prompts');
    await GET(req);
    expect(listPrompts).toHaveBeenCalledWith('tenant_acme', 'proj-1', expect.objectContaining({}));
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('No project', 404);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const res = await GET(makeReq('/api/prompts'));
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    (listPrompts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await GET(makeReq('/api/prompts'));
    expect(res.status).toBe(500);
  });

  it('returns empty list when no prompts', async () => {
    (listPrompts as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = await GET(makeReq('/api/prompts'));
    const body = await res.json();
    expect(body.prompts).toHaveLength(0);
  });
});

describe('POST /api/prompts', () => {
  const VALID_BODY = {
    name: 'Welcome Email',
    template: 'Hello {{name}}, welcome to {{company}}!',
  };

  it('creates prompt and returns 201', async () => {
    const req = makeReq('/api/prompts', 'POST', VALID_BODY);
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.prompt).toBeDefined();
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/prompts', 'POST', VALID_BODY, {});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const { name: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/prompts', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('name');
  });

  it('returns 400 when template is missing', async () => {
    const { template: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/prompts', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('template');
  });

  it('returns 400 when name is empty string', async () => {
    const req = makeReq('/api/prompts', 'POST', { name: '   ', template: 'Hello' });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('passes correct args to createPrompt', async () => {
    const req = makeReq('/api/prompts', 'POST', { ...VALID_BODY, key: 'welcome-email', description: 'A welcome email' });
    await POST(req);
    expect(createPrompt).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      'user-1',
      expect.objectContaining({
        name: 'Welcome Email',
        key: 'welcome-email',
        description: 'A welcome email',
        template: VALID_BODY.template,
      }),
    );
  });

  it('supports versionComment', async () => {
    const req = makeReq('/api/prompts', 'POST', { ...VALID_BODY, versionComment: 'Initial version' });
    await POST(req);
    expect(createPrompt).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String), expect.any(String),
      expect.objectContaining({ versionComment: 'Initial version' }),
    );
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('Forbidden', 403);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const res = await POST(makeReq('/api/prompts', 'POST', VALID_BODY));
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    (createPrompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await POST(makeReq('/api/prompts', 'POST', VALID_BODY));
    expect(res.status).toBe(500);
  });
});
