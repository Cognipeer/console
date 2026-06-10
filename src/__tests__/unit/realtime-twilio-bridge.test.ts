import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TwilioMediaBridge } from '@/lib/services/realtime/twilioBridge';
import { linearToMulawSample } from '@/lib/services/realtime/g711';
import type { RealtimeSession } from '@/lib/services/realtime/realtimeSession';

function mulawFrame(amplitude: number, samples = 160): string {
  const byte = linearToMulawSample(amplitude);
  return Buffer.alloc(samples, byte).toString('base64');
}

function makeSession() {
  return {
    speak: vi.fn().mockResolvedValue(undefined),
    transcribe: vi.fn().mockResolvedValue({ text: 'caller said hi', duration: 1.0 }),
    respondToUserText: vi.fn().mockResolvedValue(undefined),
    isResponding: vi.fn().mockReturnValue(false),
    cancelActiveResponse: vi.fn(),
  } as unknown as RealtimeSession & {
    speak: ReturnType<typeof vi.fn>;
    transcribe: ReturnType<typeof vi.fn>;
    respondToUserText: ReturnType<typeof vi.fn>;
    isResponding: ReturnType<typeof vi.fn>;
    cancelActiveResponse: ReturnType<typeof vi.fn>;
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TwilioMediaBridge', () => {
  it('speaks the greeting when the stream starts', async () => {
    const session = makeSession();
    const sent: Array<Record<string, unknown>> = [];
    const bridge = new TwilioMediaBridge(session, (message) => sent.push(message), {
      greeting: 'Hoş geldiniz!',
      transcriptionModel: 'whisper',
    });
    bridge.handleMessage({ event: 'start', start: { streamSid: 'MZ123' } });
    await flush();
    expect(session.speak).toHaveBeenCalledWith('Hoş geldiniz!');
  });

  it('detects a turn after silence and pipes STT → response', async () => {
    const session = makeSession();
    const bridge = new TwilioMediaBridge(session, () => {}, {
      transcriptionModel: 'whisper',
      turnSilenceMs: 100,
      turnSilenceThreshold: 0.05,
    });
    bridge.handleMessage({ event: 'start', start: { streamSid: 'MZ1' } });

    // 400 ms of speech (20 ms frames, loud)…
    for (let i = 0; i < 20; i++) {
      bridge.handleMessage({ event: 'media', media: { payload: mulawFrame(20000) } });
    }
    // …then 120 ms of silence ends the turn.
    for (let i = 0; i < 6; i++) {
      bridge.handleMessage({ event: 'media', media: { payload: mulawFrame(0) } });
    }
    await flush();
    await flush();

    expect(session.transcribe).toHaveBeenCalledTimes(1);
    const [modelKey, wav, contentType] = session.transcribe.mock.calls[0];
    expect(modelKey).toBe('whisper');
    expect(contentType).toBe('audio/wav');
    expect(Buffer.isBuffer(wav)).toBe(true);
    expect((wav as Buffer).toString('ascii', 0, 4)).toBe('RIFF');
    expect(session.respondToUserText).toHaveBeenCalledWith('caller said hi');
  });

  it('ignores noise blips shorter than the minimum utterance', async () => {
    const session = makeSession();
    const bridge = new TwilioMediaBridge(session, () => {}, {
      transcriptionModel: 'whisper',
      turnSilenceMs: 100,
      turnSilenceThreshold: 0.05,
    });
    bridge.handleMessage({ event: 'start', start: { streamSid: 'MZ1' } });
    // 40 ms blip + silence
    for (let i = 0; i < 2; i++) {
      bridge.handleMessage({ event: 'media', media: { payload: mulawFrame(20000) } });
    }
    for (let i = 0; i < 6; i++) {
      bridge.handleMessage({ event: 'media', media: { payload: mulawFrame(0) } });
    }
    await flush();
    expect(session.transcribe).not.toHaveBeenCalled();
  });

  it('barges in: cancels the active response and clears Twilio playback', () => {
    const session = makeSession();
    session.isResponding.mockReturnValue(true);
    const sent: Array<Record<string, unknown>> = [];
    const bridge = new TwilioMediaBridge(session, (message) => sent.push(message), {
      transcriptionModel: 'whisper',
      turnSilenceThreshold: 0.05,
    });
    bridge.handleMessage({ event: 'start', start: { streamSid: 'MZ9' } });
    bridge.handleMessage({ event: 'media', media: { payload: mulawFrame(20000) } });

    expect(session.cancelActiveResponse).toHaveBeenCalled();
    expect(sent).toContainEqual({ event: 'clear', streamSid: 'MZ9' });
  });

  it('converts PCM TTS deltas to μ-law media frames', () => {
    const session = makeSession();
    const sent: Array<Record<string, unknown>> = [];
    const bridge = new TwilioMediaBridge(session, (message) => sent.push(message), {
      transcriptionModel: 'whisper',
    });
    bridge.handleMessage({ event: 'start', start: { streamSid: 'MZ5' } });

    // 24 kHz PCM16 (REALTIME_TTS_PCM_RATE default): 24 samples → 8 μ-law bytes.
    const pcm = Buffer.alloc(48);
    for (let i = 0; i < 24; i++) pcm.writeInt16LE(10000, i * 2);
    bridge.onSessionEvent({
      type: 'response.audio.delta',
      audio: pcm.toString('base64'),
      content_type: 'audio/pcm',
    });

    const media = sent.find((message) => message.event === 'media') as
      | { media: { payload: string } }
      | undefined;
    expect(media).toBeDefined();
    const payload = Buffer.from(media!.media.payload, 'base64');
    expect(payload.length).toBe(8);
  });

  it('drops unsupported TTS formats with a single warning instead of crashing', () => {
    const session = makeSession();
    const sent: Array<Record<string, unknown>> = [];
    const bridge = new TwilioMediaBridge(session, (message) => sent.push(message), {
      transcriptionModel: 'whisper',
    });
    bridge.handleMessage({ event: 'start', start: { streamSid: 'MZ7' } });
    bridge.onSessionEvent({
      type: 'response.audio.delta',
      audio: Buffer.from('mp3data').toString('base64'),
      content_type: 'audio/mpeg',
    });
    expect(sent.find((message) => message.event === 'media')).toBeUndefined();
  });
});
