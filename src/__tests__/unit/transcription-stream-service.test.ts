import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleTranscriptionStreamRequest,
  TranscriptionStreamUnsupportedError,
} from '@/lib/services/models/inferenceService';
import type { SttResult, SttStream, SttStreamOptions } from '@/lib/providers';

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

// ---- helpers ----
const sttModel = (overrides = {}) => ({
  _id: 'model-stt',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'STT',
  key: 'stt-model',
  providerKey: 'openai-main',
  providerDriver: 'openai',
  category: 'stt' as const,
  modelId: 'gpt-4o-mini-transcribe',
  settings: {},
  pricing: {},
  ...overrides,
});

/** A runtime stream whose finish() the test settles by hand. */
function fakeStream() {
  let resolveFinish!: (r: SttResult) => void;
  let rejectFinish!: (e: Error) => void;
  const finished = new Promise<SttResult>((resolve, reject) => {
    resolveFinish = resolve;
    rejectFinish = reject;
  });
  // Created eagerly here (the real runtime creates it in finish()), so a close()
  // before finish() must not surface as an unhandled rejection.
  finished.catch(() => undefined);
  const partials: Array<(text: string, delta: string) => void> = [];
  const stream = {
    push: vi.fn(),
    finish: vi.fn(() => finished),
    onPartial: vi.fn((cb: (text: string, delta: string) => void) => partials.push(cb)),
    close: vi.fn(() => {
      const error = new Error('closed');
      error.name = 'AbortError';
      rejectFinish(error);
    }),
  } satisfies SttStream;
  return { stream, resolveFinish, rejectFinish, emitPartial: (t: string, d: string) => partials.forEach((cb) => cb(t, d)) };
}

function installStreamingRuntime() {
  const fake = fakeStream();
  const createStream = vi.fn<(opts: SttStreamOptions) => SttStream>(() => fake.stream);
  vi.mocked(buildModelRuntime).mockResolvedValue({
    runtime: {
      createSttRuntime: vi.fn().mockResolvedValue({ transcribe: vi.fn(), createStream }),
    },
  } as never);
  return { ...fake, createStream };
}

const params = (overrides: Partial<Parameters<typeof handleTranscriptionStreamRequest>[0]> = {}) => ({
  tenantDbName: 'tenant_db',
  modelKey: 'stt-model',
  projectId: 'proj-1',
  options: { sampleRate: 16000 as const, language: 'tr' },
  requestId: 'req-stt',
  ...overrides,
});

const usageCalls = () => vi.mocked(logModelUsage).mock.calls.map((c) => c[2]);

describe('handleTranscriptionStreamRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getModelByKey).mockResolvedValue(sttModel() as never);
  });

  it('opens a provider stream and logs the transcription when it finishes', async () => {
    const rt = installStreamingRuntime();
    const { stream, requestId, model } = await handleTranscriptionStreamRequest(params());
    expect(requestId).toBe('req-stt');
    expect(model).toMatchObject({ key: 'stt-model' });
    expect(rt.createStream).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 16000, language: 'tr' }));

    const partials: string[] = [];
    stream.onPartial((text) => partials.push(text));
    rt.emitPartial('Mer', 'Mer');

    stream.push(new Int16Array(8000));
    stream.push(new Int16Array(8000));
    expect(rt.stream.push).toHaveBeenCalledTimes(2);

    const pending = stream.finish();
    expect(stream.finish()).toBe(pending);
    rt.resolveFinish({
      text: 'Merhaba',
      language: 'tr',
      duration: 1,
      usage: { inputSeconds: 1, inputTokens: 12, outputTokens: 3 },
    });
    await expect(pending).resolves.toMatchObject({ text: 'Merhaba' });

    expect(partials).toEqual(['Mer']);
    expect(usageCalls()).toHaveLength(1);
    expect(usageCalls()[0]).toMatchObject({
      requestId: 'req-stt',
      route: 'audio.transcriptions',
      status: 'success',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, inputSeconds: 1 },
      providerRequest: { model: 'stt-model', language: 'tr', sampleRate: 16000, audioSeconds: 1, stream: true },
      providerResponse: { text: 'Merhaba', language: 'tr', duration: 1 },
    });

    // Closing after a finished stream is cleanup, not a cancellation.
    stream.close();
    expect(usageCalls()).toHaveLength(1);
  });

  it('logs a cancelled stream with the audio sent so far', async () => {
    installStreamingRuntime();
    const { stream } = await handleTranscriptionStreamRequest(params());
    stream.push(new Int16Array(4000));
    stream.close();
    expect(usageCalls()).toHaveLength(1);
    expect(usageCalls()[0]).toMatchObject({
      route: 'audio.transcriptions',
      status: 'cancelled',
      usage: { inputSeconds: 0.25 },
    });
  });

  it('logs nothing for a stream closed before any audio', async () => {
    installStreamingRuntime();
    const { stream } = await handleTranscriptionStreamRequest(params());
    stream.close();
    expect(logModelUsage).not.toHaveBeenCalled();
  });

  it('treats an abort during finish() as a cancellation, not an error', async () => {
    const rt = installStreamingRuntime();
    const controller = new AbortController();
    const { stream } = await handleTranscriptionStreamRequest(params({ signal: controller.signal }));
    expect(rt.createStream.mock.calls[0][0].signal).toBe(controller.signal);
    stream.push(new Int16Array(1600));
    const pending = stream.finish();
    controller.abort();
    rt.stream.close();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(usageCalls()).toHaveLength(1);
    expect(usageCalls()[0]).toMatchObject({ status: 'cancelled', usage: { inputSeconds: 0.1 } });
  });

  it('logs an aborted signal before finish() as cancelled', async () => {
    installStreamingRuntime();
    const controller = new AbortController();
    const { stream } = await handleTranscriptionStreamRequest(params({ signal: controller.signal }));
    stream.push(new Int16Array(1600));
    controller.abort();
    expect(usageCalls()).toHaveLength(1);
    expect(usageCalls()[0]).toMatchObject({ status: 'cancelled' });
  });

  it('combines the call signal with one passed in the options', async () => {
    const rt = installStreamingRuntime();
    const outer = new AbortController();
    const inner = new AbortController();
    await handleTranscriptionStreamRequest(
      params({ signal: outer.signal, options: { sampleRate: 24000, signal: inner.signal } }),
    );
    const passed = rt.createStream.mock.calls[0][0].signal!;
    expect(passed.aborted).toBe(false);
    inner.abort();
    expect(passed.aborted).toBe(true);
  });

  it('logs a provider failure as an error and rethrows it', async () => {
    const rt = installStreamingRuntime();
    const { stream } = await handleTranscriptionStreamRequest(params());
    stream.push(new Int16Array(1600));
    const pending = stream.finish();
    rt.rejectFinish(new Error('OpenAI realtime transcription failed: bad audio'));
    await expect(pending).rejects.toThrow('bad audio');
    expect(usageCalls()[0]).toMatchObject({
      status: 'error',
      errorMessage: 'OpenAI realtime transcription failed: bad audio',
      usage: {},
    });
  });

  it('throws TranscriptionStreamUnsupportedError when the provider cannot stream', async () => {
    vi.mocked(buildModelRuntime).mockResolvedValue({
      runtime: { createSttRuntime: vi.fn().mockResolvedValue({ transcribe: vi.fn() }) },
    } as never);
    await expect(handleTranscriptionStreamRequest(params())).rejects.toBeInstanceOf(
      TranscriptionStreamUnsupportedError,
    );
  });

  it('rejects a model that is not an STT model', async () => {
    vi.mocked(getModelByKey).mockResolvedValue(sttModel({ category: 'tts' }) as never);
    await expect(handleTranscriptionStreamRequest(params())).rejects.toMatchObject({ status: 400 });
  });

  it('throws for an unknown model', async () => {
    vi.mocked(getModelByKey).mockResolvedValue(null as never);
    await expect(handleTranscriptionStreamRequest(params())).rejects.toThrow('Model with key stt-model not found');
  });
});
