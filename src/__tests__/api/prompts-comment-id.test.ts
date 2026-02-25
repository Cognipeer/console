import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/prompts', () => ({
  deletePromptComment: vi.fn(),
}));

import { DELETE } from '@/app/api/prompts/[id]/comments/[commentId]/route';
import { deletePromptComment } from '@/lib/services/prompts';

const mockDeletePromptComment = vi.mocked(deletePromptComment);

const commentParams = { params: Promise.resolve({ id: 'prompt-1', commentId: 'comment-1' }) };

function makeReq(headers?: Record<string, string>) {
  return new NextRequest(
    'http://localhost/api/prompts/prompt-1/comments/comment-1',
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    },
  );
}

describe('DELETE /api/prompts/[id]/comments/[commentId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeletePromptComment.mockResolvedValue(true);
  });

  it('deletes a comment successfully', async () => {
    const res = await DELETE(makeReq({ 'x-tenant-db': 'tenant_acme' }), commentParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('calls deletePromptComment with correct args', async () => {
    await DELETE(makeReq({ 'x-tenant-db': 'tenant_acme' }), commentParams);
    expect(mockDeletePromptComment).toHaveBeenCalledWith('tenant_acme', 'comment-1');
  });

  it('returns 400 when x-tenant-db header is missing', async () => {
    const res = await DELETE(makeReq(), commentParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing/i);
  });

  it('returns 404 when comment not found (deletePromptComment returns false)', async () => {
    mockDeletePromptComment.mockResolvedValueOnce(false);
    const res = await DELETE(makeReq({ 'x-tenant-db': 'tenant_acme' }), commentParams);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 500 on unexpected error', async () => {
    mockDeletePromptComment.mockRejectedValueOnce(new Error('DB error'));
    const res = await DELETE(makeReq({ 'x-tenant-db': 'tenant_acme' }), commentParams);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('uses x-tenant-db (NOT x-tenant-db-name) as the database header', async () => {
    // Only x-tenant-db-name present — should still fail with 400
    const res = await DELETE(makeReq({ 'x-tenant-db-name': 'tenant_acme' }), commentParams);
    expect(res.status).toBe(400);
  });
});
