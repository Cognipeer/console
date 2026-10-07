import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleTranscriptionRequest } from '@/lib/services/models/inferenceService';
import { createOpenAiSttRuntime } from '@/lib/providers/contracts/openaiAudioHelpers';
import type { SttResult, SttTranscribeInput } from '@/lib/providers';

// ---- mocks ----
vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn(),
}));

vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: vi.fn(),
}));

vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('variant-key'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/models/usageLogger')>();
  return { ...original, logModelUsage: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn().mockResolvedValue({ action: 'allow', findings: [] }),
  createStreamGate: vi.fn(),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { getCircuitState, resetAllCircuits } from '@/lib/core/resilience';

const sttModel = {
  _id: 'model-stt',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'STT',
  key: 'stt-model',
  // Unique per file so circuit-breaker state never leaks between suites.
  providerKey: 'openai-abort-test',
  providerDriver: 'openai',
  category: 'stt' as const,
  modelId: 'gpt-4o-mini-transcribe',
  settings: {},
  pricing: {},
};

function installRuntime(transcribe: (input: SttTranscribeInput) => Promise<SttResult>) {
  const spy = vi.fn(transcribe);
  vi.mocked(buildModelRuntime).mockResolvedValue({
    runtime: { createSttRuntime: vi.fn().mockResolvedValue({ transcribe: spy }) },
  } as never);
  return spy;
}

const request = (overrides: Partial<Parameters<typeof handleTranscriptionRequest>[0]> = {}) => ({
  tenantDbName: 'tenant_db',
  modelKey: 'stt-model',
  projectId: 'proj-1',
  input: { audio: { data: Buffer.from('RIFF'), fileName: 'a.wav', contentType: 'audio/wav' } },
  ...overrides,
});

/** A provider call that only settles when its signal aborts. */
const hangUntilAborted = (input: SttTranscribeInput) =>
  new Promise<SttResult>((_, reject) => {
    input.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

describe('handleTranscriptionRequest — abort signal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllCircuits();
    vi.mocked(getModelByKey).mockResolvedValue(sttModel as never);
  });

  it('passes a signal to the runtime and transcribes normally when never aborted', async () => {
    const transcribe = installRuntime(async () => ({ text: 'merhaba', duration: 1.2 }));
    const result = await handleTranscriptionRequest(request({ signal: new AbortController().signal }));
    expect(result.response.text).toBe('merhaba');
    const input = transcribe.mock.calls[0][0];
    expect(input.signal).toBeInstanceOf(AbortSignal);
    await vi.waitFor(() => expect(logModelUsage).toHaveBeenCalledTimes(1));
  });

  it('aborts the in-flight provider call, rejects with AbortError, no retry, no usage row, no breaker failure', async () => {
    const transcribe = installRuntime(hangUntilAborted);
    const controller = new AbortController();
    const pending = handleTranscriptionRequest(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(logModelUsage).not.toHaveBeenCalled();
    expect(getCircuitState(`stt:${sttModel.providerKey}`)?.failures ?? 0).toBe(0);
  });

  it('an aborted call leaves the breaker exactly as it found it: it does not reset the failures the API traffic of the same key built up', async () => {
    // `stt:<providerKey>` is shared with /audio/transcriptions and the dashboard.
    // An attempt that resolved on abort counted as a SUCCESS and zeroed this.
    const circuit = `stt:${sttModel.providerKey}`;
    installRuntime(async () => {
      throw Object.assign(new Error('bad audio'), { status: 400 });
    });
    await expect(handleTranscriptionRequest(request())).rejects.toThrow('bad audio');
    await expect(handleTranscriptionRequest(request())).rejects.toThrow('bad audio');
    expect(getCircuitState(circuit)).toMatchObject({ state: 'closed', failures: 2 });

    const transcribe = installRuntime(hangUntilAborted);
    const controller = new AbortController();
    const pending = handleTranscriptionRequest(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    expect(getCircuitState(circuit)).toMatchObject({ state: 'closed', failures: 2 });
  });

  it('a result that arrives after the caller walked away is dropped: no usage row, AbortError', async () => {
    const controller = new AbortController();
    installRuntime(async () => {
      controller.abort();
      return { text: 'too late' };
    });
    await expect(handleTranscriptionRequest(request({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(logModelUsage).not.toHaveBeenCalled();
  });

  it('honours `input.signal` too', async () => {
    const transcribe = installRuntime(hangUntilAborted);
    const controller = new AbortController();
    const pending = handleTranscriptionRequest(request({
      input: { audio: { data: Buffer.from('RIFF') }, signal: controller.signal },
    }));
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('never calls the provider when the signal is already aborted', async () => {
    const transcribe = installRuntime(async () => ({ text: 'x' }));
    const controller = new AbortController();
    controller.abort();
    await expect(handleTranscriptionRequest(request({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(transcribe).not.toHaveBeenCalled();
    expect(buildModelRuntime).not.toHaveBeenCalled();
  });

  it('a provider failure that is not the caller abort still rejects with the provider error', async () => {
    installRuntime(async () => {
      throw Object.assign(new Error('bad audio'), { status: 400 });
    });
    await expect(handleTranscriptionRequest(request({ signal: new AbortController().signal }))).rejects.toThrow('bad audio');
  });
});

describe('OpenAI STT runtime — fetch signal', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('hands the input signal to fetch and keeps it out of the form', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const form = init.body as FormData;
      expect([...form.keys()]).not.toContain('signal');
      return new Response(JSON.stringify({ text: 'ok' }), { headers: { 'content-type': 'application/json' } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const runtime = createOpenAiSttRuntime({ apiKey: 'k', baseUrl: 'https://api.example.com/v1', modelId: 'whisper-1' });
    const controller = new AbortController();
    const result = await runtime.transcribe({ audio: { data: Buffer.from('x') }, signal: controller.signal });
    expect(result.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an aborted signal aborts the request', async () => {
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return new Response('{}');
    }) as unknown as typeof fetch;
    const runtime = createOpenAiSttRuntime({ apiKey: 'k', baseUrl: 'https://api.example.com/v1', modelId: 'whisper-1' });
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.transcribe({ audio: { data: Buffer.from('x') }, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
