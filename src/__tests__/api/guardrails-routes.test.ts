import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/guardrail', () => ({
  createGuardrail: vi.fn(),
  listGuardrails: vi.fn(),
  PII_CATEGORIES: ['PHONE', 'EMAIL'],
  MODERATION_CATEGORIES: ['HATE', 'VIOLENCE'],
  PROMPT_SHIELD_ISSUES: ['JAILBREAK'],
  buildDefaultPresetPolicy: vi.fn().mockReturnValue({ version: 1, categories: [] }),
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

import { GET, POST } from '@/app/api/guardrails/route';
import { createGuardrail, listGuardrails } from '@/lib/services/guardrail';
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
const MOCK_GUARDRAIL = {
  _id: 'gr-1',
  name: 'PII Shield',
  type: 'preset',
  action: 'block',
  target: 'input',
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
  (listGuardrails as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_GUARDRAIL]);
  (createGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GUARDRAIL);
});

describe('GET /api/guardrails', () => {
  it('returns guardrails list 200', async () => {
    const req = makeReq('/api/guardrails');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.guardrails).toHaveLength(1);
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/guardrails', 'GET', undefined, {});
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('passes type and search filters', async () => {
    const req = makeReq('/api/guardrails?type=preset&search=PII');
    await GET(req);
    expect(listGuardrails).toHaveBeenCalledWith('tenant_acme', expect.objectContaining({
      type: 'preset', search: 'PII',
    }));
  });

  it('passes enabled filter when true', async () => {
    const req = makeReq('/api/guardrails?enabled=true');
    await GET(req);
    expect(listGuardrails).toHaveBeenCalledWith('tenant_acme', expect.objectContaining({ enabled: true }));
  });

  it('returns templates when includeTemplates=true', async () => {
    const req = makeReq('/api/guardrails?includeTemplates=true');
    const res = await GET(req);
    const body = await res.json();
    expect(body.templates).toBeDefined();
    expect(body.templates.piiCategories).toBeDefined();
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('No project', 404);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const res = await GET(makeReq('/api/guardrails'));
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    (listGuardrails as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await GET(makeReq('/api/guardrails'));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/guardrails', () => {
  const VALID_BODY = {
    name: 'PII Shield',
    type: 'preset',
    action: 'block',
    target: 'input',
  };

  it('creates guardrail and returns 201', async () => {
    const req = makeReq('/api/guardrails', 'POST', VALID_BODY);
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.guardrail).toBeDefined();
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/guardrails', 'POST', VALID_BODY, {});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const { name: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/guardrails', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('name');
  });

  it('returns 400 for invalid type', async () => {
    const req = makeReq('/api/guardrails', 'POST', { ...VALID_BODY, type: 'invalid' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('type');
  });

  it('returns 400 for invalid action', async () => {
    const req = makeReq('/api/guardrails', 'POST', { ...VALID_BODY, action: 'explode' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('action');
  });

  it('returns 400 for invalid target', async () => {
    const req = makeReq('/api/guardrails', 'POST', { ...VALID_BODY, target: 'nowhere' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('target');
  });

  it('returns 400 when custom type missing customPrompt', async () => {
    const req = makeReq('/api/guardrails', 'POST', { ...VALID_BODY, type: 'custom' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('customPrompt');
  });

  it('creates custom guardrail with customPrompt', async () => {
    const req = makeReq('/api/guardrails', 'POST', { ...VALID_BODY, type: 'custom', customPrompt: 'Check for offensive content' });
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it('passes correct defaults to createGuardrail', async () => {
    const req = makeReq('/api/guardrails', 'POST', VALID_BODY);
    await POST(req);
    expect(createGuardrail).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'user-1', expect.objectContaining({
      name: 'PII Shield',
      type: 'preset',
      target: 'input',
      action: 'block',
      enabled: true,
      projectId: 'proj-1',
    }));
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('Forbidden', 403);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const res = await POST(makeReq('/api/guardrails', 'POST', VALID_BODY));
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    (createGuardrail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await POST(makeReq('/api/guardrails', 'POST', VALID_BODY));
    expect(res.status).toBe(500);
  });
});
