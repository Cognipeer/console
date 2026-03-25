import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/prompts', () => ({
  listPromptComments: vi.fn(),
  createPromptComment: vi.fn(),
}));

import { GET, POST } from '@/server/api/routes/prompts/[id]/comments/route';
import { listPromptComments, createPromptComment } from '@/lib/services/prompts';

const mockListPromptComments = vi.mocked(listPromptComments);
const mockCreatePromptComment = vi.mocked(createPromptComment);

const mockParams = { params: Promise.resolve({ id: 'prompt-1' }) };

// NOTE: This route uses x-tenant-db (not x-tenant-db-name) and x-project-id
function makeRequest(method: 'GET' | 'POST', body?: Record<string, unknown>, headers: Record<string, string> = {}, search = '') {
  return new NextRequest(`http://localhost/api/prompts/prompt-1/comments${search}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-project-id': 'proj-1',
      'x-user-id': 'user-1',
      'x-user-name': 'Alice',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const mockComments = [
  { _id: 'c-1', content: 'Great prompt!', userId: 'user-1', createdAt: new Date() },
];

const mockComment = { _id: 'c-2', content: 'New comment', userId: 'user-1', createdAt: new Date() };

describe('GET /api/prompts/[id]/comments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListPromptComments.mockResolvedValue(mockComments as any);
  });

  it('returns list of comments', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toHaveLength(1);
  });

  it('calls listPromptComments with correct args', async () => {
    await GET(makeRequest('GET'), mockParams);
    expect(mockListPromptComments).toHaveBeenCalledWith('tenant_test', 'proj-1', 'prompt-1', undefined);
  });

  it('passes versionId query param', async () => {
    await GET(makeRequest('GET', undefined, {}, '?versionId=v-1'), mockParams);
    expect(mockListPromptComments).toHaveBeenCalledWith('tenant_test', 'proj-1', 'prompt-1', 'v-1');
  });

  it('returns 400 when x-tenant-db is missing', async () => {
    const res = await GET(makeRequest('GET', undefined, { 'x-tenant-db': '' }), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('tenant');
  });

  it('returns 400 when x-project-id is missing', async () => {
    const res = await GET(makeRequest('GET', undefined, { 'x-project-id': '' }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 500 on service error', async () => {
    mockListPromptComments.mockRejectedValueOnce(new Error('DB error'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/prompts/[id]/comments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreatePromptComment.mockResolvedValue(mockComment as any);
  });

  it('creates a comment and returns 201', async () => {
    const res = await POST(makeRequest('POST', { content: 'Great prompt!' }), mockParams);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.comment).toBeDefined();
  });

  it('calls createPromptComment with correct args', async () => {
    await POST(makeRequest('POST', { content: 'Nice!' }), mockParams);
    expect(mockCreatePromptComment).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      'prompt-1',
      'user-1',
      'Alice',
      expect.objectContaining({ content: 'Nice!' }),
    );
  });

  it('returns 400 when content is empty', async () => {
    const res = await POST(makeRequest('POST', { content: '' }), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('content');
  });

  it('returns 400 when content is whitespace only', async () => {
    const res = await POST(makeRequest('POST', { content: '   ' }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when x-user-id is missing', async () => {
    const res = await POST(makeRequest('POST', { content: 'Nice!' }, { 'x-user-id': '' }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 500 on service error', async () => {
    mockCreatePromptComment.mockRejectedValueOnce(new Error('DB error'));
    const res = await POST(makeRequest('POST', { content: 'Nice!' }), mockParams);
    expect(res.status).toBe(500);
  });

  it('passes versionId to createPromptComment', async () => {
    await POST(makeRequest('POST', { content: 'Check v2', versionId: 'v-2' }), mockParams);
    expect(mockCreatePromptComment).toHaveBeenCalledWith(
      'tenant_test', 'tenant-id-1', 'proj-1', 'prompt-1', 'user-1', 'Alice',
      expect.objectContaining({ versionId: 'v-2' }),
    );
  });
});
