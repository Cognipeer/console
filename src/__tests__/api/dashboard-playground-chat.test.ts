import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Hoisted error class so it can be referenced in tests for instanceof checks
const MockGuardrailBlockError = vi.hoisted(() => {
  class MockGuardrailBlockError extends Error {
    constructor(opts: {
      guardrailKey: string;
      action: string;
      findings: unknown[];
      message: string | null;
    }) {
      super(opts.message ?? 'Content blocked');
      this.name = 'GuardrailBlockError';
      // Use Object.assign to bypass useDefineForClassFields field reset
      Object.assign(this, {
        guardrailKey: opts.guardrailKey,
        action: opts.action,
        findings: opts.findings ?? [],
        guardrailMessage: opts.message,
      });
    }
  }
  return MockGuardrailBlockError;
});

vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: vi.fn(),
  GuardrailBlockError: MockGuardrailBlockError,
}));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn(),
}));

vi.mock('@/lib/services/models/usageLogger', () => ({
  logModelUsage: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => ({
  requireProjectContext: vi.fn(),
  ProjectContextError: class ProjectContextError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
}));

import { POST } from '@/server/api/routes/dashboard/playground/chat/route';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockHandleChatCompletion = vi.mocked(handleChatCompletion);
const mockGetModelByKey = vi.mocked(getModelByKey);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const BASE_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

const mockLLMModel = {
  key: 'gpt-4',
  name: 'GPT-4',
  category: 'llm',
  providerKey: 'openai',
};

const validBody = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }],
};

function makeReq(headers?: Record<string, string>, body?: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/dashboard/playground/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? BASE_HEADERS) },
    body: JSON.stringify(body ?? validBody),
  });
}

describe('POST /api/dashboard/playground/chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue({ projectId: 'proj-1' } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetModelByKey.mockResolvedValue(mockLLMModel as any);
    mockHandleChatCompletion.mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { choices: [{ message: { role: 'assistant', content: 'Hi' } }] } as any,
      requestId: 'req-abc',
      stream: undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      usage: {} as any,
      latencyMs: 100,
      cacheHit: false,
    });
  });

  it('returns 200 with chat response', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request_id).toBeDefined();
    expect(body.choices).toBeInstanceOf(Array);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const { 'x-tenant-db-name': _, ...headersWithout } = BASE_HEADERS;
    const res = await POST(makeReq(headersWithout));
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const { 'x-user-id': _, ...headersWithout } = BASE_HEADERS;
    const res = await POST(makeReq(headersWithout));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/dashboard/playground/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...BASE_HEADERS },
      body: 'not-json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid json/i);
  });

  it('returns 400 when model is missing', async () => {
    const res = await POST(makeReq(BASE_HEADERS, { messages: [{ role: 'user', content: 'Hi' }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/model/i);
  });

  it('returns 400 when messages is empty', async () => {
    const res = await POST(makeReq(BASE_HEADERS, { model: 'gpt-4', messages: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/messages/i);
  });

  it('returns 400 when messages is missing', async () => {
    const res = await POST(makeReq(BASE_HEADERS, { model: 'gpt-4' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when model not found', async () => {
    mockGetModelByKey.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(404);
  });

  it('returns 400 when model is not an LLM', async () => {
    mockGetModelByKey.mockResolvedValueOnce({
      ...mockLLMModel,
      category: 'embedding',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/llm/i);
  });

  it('returns 400 for GuardrailBlockError with guardrail fields', async () => {
    mockHandleChatCompletion.mockRejectedValueOnce(
      new MockGuardrailBlockError({
        guardrailKey: 'pii-guard',
        action: 'block',
        findings: [{ type: 'pii' }],
        message: 'PII detected',
      }),
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.guardrail_key).toBe('pii-guard');
    expect(body.action).toBe('block');
    expect(body.findings).toBeInstanceOf(Array);
  });

  it('returns 500 on unexpected inference error', async () => {
    mockHandleChatCompletion.mockRejectedValueOnce(new Error('API timeout'));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('API timeout');
  });

  it('handles streaming response', async () => {
    const mockStream = new ReadableStream();
    mockHandleChatCompletion.mockResolvedValueOnce({
      stream: mockStream,
      requestId: 'stream-req',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const res = await POST(makeReq(BASE_HEADERS, { ...validBody, stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('X-Request-Id')).toBe('stream-req');
  });

  it('propagates ProjectContextError (403)', async () => {
    const { ProjectContextError: PCE } = await import('@/lib/services/projects/projectContext');
    mockRequireProjectContext.mockRejectedValueOnce(new PCE('Forbidden', 403));
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
  });
});
