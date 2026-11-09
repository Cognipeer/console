import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safeFetchMock = vi.hoisted(() => vi.fn());
const guardedFetchMock = vi.hoisted(() => vi.fn());
const assertPublicUrlMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/security/outboundFetch', () => ({
  safeFetch: safeFetchMock,
  assertPublicUrl: assertPublicUrlMock,
  privateNetworkBlockApplies: () => true,
}));
vi.mock('@/lib/core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/logger')>();
  return { ...actual, createLogger: () => ({ warn: warnMock, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) };
});
vi.mock('@/lib/services/providers/providerEndpointGuard', () => ({
  endpointGuardOptions: vi.fn((tenantId: string | undefined) => ({ forceBlock: true, tenantMarker: tenantId })),
}));

import { reloadConfig } from '@/lib/core/config';
import { runWithRequestContext } from '@/lib/core/requestContext';
import { createGuardedFetch } from '@/lib/providers/contracts/guardedFetch';

beforeEach(() => {
  safeFetchMock.mockReset();
  guardedFetchMock.mockReset();
  assertPublicUrlMock.mockReset();
  warnMock.mockReset();
  process.env.PROVIDER_RUNTIME_GUARD = 'enforce';
  reloadConfig();
});

afterEach(() => {
  delete process.env.PROVIDER_RUNTIME_GUARD;
  reloadConfig();
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

describe('guarded provider fetch in warn mode (default)', () => {
  beforeEach(() => {
    delete process.env.PROVIDER_RUNTIME_GUARD;
    reloadConfig();
  });

  it('attempts a target the guard would refuse and logs a warning once per host', async () => {
    const { OutboundPrivateTargetError } = await vi.importActual<typeof import('@/lib/security/outboundFetch')>('@/lib/security/outboundFetch');
    assertPublicUrlMock.mockRejectedValue(new OutboundPrivateTargetError('warn-host.internal.test'));
    safeFetchMock.mockResolvedValue(new Response('{}'));
    const guarded = createGuardedFetch();
    await runWithRequestContext({ requestId: 'r1', tenantId: 'tenant-a' }, () => guarded('http://warn-host.internal.test/v1'));
    await guarded('http://warn-host.internal.test/v2');
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(safeFetchMock.mock.calls[0][2]).toMatchObject({ allowPrivate: true, keepAbortLinked: true, timeoutMs: 600_000 });
    expect(safeFetchMock.mock.calls[0][2].followRedirects).toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][1]).toMatchObject({ tenantId: 'tenant-a', host: 'warn-host.internal.test' });
  });

  it('keeps the guard options for a target the guard accepts', async () => {
    assertPublicUrlMock.mockResolvedValue(new URL('https://api.example.com/'));
    safeFetchMock.mockResolvedValue(new Response('{}'));
    await createGuardedFetch()('https://api.example.com/v1');
    expect(safeFetchMock.mock.calls[0][2]).toMatchObject({ forceBlock: true });
    expect(safeFetchMock.mock.calls[0][2].allowPrivate).toBeUndefined();
    expect(warnMock).not.toHaveBeenCalled();
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
