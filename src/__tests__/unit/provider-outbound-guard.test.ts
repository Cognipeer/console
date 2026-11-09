import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeFetchMock = vi.hoisted(() => vi.fn());
const guardedFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: safeFetchMock }));
vi.mock('@/lib/services/providers/providerEndpointGuard', () => ({
  endpointGuardOptions: vi.fn((tenantId: string | undefined) => ({ forceBlock: true, tenantMarker: tenantId })),
}));

import { runWithRequestContext } from '@/lib/core/requestContext';
import { createGuardedFetch } from '@/lib/providers/contracts/guardedFetch';

beforeEach(() => {
  safeFetchMock.mockReset();
  guardedFetchMock.mockReset();
});

describe('guarded provider fetch', () => {
  it('sends each call through the outbound guard without following redirects', async () => {
    safeFetchMock.mockResolvedValue(new Response('{}'));
    await createGuardedFetch()('https://api.example.com/v1/chat', { method: 'POST', body: '{}' });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(safeFetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat');
    expect(safeFetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(safeFetchMock.mock.calls[0][2]).toMatchObject({ forceBlock: true, followRedirects: false, keepAbortLinked: true });
  });

  it('accepts URL and Request inputs', async () => {
    safeFetchMock.mockResolvedValue(new Response('{}'));
    const guarded = createGuardedFetch();
    await guarded(new URL('https://api.example.com/a'));
    await guarded(new Request('https://api.example.com/b', { method: 'POST', headers: { 'x-test': '1' }, body: 'x' }));
    expect(safeFetchMock.mock.calls[0][0]).toBe('https://api.example.com/a');
    expect(safeFetchMock.mock.calls[1][0]).toBe('https://api.example.com/b');
    expect(safeFetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
  });

  it('takes the organization from the request context at call time', async () => {
    safeFetchMock.mockResolvedValue(new Response('{}'));
    const guarded = createGuardedFetch();
    await runWithRequestContext({ requestId: 'r1', tenantId: 'tenant-a' }, () => guarded('https://api.example.com/'));
    await guarded('https://api.example.com/');
    expect(safeFetchMock.mock.calls[0][2]).toMatchObject({ tenantMarker: 'tenant-a' });
    expect(safeFetchMock.mock.calls[1][2].tenantMarker).toBeUndefined();
  });

  it('lets a refused target fail the call', async () => {
    safeFetchMock.mockRejectedValue(new Error('target refused'));
    await expect(createGuardedFetch()('http://10.0.0.5/v1')).rejects.toThrow('target refused');
  });
});

describe('OCR contracts', () => {
  it('rejects a service account token endpoint outside Google API hosts', async () => {
    vi.resetModules();
    vi.doMock('@/lib/providers/contracts/guardedFetch', () => ({ guardedFetch: guardedFetchMock }));
    const { GoogleDocumentAiProviderContract } = await import('@/lib/providers/contracts/googleDocumentAi.contract');
    const runtime = await GoogleDocumentAiProviderContract.createRuntime({
      credentials: {
        serviceAccountKey: JSON.stringify({ client_email: 'a@b.c', private_key: 'x', token_uri: 'https://tokens.example.com/token' }),
      },
      settings: { projectId: 'p', location: 'us', processorId: 'abc' },
    } as never);
    const ocr = await runtime.createOcrRuntime!({ modelId: 'm' } as never);
    await expect(ocr.extract({ document: { kind: 'bytes', data: Buffer.from('x'), contentType: 'application/pdf' } } as never))
      .rejects.toThrow(/token_uri/);
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it('rejects a processor location that is not a plain segment', async () => {
    vi.resetModules();
    vi.doMock('@/lib/providers/contracts/guardedFetch', () => ({ guardedFetch: guardedFetchMock }));
    const { GoogleDocumentAiProviderContract } = await import('@/lib/providers/contracts/googleDocumentAi.contract');
    const runtime = await GoogleDocumentAiProviderContract.createRuntime({
      credentials: { serviceAccountKey: JSON.stringify({ client_email: 'a@b.c', private_key: 'x' }) },
      settings: { projectId: 'p', location: 'us.example.com/x', processorId: 'abc' },
    } as never);
    const ocr = await runtime.createOcrRuntime!({ modelId: 'm' } as never);
    await expect(ocr.extract({ document: { kind: 'bytes', data: Buffer.from('x') } } as never)).rejects.toThrow(/may contain only/);
    expect(guardedFetchMock).not.toHaveBeenCalled();
  });

  it('refuses an operation location on another origin than the configured endpoint', async () => {
    vi.resetModules();
    vi.doMock('@/lib/providers/contracts/guardedFetch', () => ({ guardedFetch: guardedFetchMock }));
    guardedFetchMock.mockResolvedValue(
      new Response(null, { status: 202, headers: { 'operation-location': 'https://other.example.net/operations/1' } }),
    );
    const { AzureDocumentIntelligenceProviderContract } = await import('@/lib/providers/contracts/azureDocumentIntelligence.contract');
    const runtime = await AzureDocumentIntelligenceProviderContract.createRuntime({
      credentials: { apiKey: 'k' },
      settings: { endpoint: 'https://res.cognitiveservices.azure.com' },
    } as never);
    const ocr = await runtime.createOcrRuntime!({ modelId: 'prebuilt-read' } as never);
    await expect(ocr.extract({ document: { kind: 'bytes', data: Buffer.from('x'), contentType: 'application/pdf' } } as never))
      .rejects.toThrow(/operation-location does not match/);
    expect(guardedFetchMock).toHaveBeenCalledTimes(1);
  });
});
