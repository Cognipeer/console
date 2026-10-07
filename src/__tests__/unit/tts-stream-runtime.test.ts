import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOpenAiTtsRuntime } from '@/lib/providers/contracts/openaiAudioHelpers';
import {
  alignPcm16Chunks,
  iterateResponseBody,
  pcmContentType,
  ttsMimeType,
} from '@/lib/providers/contracts/audioStream';
import { UpstreamRequestError } from '@/lib/providers/contracts/upstreamError';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/**
 * A response body the test feeds by hand. Like undici's, it errors with an
 * AbortError when the request signal aborts, and records a consumer cancel.
 */
function controllableBody(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  signal?.addEventListener('abort', () => {
    try {
      controller.error(new DOMException('This operation was aborted', 'AbortError'));
    } catch {
      // already closed
    }
  });
  return {
    stream,
    state,
    push: (...bytes: number[][]) => bytes.forEach((b) => controller.enqueue(new Uint8Array(b))),
    close: () => controller.close(),
  };
}

function bodyOf(chunks: number[][]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((b) => c.enqueue(new Uint8Array(b)));
      c.close();
    },
  });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init ?? {}),
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

const concat = (chunks: Uint8Array[]) => Buffer.concat(chunks.map((c) => Buffer.from(c)));

const runtime = () =>
  createOpenAiTtsRuntime({
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1/',
    modelId: 'gpt-4o-mini-tts',
  });

describe('alignPcm16Chunks', () => {
  async function* from(chunks: number[][]) {
    for (const c of chunks) yield new Uint8Array(c);
  }

  it('carries an odd trailing byte into the next chunk so every chunk holds whole samples', async () => {
    const out = await collect(alignPcm16Chunks(from([[1, 2, 3], [4], [5, 6, 7, 8, 9], [10]])));
    expect(out.map((c) => c.byteLength)).toEqual([2, 2, 4, 2]);
    expect([...concat(out)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('drops a half sample left over when the stream ends', async () => {
    const out = await collect(alignPcm16Chunks(from([[1, 2, 3], [4, 5]])));
    expect([...concat(out)]).toEqual([1, 2, 3, 4]);
  });

  it('passes aligned chunks through untouched and skips empty ones', async () => {
    const out = await collect(alignPcm16Chunks(from([[1, 2], [], [3, 4, 5, 6]])));
    expect(out.map((c) => [...c])).toEqual([[1, 2], [3, 4, 5, 6]]);
  });

  it('holds a lone byte back until its pair arrives', async () => {
    const out = await collect(alignPcm16Chunks(from([[1], [2], [3], [4]])));
    expect(out.map((c) => [...c])).toEqual([[1, 2], [3, 4]]);
  });

  it('keeps the byte stream intact for any chunking', async () => {
    const source = Array.from({ length: 997 }, (_, i) => i % 256);
    for (let trial = 0; trial < 25; trial++) {
      const chunks: number[][] = [];
      for (let i = 0; i < source.length; ) {
        const size = 1 + Math.floor(Math.random() * 37);
        chunks.push(source.slice(i, i + size));
        i += size;
      }
      const out = await collect(alignPcm16Chunks(from(chunks)));
      expect(out.every((c) => c.byteLength % 2 === 0)).toBe(true);
      expect([...concat(out)]).toEqual(source.slice(0, 996));
    }
  });
});

describe('iterateResponseBody', () => {
  it('cancels the body when the consumer stops early', async () => {
    const body = controllableBody();
    body.push([1, 2], [3, 4]);
    for await (const chunk of iterateResponseBody(body.stream)) {
      expect([...chunk]).toEqual([1, 2]);
      break;
    }
    expect(body.state.cancelled).toBe(true);
  });

  it('does not cancel a body that was read to the end', async () => {
    const body = controllableBody();
    body.push([1, 2]);
    body.close();
    const out = await collect(iterateResponseBody(body.stream));
    expect(out).toHaveLength(1);
    expect(body.state.cancelled).toBe(false);
  });
});

describe('content types', () => {
  it('labels pcm with its rate and maps containers to their MIME type', () => {
    expect(pcmContentType()).toBe('audio/L16;rate=24000');
    expect(pcmContentType(16000)).toBe('audio/L16;rate=16000');
    expect(ttsMimeType('mp3')).toBe('audio/mpeg');
    expect(ttsMimeType('pcm')).toBe('audio/L16');
  });
});

describe('createOpenAiTtsRuntime().synthesizeStream', () => {
  it('posts the speech request and yields audio as the body arrives', async () => {
    let body!: ReturnType<typeof controllableBody>;
    const spy = mockFetch((_url, init) => {
      body = controllableBody(init.signal);
      return new Response(body.stream, { status: 200, headers: { 'content-type': 'audio/pcm' } });
    });

    const iterable = await runtime().synthesizeStream!({ text: 'Merhaba', format: 'pcm' });
    const iterator = iterable[Symbol.asyncIterator]();

    body.push([1, 2, 3, 4]);
    expect([...(await iterator.next()).value!]).toEqual([1, 2, 3, 4]);
    body.push([5, 6]);
    expect([...(await iterator.next()).value!]).toEqual([5, 6]);
    body.close();
    expect((await iterator.next()).done).toBe(true);

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect((init as RequestInit).method).toBe('POST');
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toEqual({
      model: 'gpt-4o-mini-tts',
      input: 'Merhaba',
      voice: 'alloy',
      response_format: 'pcm',
    });
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
    });
  });

  it('keeps pcm chunks sample-aligned across odd network boundaries', async () => {
    mockFetch(() => new Response(bodyOf([[1, 2, 3], [4, 5, 6, 7], [8]]), { status: 200 }));
    const out = await collect(await runtime().synthesizeStream!({ text: 'x', format: 'pcm' }));
    expect(out.every((c) => c.byteLength % 2 === 0)).toBe(true);
    expect([...concat(out)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('does not re-chunk container formats', async () => {
    mockFetch(() => new Response(bodyOf([[1, 2, 3], [4]]), { status: 200 }));
    const out = await collect(await runtime().synthesizeStream!({ text: 'x', format: 'mp3' }));
    expect(out.map((c) => [...c])).toEqual([[1, 2, 3], [4]]);
  });

  it('defaults to mp3 like synthesize', async () => {
    const spy = mockFetch(() => new Response(bodyOf([[1]]), { status: 200 }));
    await collect(await runtime().synthesizeStream!({ text: 'x' }));
    expect(JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body)).response_format).toBe('mp3');
  });

  it('forwards the signal to fetch without sending it to the provider', async () => {
    const spy = mockFetch(() => new Response(bodyOf([[1, 2]]), { status: 200 }));
    const controller = new AbortController();
    await collect(
      await runtime().synthesizeStream!({
        text: 'x',
        format: 'pcm',
        voice: 'nova',
        speed: 1.2,
        instructions: 'calm',
        extra: { stream_format: 'audio' },
        signal: controller.signal,
      }),
    );
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-4o-mini-tts',
      input: 'x',
      voice: 'nova',
      response_format: 'pcm',
      speed: 1.2,
      instructions: 'calm',
      stream_format: 'audio',
    });
  });

  it('rejects before yielding anything when the upstream refuses the request', async () => {
    mockFetch(() => new Response('{"error":"bad voice"}', { status: 400 }));
    const error = await Promise.resolve(runtime().synthesizeStream!({ text: 'x', format: 'pcm' })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UpstreamRequestError);
    expect((error as UpstreamRequestError).status).toBe(400);
    expect((error as Error).message).toContain('OpenAI TTS failed (400)');
  });

  it('fails the pending read with an AbortError when the signal aborts mid-stream', async () => {
    let body!: ReturnType<typeof controllableBody>;
    mockFetch((_url, init) => {
      body = controllableBody(init.signal);
      return new Response(body.stream, { status: 200 });
    });
    const controller = new AbortController();
    const iterable = await runtime().synthesizeStream!({
      text: 'x',
      format: 'pcm',
      signal: controller.signal,
    });
    const iterator = iterable[Symbol.asyncIterator]();
    body.push([1, 2]);
    await iterator.next();
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels the upstream body when the consumer stops reading', async () => {
    let body!: ReturnType<typeof controllableBody>;
    mockFetch((_url, init) => {
      body = controllableBody(init.signal);
      return new Response(body.stream, { status: 200 });
    });
    const iterable = await runtime().synthesizeStream!({ text: 'x', format: 'pcm' });
    body.push([1, 2], [3, 4]);
    for await (const chunk of iterable) {
      expect(chunk.byteLength).toBe(2);
      break;
    }
    expect(body.state.cancelled).toBe(true);
  });

  it('falls back to reading the whole response when it has no readable body', async () => {
    mockFetch(
      () =>
        ({
          ok: true,
          status: 200,
          body: null,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer,
        }) as unknown as Response,
    );
    const out = await collect(await runtime().synthesizeStream!({ text: 'x', format: 'pcm' }));
    expect([...concat(out)]).toEqual([1, 2, 3, 4]);
  });

  it('uses the Azure URL builder and api-key header', async () => {
    const spy = mockFetch(() => new Response(bodyOf([[1, 2]]), { status: 200 }));
    const azure = createOpenAiTtsRuntime({
      apiKey: 'az-key',
      baseUrl: 'https://res.openai.azure.com/openai/deployments/tts',
      modelId: 'tts',
      extraHeaders: { 'api-key': 'az-key' },
      buildUrl: (path) =>
        `https://res.openai.azure.com/openai/deployments/tts${path}?api-version=2025-03-01-preview`,
    });
    await collect(await azure.synthesizeStream!({ text: 'x', format: 'pcm' }));
    expect(spy.mock.calls[0][0]).toBe(
      'https://res.openai.azure.com/openai/deployments/tts/audio/speech?api-version=2025-03-01-preview',
    );
    expect((spy.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'api-key': 'az-key' });
  });
});

describe('createOpenAiTtsRuntime().synthesize', () => {
  beforeEach(() => {
    mockFetch(() => new Response(new Uint8Array([9, 9]), { status: 200 }));
  });

  it('forwards the signal to fetch too', async () => {
    const controller = new AbortController();
    const result = await runtime().synthesize({ text: 'x', format: 'pcm', signal: controller.signal });
    const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(String(init.body))).not.toHaveProperty('signal');
    expect(result.format).toBe('pcm');
    expect(result.usage?.inputCharacters).toBe(1);
  });

  it('falls back to the format MIME type when the upstream sends no content type', async () => {
    mockFetch(
      () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => new Uint8Array([1]).buffer,
        }) as unknown as Response,
    );
    const result = await runtime().synthesize({ text: 'x', format: 'flac' });
    expect(result.contentType).toBe('audio/flac');
  });
});
