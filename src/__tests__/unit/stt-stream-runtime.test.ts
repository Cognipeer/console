import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { AddressInfo } from 'net';
import type { IncomingMessage } from 'http';
import { LinearPcm16Resampler } from '@/lib/providers/contracts/audioStream';
import {
  OPENAI_REALTIME_TRANSCRIPTION_URL,
  buildTranscriptionSessionUpdate,
  createOpenAiRealtimeTranscriptionStream,
  mapRealtimeTranscriptionUsage,
} from '@/lib/providers/contracts/openaiRealtimeTranscription';
import { createOpenAiSttRuntime } from '@/lib/providers/contracts/openaiAudioHelpers';
import {
  AzureModelProviderContract,
  OpenAiCompatibleModelProviderContract,
  OpenAiModelProviderContract,
} from '@/lib/providers/contracts/modelContracts';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import type { SttRuntime, SttStreamOptions } from '@/lib/providers';

// ---- a scripted stand-in for OpenAI's realtime transcription endpoint ----

type Event = Record<string, unknown>;

interface FakeServerOptions {
  /** Called for every client event after the built-in session handshake. */
  onEvent?: (event: Event, reply: (e: Event) => void, socket: ServerSocket) => void;
  /** Skip `session.updated` (session never becomes ready). */
  neverReady?: boolean;
  /** Withhold `session.updated` until this promise resolves (a handshake the test controls). */
  holdReady?: Promise<void>;
  /** Refuse the handshake with this HTTP status. */
  rejectStatus?: number;
}

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.clients.forEach((client) => client.terminate());
          server.close(() => resolve());
        }),
    ),
  );
});

async function fakeRealtime(options: FakeServerOptions = {}) {
  const received: Event[] = [];
  const requests: IncomingMessage[] = [];
  let closedByClient = false;
  const server = new WebSocketServer({
    port: 0,
    verifyClient: options.rejectStatus
      ? (_info, cb) => cb(false, options.rejectStatus)
      : undefined,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  server.on('connection', (socket, request) => {
    requests.push(request);
    const reply = (event: Event) => socket.send(JSON.stringify(event));
    socket.on('close', () => {
      closedByClient = true;
    });
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Event;
      received.push(event);
      if (event.type === 'session.update') {
        if (!options.neverReady) {
          const acknowledge = () => reply({ type: 'session.updated', session: event.session });
          if (options.holdReady) void options.holdReady.then(acknowledge);
          else acknowledge();
        }
        return;
      }
      options.onEvent?.(event, reply, socket);
    });
    reply({ type: 'session.created', session: { type: 'transcription' } });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/v1/realtime?intent=transcription`,
    received,
    requests,
    closedByClient: () => closedByClient,
    appendedSamples: () =>
      received
        .filter((e) => e.type === 'input_audio_buffer.append')
        .reduce((n, e) => n + Buffer.from(String(e.audio), 'base64').byteLength / 2, 0),
  };
}

/** Answers a commit the way OpenAI does: committed → deltas → completed. */
const transcribeOnCommit =
  (transcript: string, extra: Event = {}) =>
  (event: Event, reply: (e: Event) => void) => {
    if (event.type !== 'input_audio_buffer.commit') return;
    reply({ type: 'input_audio_buffer.committed', item_id: 'item_1', previous_item_id: null });
    const half = Math.ceil(transcript.length / 2);
    reply({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', content_index: 0, delta: transcript.slice(0, half) });
    reply({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', content_index: 0, delta: transcript.slice(half) });
    reply({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_1',
      content_index: 0,
      transcript,
      ...extra,
    });
  };

const open = (url: string, opts: Partial<SttStreamOptions> = {}, modelId = 'gpt-4o-mini-transcribe', timeouts = {}) =>
  createOpenAiRealtimeTranscriptionStream(
    { url, headers: { Authorization: 'Bearer sk-test', 'OpenAI-Organization': 'org-1' }, modelId, ...timeouts },
    { sampleRate: 24000, ...opts },
  );

const tone = (samples: number, value = 1000) => new Int16Array(samples).fill(value);

/**
 * Waits for what the fake server has observed. A socket handshake, a send or a
 * close takes as long as the CPU load of the whole suite allows, so a fixed
 * `setTimeout` before an assertion fails on a busy machine — poll instead.
 */
const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 4_000, interval: 5 });

// ---- tests ----

describe('LinearPcm16Resampler', () => {
  it('passes audio through when the rates match', () => {
    const input = tone(10);
    expect(new LinearPcm16Resampler(24000, 24000).process(input)).toBe(input);
  });

  it('produces 3 samples for every 2 when going from 16 kHz to 24 kHz', () => {
    const out = new LinearPcm16Resampler(16000, 24000).process(tone(1600));
    expect(Math.abs(out.length - 2400)).toBeLessThanOrEqual(2);
    expect(out.every((v) => v === 1000)).toBe(true);
  });

  it('interpolates between samples', () => {
    const out = new LinearPcm16Resampler(16000, 24000).process(Int16Array.from([0, 300, 600]));
    expect(Array.from(out)).toEqual([0, 200, 400]);
  });

  it('gives the same output however the input is chunked', () => {
    const input = Int16Array.from({ length: 4000 }, (_, i) => Math.round(8000 * Math.sin(i / 7)));
    const whole = new LinearPcm16Resampler(16000, 24000).process(input);

    const chunked = new LinearPcm16Resampler(16000, 24000);
    const parts: number[] = [];
    for (let i = 0; i < input.length; ) {
      const size = 1 + ((i * 7919) % 333);
      parts.push(...chunked.process(input.subarray(i, i + size)));
      i += size;
    }
    expect(parts).toEqual(Array.from(whole));
  });

  it('rejects nonsensical rates', () => {
    expect(() => new LinearPcm16Resampler(0, 24000)).toThrow();
  });
});

describe('buildTranscriptionSessionUpdate', () => {
  it('configures a manual-commit 24 kHz transcription session', () => {
    expect(buildTranscriptionSessionUpdate('gpt-4o-mini-transcribe', { language: 'tr', prompt: 'Banka' })).toEqual({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'tr', prompt: 'Banka' },
            turn_detection: null,
          },
        },
      },
    });
  });

  it('uses `languages` for the models that require it', () => {
    const update = buildTranscriptionSessionUpdate('gpt-live-transcribe', { language: 'tr' }) as {
      session: { audio: { input: { transcription: Record<string, unknown> } } };
    };
    expect(update.session.audio.input.transcription).toEqual({ model: 'gpt-live-transcribe', languages: ['tr'] });
  });

  it('drops the prompt for gpt-realtime-whisper', () => {
    const update = buildTranscriptionSessionUpdate('gpt-realtime-whisper', { prompt: 'x' }) as {
      session: { audio: { input: { transcription: Record<string, unknown> } } };
    };
    expect(update.session.audio.input.transcription).toEqual({ model: 'gpt-realtime-whisper' });
  });
});

describe('mapRealtimeTranscriptionUsage', () => {
  it('maps token usage and keeps the audio duration', () => {
    expect(
      mapRealtimeTranscriptionUsage({ type: 'tokens', input_tokens: 10, output_tokens: 3, total_tokens: 13 }, 1.5),
    ).toEqual({ inputSeconds: 1.5, inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  });

  it('maps duration usage', () => {
    expect(mapRealtimeTranscriptionUsage({ type: 'duration', seconds: 2.25 }, 1.5)).toEqual({ inputSeconds: 2.25 });
  });

  it('falls back to the streamed duration', () => {
    expect(mapRealtimeTranscriptionUsage(undefined, 1.5)).toEqual({ inputSeconds: 1.5 });
  });
});

describe('createOpenAiRealtimeTranscriptionStream', () => {
  it('speaks the transcription-session protocol end to end', async () => {
    const server = await fakeRealtime({
      onEvent: transcribeOnCommit('Merhaba dünya', {
        usage: { type: 'tokens', input_tokens: 20, output_tokens: 4, total_tokens: 24 },
      }),
    });
    const stream = open(server.url, { language: 'tr', prompt: 'Selamlaşma' });
    const partials: Array<[string, string]> = [];
    stream.onPartial((text, delta) => partials.push([text, delta]));

    // Pushed before the session is configured: buffered, then flushed in order.
    stream.push(tone(2400, 1));
    stream.push(tone(2400, 2));
    const result = await stream.finish();

    expect(result).toMatchObject({
      text: 'Merhaba dünya',
      language: 'tr',
      duration: 0.2,
      usage: { inputSeconds: 0.2, inputTokens: 20, outputTokens: 4, totalTokens: 24 },
    });
    expect(partials).toEqual([
      ['Merhaba', 'Merhaba'],
      ['Merhaba dünya', ' dünya'],
    ]);

    const types = server.received.map((e) => e.type);
    expect(types).toEqual([
      'session.update',
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ]);
    expect(server.received[0]).toEqual(
      buildTranscriptionSessionUpdate('gpt-4o-mini-transcribe', { language: 'tr', prompt: 'Selamlaşma' }),
    );
    const firstAudio = Buffer.from(String(server.received[1].audio), 'base64');
    expect(firstAudio.readInt16LE(0)).toBe(1);
    expect(server.appendedSamples()).toBe(4800);
    expect(server.received[3].event_id).toEqual(expect.any(String));

    // Handshake: the URL and auth headers as given, no beta header.
    expect(server.requests[0].url).toBe('/v1/realtime?intent=transcription');
    expect(server.requests[0].headers.authorization).toBe('Bearer sk-test');
    expect(server.requests[0].headers['openai-organization']).toBe('org-1');
    expect(server.requests[0].headers['openai-beta']).toBeUndefined();

    // The transcript is in: the stream hangs up on its own.
    await eventually(() => expect(server.closedByClient()).toBe(true));
  });

  it('sends audio straight through once the session is ready', async () => {
    const server = await fakeRealtime({ onEvent: transcribeOnCommit('ok') });
    const stream = open(server.url);
    stream.push(tone(240));
    // Reaches the server with no finish() — flushed as soon as the session is ready.
    await eventually(() => expect(server.appendedSamples()).toBe(240));
    // The session is ready now, so this one is not buffered: it arrives before finish().
    stream.push(tone(240));
    await eventually(() => expect(server.appendedSamples()).toBe(480));
    expect(server.received.some((e) => e.type === 'input_audio_buffer.commit')).toBe(false);
    await expect(stream.finish()).resolves.toMatchObject({ text: 'ok' });
    expect(server.appendedSamples()).toBe(480);
  });

  it('holds audio back until the session is configured, then flushes it in order', async () => {
    let acknowledge!: () => void;
    const holdReady = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const server = await fakeRealtime({ onEvent: transcribeOnCommit('ok'), holdReady });
    const stream = open(server.url);
    stream.push(tone(240, 1));
    stream.push(tone(240, 2));
    const finishing = stream.finish();

    // The server has the session.update but has not confirmed it: no audio, no commit yet.
    await eventually(() => expect(server.received.map((e) => e.type)).toEqual(['session.update']));
    await new Promise((r) => setTimeout(r, 30));
    expect(server.received.map((e) => e.type)).toEqual(['session.update']);

    acknowledge();
    await expect(finishing).resolves.toMatchObject({ text: 'ok', duration: 0.02 });
    expect(server.received.map((e) => e.type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
    ]);
    expect(server.appendedSamples()).toBe(480);
  });

  it('resamples 16 kHz input to the 24 kHz the session requires', async () => {
    const server = await fakeRealtime({ onEvent: transcribeOnCommit('ok') });
    const stream = open(server.url, { sampleRate: 16000 });
    for (let i = 0; i < 10; i++) stream.push(tone(160));
    const result = await stream.finish();
    expect(result.duration).toBeCloseTo(0.1);
    expect(Math.abs(server.appendedSamples() - 2400)).toBeLessThanOrEqual(2);
  });

  it('reports the detected language when the model returns one', async () => {
    const server = await fakeRealtime({
      onEvent: transcribeOnCommit('Bonjour', { languages: [{ code: 'fr' }] }),
    });
    const stream = open(server.url, { language: 'tr' }, 'gpt-transcribe');
    stream.push(tone(480));
    await expect(stream.finish()).resolves.toMatchObject({ text: 'Bonjour', language: 'fr' });
  });

  it('resolves an empty transcript without committing when no audio was pushed', async () => {
    const server = await fakeRealtime({ onEvent: transcribeOnCommit('never') });
    const stream = open(server.url);
    await expect(stream.finish()).resolves.toMatchObject({ text: '', duration: 0 });
    expect(server.received.some((e) => e.type === 'input_audio_buffer.commit')).toBe(false);
  });

  it('treats an empty-buffer commit error as no speech', async () => {
    const server = await fakeRealtime({
      onEvent: (event, reply) => {
        if (event.type !== 'input_audio_buffer.commit') return;
        reply({
          type: 'error',
          error: { type: 'invalid_request_error', code: 'input_audio_buffer_commit_empty', message: 'buffer too small', event_id: event.event_id },
        });
      },
    });
    const stream = open(server.url);
    stream.push(tone(10));
    await expect(stream.finish()).resolves.toMatchObject({ text: '' });
  });

  it('rejects when the transcription fails', async () => {
    const server = await fakeRealtime({
      onEvent: (event, reply) => {
        if (event.type !== 'input_audio_buffer.commit') return;
        reply({ type: 'input_audio_buffer.committed', item_id: 'item_9' });
        reply({
          type: 'conversation.item.input_audio_transcription.failed',
          item_id: 'item_9',
          content_index: 0,
          error: { code: 'audio_unintelligible', message: 'could not transcribe' },
        });
      },
    });
    const stream = open(server.url);
    stream.push(tone(480));
    await expect(stream.finish()).rejects.toMatchObject({
      message: 'OpenAI realtime transcription failed: could not transcribe',
      code: 'audio_unintelligible',
    });
  });

  it('rejects on an error event', async () => {
    const server = await fakeRealtime({
      onEvent: (event, reply) => {
        if (event.type === 'input_audio_buffer.commit') {
          reply({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', message: 'bad model' } });
        }
      },
    });
    const stream = open(server.url);
    stream.push(tone(480));
    await expect(stream.finish()).rejects.toThrow('OpenAI realtime transcription error: bad model');
  });

  it('rejects when the server closes before the transcript arrives', async () => {
    const server = await fakeRealtime({
      onEvent: (event, _reply, socket) => {
        if (event.type === 'input_audio_buffer.commit') socket.close(1011);
      },
    });
    const stream = open(server.url);
    stream.push(tone(480));
    await expect(stream.finish()).rejects.toThrow('closed before the transcript arrived (1011)');
  });

  it('rejects when the handshake is refused', async () => {
    const server = await fakeRealtime({ rejectStatus: 401 });
    const stream = open(server.url);
    stream.push(tone(480));
    await expect(stream.finish()).rejects.toThrow(/connection failed: Unexpected server response: 401/);
  });

  it('times out when no transcript comes back', async () => {
    const server = await fakeRealtime();
    const stream = open(server.url, {}, 'gpt-4o-mini-transcribe', { finishTimeoutMs: 50 });
    stream.push(tone(480));
    await expect(stream.finish()).rejects.toThrow('no final transcript in time');
  });

  it('times out when the session never becomes ready', async () => {
    const server = await fakeRealtime({ neverReady: true });
    const stream = open(server.url, {}, 'gpt-4o-mini-transcribe', { connectTimeoutMs: 50 });
    stream.push(tone(480));
    await expect(stream.finish()).rejects.toThrow('session was not ready in time');
    expect(server.received.some((e) => e.type === 'input_audio_buffer.append')).toBe(false);
  });

  it('close() rejects a pending finish with an AbortError and drops the connection', async () => {
    const server = await fakeRealtime();
    const stream = open(server.url);
    stream.push(tone(480));
    const pending = stream.finish();
    // Close once the commit is on the server: the socket is open and the finish is really waiting.
    await eventually(() => expect(server.received.some((e) => e.type === 'input_audio_buffer.commit')).toBe(true));
    stream.close();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await eventually(() => expect(server.closedByClient()).toBe(true));
    // Idempotent, and later pushes are ignored.
    stream.close();
    stream.push(tone(10));
  });

  it('aborting the signal closes the stream', async () => {
    const server = await fakeRealtime();
    const controller = new AbortController();
    const stream = open(server.url, { signal: controller.signal });
    stream.push(tone(480));
    const pending = stream.finish();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores audio pushed after finish()', async () => {
    const server = await fakeRealtime({ onEvent: transcribeOnCommit('ok') });
    const stream = open(server.url);
    stream.push(tone(240));
    const pending = stream.finish();
    stream.push(tone(240));
    await pending;
    expect(server.appendedSamples()).toBe(240);
  });
});

describe('streaming STT wiring', () => {
  it('createOpenAiSttRuntime only offers createStream with a realtime URL', () => {
    const base = { apiKey: 'k', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o-mini-transcribe' };
    expect(createOpenAiSttRuntime(base).createStream).toBeUndefined();
    expect(typeof createOpenAiSttRuntime({ ...base, realtimeTranscriptionUrl: 'wss://x' }).createStream).toBe('function');
  });

  it('the OpenAI provider streams against api.openai.com; Azure and OpenAI-compatible stay batch-only', async () => {
    expect(OPENAI_REALTIME_TRANSCRIPTION_URL).toBe('wss://api.openai.com/v1/realtime?intent=transcription');
    const config = { modelId: 'gpt-4o-mini-transcribe', category: 'stt' } as never;

    const openai = OpenAiModelProviderContract.createRuntime({
      tenantId: 't', providerKey: 'p', credentials: { apiKey: 'sk' }, settings: {},
    } as never) as unknown as ModelProviderRuntime;
    expect(typeof ((await openai.createSttRuntime!(config)) as SttRuntime).createStream).toBe('function');

    const compatible = OpenAiCompatibleModelProviderContract.createRuntime({
      tenantId: 't', providerKey: 'p', credentials: { apiKey: 'sk' }, settings: { baseUrl: 'https://api.custom.com/v1' },
    } as never) as unknown as ModelProviderRuntime;
    expect(((await compatible.createSttRuntime!(config)) as SttRuntime).createStream).toBeUndefined();

    const azure = AzureModelProviderContract.createRuntime({
      tenantId: 't', providerKey: 'p', credentials: { apiKey: 'az' },
      settings: { instanceName: 'r', deploymentName: 'd', apiVersion: '2025-03-01-preview' },
    } as never) as unknown as ModelProviderRuntime;
    expect(((await azure.createSttRuntime!(config)) as SttRuntime).createStream).toBeUndefined();
  });
});
