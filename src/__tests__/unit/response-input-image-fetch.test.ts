/**
 * `input_image { image_url: 'https://…' }` and `input_file { file_url }` are
 * fetched by the server through the guarded fetch, capped at the agent's file
 * size. An image URL must answer with an image: the fetch is how a client hands
 * over a picture, not a way to pull any web page or JSON into the model's
 * context; a file keeps its declared type for the upload's type check.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ safeFetch: vi.fn(), uploadSessionFile: vi.fn() }));

vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: hoisted.safeFetch }));
vi.mock('@/lib/services/agents/sessionFiles', () => ({
  resolveAttachmentsConfig: () => ({ maxFileSizeMb: 1 }),
  resolveUploadMimeType: (mime: string | undefined) => mime ?? 'application/octet-stream',
  uploadSessionFile: hoisted.uploadSessionFile,
}));

import { AgentAttachmentError } from '@/lib/services/agents/agentErrors';
import { storeResponseInputFiles } from '@/lib/services/agents/responseInputFiles';

const store = (url: string) => storeResponseInputFiles({
  files: [{ kind: 'image', url }],
  scope: { tenantDbName: 'tenant_x', tenantId: 't1', projectId: 'p1' },
  conversation: { _id: 'conv-1', agentKey: 'support' } as never,
  agentConfig: undefined,
  actor: { userId: 'u1' } as never,
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.uploadSessionFile.mockResolvedValue({ id: 'file-1' });
});

describe('an image_url that is fetched', () => {
  it('is stored when the server answers with an image, whatever the Content-Type parameters', async () => {
    hoisted.safeFetch.mockResolvedValue(new Response(Buffer.from([1, 2, 3]), { headers: { 'content-type': 'Image/PNG; charset=binary' } }));
    await expect(store('https://img.example.com/a/cat.png')).resolves.toEqual({ attachments: ['file-1'], named: [] });
    expect(hoisted.uploadSessionFile).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'cat.png', contentType: 'image/png' }));
  });

  it.each([
    ['JSON', 'application/json'],
    ['HTML', 'text/html; charset=utf-8'],
    ['an octet stream', 'application/octet-stream'],
  ])('is refused (415 unsupported_file_type) when the server answers with %s, and nothing is stored', async (_label, contentType) => {
    hoisted.safeFetch.mockResolvedValue(new Response('{"ok":true}', { headers: { 'content-type': contentType } }));
    await expect(store('http://127.0.0.1:3098/cat.png')).rejects.toMatchObject({
      name: 'AgentAttachmentError', status: 415, code: 'unsupported_file_type',
    });
    expect(hoisted.uploadSessionFile).not.toHaveBeenCalled();
  });

  it('is refused when the server declares no Content-Type', async () => {
    const response = new Response('x');
    response.headers.delete('content-type');
    hoisted.safeFetch.mockResolvedValue(response);
    const refusal = await store('https://img.example.com/cat.png').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AgentAttachmentError);
    expect((refusal as AgentAttachmentError).message).toContain('missing');
    expect(hoisted.uploadSessionFile).not.toHaveBeenCalled();
  });

  it('is refused without reading the body', async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error('the body must not be read'); }, cancel });
    hoisted.safeFetch.mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/plain' } }));
    await expect(store('https://img.example.com/cat.png')).rejects.toMatchObject({ status: 415 });
    expect(cancel).toHaveBeenCalled();
  });
});

describe('an input_file file_url that is fetched', () => {
  const storeFile = (url: string, filename?: string) => storeResponseInputFiles({
    files: [{ kind: 'file', url, ...(filename ? { filename } : {}) }],
    scope: { tenantDbName: 'tenant_x', tenantId: 't1', projectId: 'p1' },
    conversation: { _id: 'conv-1', agentKey: 'support' } as never,
    agentConfig: undefined,
    actor: { userId: 'u1' } as never,
  });

  it('goes through the guarded fetch and keeps the declared type (the upload checks it against the agent)', async () => {
    hoisted.safeFetch.mockResolvedValue(new Response('a,b\n1,2\n', { headers: { 'content-type': 'text/csv; charset=utf-8' } }));
    await expect(storeFile('https://files.example.com/x/report.csv')).resolves.toEqual({ attachments: ['file-1'], named: [] });
    expect(hoisted.safeFetch).toHaveBeenCalledWith('https://files.example.com/x/report.csv', { method: 'GET' });
    expect(hoisted.uploadSessionFile).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'report.csv', contentType: 'text/csv' }));
  });

  it('is capped at the agent file size limit while it is read', async () => {
    hoisted.safeFetch.mockResolvedValue(new Response(Buffer.alloc(1024 * 1024 + 1), { headers: { 'content-type': 'application/pdf' } }));
    await expect(storeFile('https://files.example.com/big.pdf')).rejects.toMatchObject({ status: 413, code: 'file_too_large' });
    expect(hoisted.uploadSessionFile).not.toHaveBeenCalled();
  });

  it('a file that cannot be fetched is a 400', async () => {
    hoisted.safeFetch.mockRejectedValue(new Error('Blocked address'));
    await expect(storeFile('http://10.0.0.1/a.pdf')).rejects.toMatchObject({ status: 400, code: 'attachment_unreachable' });
  });
});
