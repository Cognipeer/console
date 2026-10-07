import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSpeechStreamRequest } from '@/lib/services/models/inferenceService';
import { getCircuitState, resetAllCircuits } from '@/lib/core/resilience';
import { UpstreamRequestError } from '@/lib/providers/contracts/upstreamError';
import type { TtsResult, TtsRuntime, TtsSynthesizeInput } from '@/lib/providers';

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
const TEXT = 'Merhaba, size nasıl yardımcı olabilirim?';

const ttsModel = (overrides = {}) => ({
  _id: 'model-tts',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'TTS',
  key: 'tts-model',
  providerKey: 'openai-main',
  providerDriver: 'openai',
  category: 'tts' as const,
  modelId: 'gpt-4o-mini-tts',
  settings: {},
  pricing: { inputCharacterPer1M: 15 },
  ...overrides,
});

const baseParams = (overrides: Partial<Parameters<typeof handleSpeechStreamRequest>[0]> = {}) => ({
  tenantDbName: 'tenant_db',
  modelKey: 'tts-model',
  projectId: 'proj-1',
  input: { text: TEXT, format: 'pcm' as const, voice: 'nova' },
  requestId: 'req-1',
  ...overrides,
});

/** A provider stream the test feeds by hand; aborting the signal fails the pending read. */
function manualSource(signal?: AbortSignal) {
  const queue: Array<Uint8Array | Error | null> = [];
  let wake: (() => void) | null = null;
  const state = { returned: false };
  const push = (item: Uint8Array | Error | null) => {
    queue.push(item);
    wake?.();
    wake = null;
  };
  signal?.addEventListener('abort', () =>
    push(new DOMException('This operation was aborted', 'AbortError') as unknown as Error),
  );
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0) await new Promise<void>((r) => (wake = r));
          const item = queue.shift()!;
          if (item === null) return { done: true, value: undefined };
          if (item instanceof Error || (item as unknown) instanceof DOMException) throw item;
          return { done: false, value: item as Uint8Array };
        },
        async return() {
          state.returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return {
    iterable,
    state,
    chunk: (...bytes: number[]) => push(new Uint8Array(bytes)),
    fail: (error: Error) => push(error),
    end: () => push(null),
  };
}

function installRuntime(tts: Partial<TtsRuntime>) {
  vi.mocked(buildModelRuntime).mockResolvedValue({
    runtime: { createTtsRuntime: vi.fn().mockResolvedValue(tts) },
  } as never);
}

/** A runtime whose synthesizeStream hands back a manual source and records the input it got. */
function streamingRuntime() {
  const calls: TtsSynthesizeInput[] = [];
  let source!: ReturnType<typeof manualSource>;
  const synthesizeStream = vi.fn(async (input: TtsSynthesizeInput) => {
    calls.push(input);
    source = manualSource(input.signal);
    return source.iterable;
  });
  const synthesize = vi.fn();
  installRuntime({ synthesize, synthesizeStream });
  return { calls, synthesize, synthesizeStream, source: () => source };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const usageCalls = () => vi.mocked(logModelUsage).mock.calls.map((c) => c[2]);

describe('handleSpeechStreamRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllCircuits();
    vi.mocked(getModelByKey).mockResolvedValue(ttsModel() as never);
  });

  it('relays provider chunks as they arrive and logs usage when the stream ends', async () => {
    const rt = streamingRuntime();
    const result = await handleSpeechStreamRequest(baseParams());

    expect(result).toMatchObject({
      format: 'pcm',
      sampleRate: 24000,
      contentType: 'audio/L16;rate=24000',
      streamed: true,
      requestId: 'req-1',
    });
    expect(rt.calls[0]).toMatchObject({ text: TEXT, format: 'pcm', voice: 'nova' });
    expect(rt.calls[0].signal).toBeInstanceOf(AbortSignal);

    const iterator = result.stream[Symbol.asyncIterator]();
    rt.source().chunk(1, 2, 3, 4);
    const first = await iterator.next();
    expect(Buffer.isBuffer(first.value)).toBe(true);
    expect([...first.value!]).toEqual([1, 2, 3, 4]);
    // Nothing is billed until the stream is over.
    expect(logModelUsage).not.toHaveBeenCalled();

    rt.source().chunk(5, 6);
    expect([...(await iterator.next()).value!]).toEqual([5, 6]);
    rt.source().end();
    expect((await iterator.next()).done).toBe(true);

    const done = await result.done;
    expect(done).toMatchObject({ bytes: 6, status: 'completed' });
    expect(done.firstByteMs).not.toBeNull();
    expect(done.latencyMs).toBeGreaterThanOrEqual(done.firstByteMs!);
    expect(done.usage.inputCharacters).toBe(TEXT.length);

    expect(logModelUsage).toHaveBeenCalledTimes(1);
    const [tenantDb, model, payload] = vi.mocked(logModelUsage).mock.calls[0];
    expect(tenantDb).toBe('tenant_db');
    expect(model).toMatchObject({ key: 'tts-model' });
    expect(payload).toMatchObject({
      requestId: 'req-1',
      route: 'audio.speech',
      status: 'success',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, inputCharacters: TEXT.length },
      providerRequest: { model: 'tts-model', voice: 'nova', format: 'pcm', characterCount: TEXT.length, stream: true },
      providerResponse: { audioBytes: 6, streamed: true, format: 'pcm' },
    });
  });

  it('re-aligns pcm from a runtime that splits samples across chunks', async () => {
    const rt = streamingRuntime();
    const result = await handleSpeechStreamRequest(baseParams());
    rt.source().chunk(1, 2, 3);
    rt.source().chunk(4);
    rt.source().chunk(5, 6, 7);
    rt.source().end();
    const out: Buffer[] = [];
    for await (const chunk of result.stream) out.push(chunk);
    expect(out.every((c) => c.byteLength % 2 === 0)).toBe(true);
    expect([...Buffer.concat(out)]).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await result.done).bytes).toBe(6);
  });

  it('passes container formats through as-is with a null sample rate', async () => {
    const rt = streamingRuntime();
    const result = await handleSpeechStreamRequest(
      baseParams({ input: { text: 'hi', format: 'mp3' } }),
    );
    expect(result).toMatchObject({ format: 'mp3', sampleRate: null, contentType: 'audio/mpeg' });
    rt.source().chunk(1, 2, 3);
    rt.source().end();
    const out: Buffer[] = [];
    for await (const chunk of result.stream) out.push(chunk);
    expect(out.map((c) => c.byteLength)).toEqual([3]);
  });

  it('asks the runtime for mp3 when no format is given, like the buffered route', async () => {
    const rt = streamingRuntime();
    const result = await handleSpeechStreamRequest(baseParams({ input: { text: 'hi' } }));
    expect(rt.calls[0].format).toBe('mp3');
    expect(result.format).toBe('mp3');
  });

  describe('fallback when the runtime cannot stream', () => {
    it('synthesizes once and hands the audio out as a single chunk', async () => {
      const synthesize = vi.fn<(input: TtsSynthesizeInput) => Promise<TtsResult>>(async () => ({
        audio: Buffer.from([1, 2, 3, 4, 5]),
        contentType: 'audio/pcm',
        format: 'pcm',
        usage: { inputCharacters: 7, outputSeconds: 0.5 },
      }));
      installRuntime({ synthesize });

      const result = await handleSpeechStreamRequest(baseParams());
      expect(result).toMatchObject({
        streamed: false,
        format: 'pcm',
        sampleRate: 24000,
        contentType: 'audio/L16;rate=24000',
      });
      expect(synthesize.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);

      const out: Buffer[] = [];
      for await (const chunk of result.stream) out.push(chunk);
      // A half sample at the end is dropped, same as the streamed path.
      expect(out.map((c) => [...c])).toEqual([[1, 2, 3, 4]]);

      const done = await result.done;
      expect(done).toMatchObject({ status: 'completed', bytes: 4 });
      expect(done.firstByteMs).not.toBeNull();
      expect(usageCalls()).toHaveLength(1);
      expect(usageCalls()[0]).toMatchObject({
        route: 'audio.speech',
        status: 'success',
        usage: { inputCharacters: 7, outputSeconds: 0.5 },
        providerResponse: { streamed: false, audioBytes: 4 },
      });
    });

    it('keeps the provider content type for containers', async () => {
      installRuntime({
        synthesize: vi.fn(async () => ({
          audio: Buffer.from([1, 2, 3]),
          contentType: 'audio/mpeg',
          format: 'mp3' as const,
        })),
      });
      const result = await handleSpeechStreamRequest(baseParams({ input: { text: 'hi' } }));
      expect(result).toMatchObject({ format: 'mp3', contentType: 'audio/mpeg', sampleRate: null });
    });

    it('returns an empty, cancelled stream when aborted while synthesizing', async () => {
      const controller = new AbortController();
      const synthesize = vi.fn(
        (input: TtsSynthesizeInput) =>
          new Promise<never>((_, reject) =>
            input.signal!.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            ),
          ),
      );
      installRuntime({ synthesize });
      const pending = handleSpeechStreamRequest(baseParams({ signal: controller.signal }));
      await flush();
      controller.abort();
      const result = await pending;
      const out: Buffer[] = [];
      for await (const chunk of result.stream) out.push(chunk);
      expect(out).toHaveLength(0);
      expect((await result.done).status).toBe('cancelled');
      expect(synthesize).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancellation', () => {
    it('ends the stream quietly on a mid-stream abort and still bills the characters', async () => {
      const rt = streamingRuntime();
      const controller = new AbortController();
      const result = await handleSpeechStreamRequest(baseParams({ signal: controller.signal }));
      const iterator = result.stream[Symbol.asyncIterator]();
      rt.source().chunk(1, 2);
      await iterator.next();

      const pending = iterator.next();
      controller.abort();
      expect((await pending).done).toBe(true);
      expect(rt.calls[0].signal!.aborted).toBe(true);

      const done = await result.done;
      expect(done).toMatchObject({ status: 'cancelled', bytes: 2 });
      expect(usageCalls()).toHaveLength(1);
      expect(usageCalls()[0]).toMatchObject({
        route: 'audio.speech',
        status: 'cancelled',
        usage: { inputCharacters: TEXT.length },
        providerResponse: { cancelled: true, audioBytes: 2 },
      });
    });

    it('settles right away when aborted while nobody is reading', async () => {
      const rt = streamingRuntime();
      const controller = new AbortController();
      const result = await handleSpeechStreamRequest(baseParams({ signal: controller.signal }));
      controller.abort();
      const done = await result.done;
      expect(done).toMatchObject({ status: 'cancelled', bytes: 0, firstByteMs: null });
      expect(rt.calls[0].signal!.aborted).toBe(true);
      // A late reader gets nothing, and nothing is logged twice.
      const out: Buffer[] = [];
      for await (const chunk of result.stream) out.push(chunk);
      expect(out).toHaveLength(0);
      expect(usageCalls()).toHaveLength(1);
    });

    it('honours a signal passed on the input as well', async () => {
      const rt = streamingRuntime();
      const controller = new AbortController();
      const result = await handleSpeechStreamRequest(
        baseParams({ input: { text: TEXT, format: 'pcm', signal: controller.signal } }),
      );
      controller.abort();
      expect((await result.done).status).toBe('cancelled');
      expect(rt.calls[0].signal!.aborted).toBe(true);
    });

    it('stops the provider and bills when the consumer stops reading early', async () => {
      const rt = streamingRuntime();
      const result = await handleSpeechStreamRequest(baseParams());
      rt.source().chunk(1, 2);
      rt.source().chunk(3, 4);
      for await (const chunk of result.stream) {
        expect(chunk.byteLength).toBe(2);
        break;
      }
      expect(rt.calls[0].signal!.aborted).toBe(true);
      expect(rt.source().state.returned).toBe(true);
      expect(await result.done).toMatchObject({ status: 'cancelled', bytes: 2 });
      expect(usageCalls()[0]).toMatchObject({ status: 'cancelled', usage: { inputCharacters: TEXT.length } });
    });

    it('never calls the provider for an already-aborted signal', async () => {
      const rt = streamingRuntime();
      const result = await handleSpeechStreamRequest(baseParams({ signal: AbortSignal.abort() }));
      expect(rt.synthesizeStream).not.toHaveBeenCalled();
      expect(await result.done).toMatchObject({ status: 'cancelled', bytes: 0 });
      expect(logModelUsage).not.toHaveBeenCalled();
    });

    it('does not retry or trip the circuit breaker when aborted while opening', async () => {
      const controller = new AbortController();
      const synthesizeStream = vi.fn(
        (input: TtsSynthesizeInput) =>
          new Promise<AsyncIterable<Uint8Array>>((_, reject) =>
            input.signal!.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            ),
          ),
      );
      installRuntime({ synthesize: vi.fn(), synthesizeStream });

      const pending = handleSpeechStreamRequest(baseParams({ signal: controller.signal }));
      await flush();
      controller.abort();
      const result = await pending;

      expect(synthesizeStream).toHaveBeenCalledTimes(1);
      expect(getCircuitState('tts-stream:openai-main')?.failures ?? 0).toBe(0);
      const out: Buffer[] = [];
      for await (const chunk of result.stream) out.push(chunk);
      expect(out).toHaveLength(0);
      expect(await result.done).toMatchObject({ status: 'cancelled', bytes: 0 });
      // The text reached the provider, so it is billed like any cancelled stream.
      expect(usageCalls()).toHaveLength(1);
      expect(usageCalls()[0]).toMatchObject({ status: 'cancelled', usage: { inputCharacters: TEXT.length } });
    });
  });

  describe('the circuit breaker the barge-ins share with every other caller', () => {
    const refusing = () =>
      vi.fn(async () => {
        throw new UpstreamRequestError('OpenAI TTS failed (400): bad voice', 400, 'bad voice');
      });

    it('an abort while the stream is being opened does not reset the failures already counted', async () => {
      installRuntime({ synthesize: vi.fn(), synthesizeStream: refusing() });
      for (let i = 0; i < 2; i += 1) {
        await expect(handleSpeechStreamRequest(baseParams())).rejects.toMatchObject({ status: 400 });
      }
      expect(getCircuitState('tts-stream:openai-main')).toMatchObject({ state: 'closed', failures: 2 });

      const controller = new AbortController();
      installRuntime({
        synthesize: vi.fn(),
        synthesizeStream: vi.fn(
          (input: TtsSynthesizeInput) =>
            new Promise<AsyncIterable<Uint8Array>>((_, reject) =>
              input.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
            ),
        ),
      });
      const pending = handleSpeechStreamRequest(baseParams({ signal: controller.signal }));
      await flush();
      controller.abort();
      expect((await (await pending).done).status).toBe('cancelled');

      // An attempt that resolved on abort would have recorded a success: failures back to 0.
      expect(getCircuitState('tts-stream:openai-main')).toMatchObject({ state: 'closed', failures: 2 });
    });

    it('the same holds for the one-shot fallback of a runtime that cannot stream', async () => {
      installRuntime({ synthesize: refusing() });
      for (let i = 0; i < 2; i += 1) {
        await expect(handleSpeechStreamRequest(baseParams())).rejects.toMatchObject({ status: 400 });
      }
      expect(getCircuitState('tts:openai-main')).toMatchObject({ state: 'closed', failures: 2 });

      const controller = new AbortController();
      installRuntime({
        synthesize: vi.fn(
          (input: TtsSynthesizeInput) =>
            new Promise<never>((_, reject) =>
              input.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
            ),
        ),
      });
      const pending = handleSpeechStreamRequest(baseParams({ signal: controller.signal }));
      await flush();
      controller.abort();
      expect((await (await pending).done).status).toBe('cancelled');
      expect(getCircuitState('tts:openai-main')).toMatchObject({ state: 'closed', failures: 2 });
    });
  });

  describe('failures', () => {
    it('surfaces a mid-stream fault from the iterator and logs it as an error', async () => {
      const rt = streamingRuntime();
      const result = await handleSpeechStreamRequest(baseParams());
      const iterator = result.stream[Symbol.asyncIterator]();
      rt.source().chunk(1, 2);
      await iterator.next();
      rt.source().fail(new Error('socket hang up'));
      await expect(iterator.next()).rejects.toThrow('socket hang up');

      expect(await result.done).toMatchObject({ status: 'error', bytes: 2 });
      expect(usageCalls()[0]).toMatchObject({
        route: 'audio.speech',
        status: 'error',
        errorMessage: 'socket hang up',
        usage: { inputCharacters: TEXT.length },
      });
    });

    it('rejects when the provider refuses the request, without a usage row', async () => {
      const synthesizeStream = vi.fn(async () => {
        throw new UpstreamRequestError('OpenAI TTS failed (400): bad voice', 400, 'bad voice');
      });
      installRuntime({ synthesize: vi.fn(), synthesizeStream });
      const controller = new AbortController();
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

      await expect(
        handleSpeechStreamRequest(baseParams({ signal: controller.signal })),
      ).rejects.toMatchObject({ status: 400 });
      // 400 is not retryable.
      expect(synthesizeStream).toHaveBeenCalledTimes(1);
      expect(logModelUsage).not.toHaveBeenCalled();
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('retries opening the stream on a transient upstream failure', async () => {
      let attempt = 0;
      const synthesizeStream = vi.fn(async (input: TtsSynthesizeInput) => {
        attempt += 1;
        if (attempt === 1) throw new UpstreamRequestError('OpenAI TTS failed (503): busy', 503);
        const source = manualSource(input.signal);
        source.chunk(1, 2);
        source.end();
        return source.iterable;
      });
      installRuntime({ synthesize: vi.fn(), synthesizeStream });

      const result = await handleSpeechStreamRequest(baseParams());
      const out: Buffer[] = [];
      for await (const chunk of result.stream) out.push(chunk);
      expect(synthesizeStream).toHaveBeenCalledTimes(2);
      expect(out).toHaveLength(1);
      expect((await result.done).status).toBe('completed');
    });

    it('throws for an unknown model', async () => {
      vi.mocked(getModelByKey).mockResolvedValue(null as never);
      await expect(handleSpeechStreamRequest(baseParams())).rejects.toThrow(
        'Model with key tts-model not found',
      );
    });

    it('rejects a model that is not a TTS model', async () => {
      vi.mocked(getModelByKey).mockResolvedValue(ttsModel({ category: 'llm' }) as never);
      await expect(handleSpeechStreamRequest(baseParams())).rejects.toMatchObject({ status: 400 });
    });

    it('rejects a provider without text-to-speech', async () => {
      vi.mocked(buildModelRuntime).mockResolvedValue({ runtime: {} } as never);
      await expect(handleSpeechStreamRequest(baseParams())).rejects.toThrow(
        'Model provider does not support text-to-speech',
      );
    });
  });
});
