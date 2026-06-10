/**
 * Twilio Media Streams ↔ RealtimeSession bridge.
 *
 * Speaks Twilio's bidirectional stream protocol (`connected` / `start` /
 * `media` / `stop` inbound; `media` / `clear` outbound) so a `<Connect>
 * <Stream url="wss://…/api/client/v1/realtime/twilio?api_key=…&model=…"/>`
 * verb connects a phone call straight to a realtime model. The same protocol
 * shape is used by other telephony vendors (Vonage/Plivo audio streams are
 * near-identical), so the bridge keeps all G.711-specific work here and the
 * session stays transport-agnostic.
 *
 * Turn detection is RMS-energy VAD over the 20 ms μ-law frames: a turn ends
 * after `turnSilenceMs` of silence, the utterance is WAV-wrapped and sent to
 * STT, and the transcript drives the chat model. Caller speech during an
 * active response triggers barge-in: the in-flight response is cancelled and
 * Twilio's playback buffer is cleared.
 */

import { createLogger } from '@/lib/core/logger';
import type { RealtimeSession } from './realtimeSession';
import {
  bufferToPcm16,
  downsamplePcm16,
  mulawToPcm16,
  pcm16ToMulaw,
  pcm16ToWav,
  rmsEnergy,
} from './g711';

const logger = createLogger('realtime:twilio');

/** Sample rate of `pcm`-format TTS output (OpenAI: 24 kHz). */
const TTS_PCM_RATE = Math.max(
  8000,
  Number(process.env.REALTIME_TTS_PCM_RATE ?? 24000) || 24000,
);

const TELEPHONY_RATE = 8000;
/** Frames shorter than this are treated as noise blips, not turns. */
const MIN_UTTERANCE_MS = 240;
/** Pre-roll kept before speech onset so word starts are not clipped. */
const PRE_ROLL_FRAMES = 10;

export interface TwilioBridgeOptions {
  /** Silence that ends a caller turn, in ms (default 700). */
  turnSilenceMs?: number;
  /** RMS threshold (0..1) below which a frame is silence (default 0.015). */
  turnSilenceThreshold?: number;
  /** Spoken when the stream starts (realtime model `greeting`). */
  greeting?: string;
  /** STT model key (from the realtime model preset). */
  transcriptionModel?: string;
}

interface TwilioInboundMessage {
  event?: string;
  streamSid?: string;
  start?: {
    streamSid?: string;
    callSid?: string;
    customParameters?: Record<string, string>;
    mediaFormat?: { encoding?: string; sampleRate?: number };
  };
  media?: { payload?: string };
}

export class TwilioMediaBridge {
  private readonly session: RealtimeSession;
  private readonly sendRaw: (message: Record<string, unknown>) => void;
  private readonly options: TwilioBridgeOptions;

  private streamSid: string | null = null;
  private speechActive = false;
  private silenceMs = 0;
  private utterance: Buffer[] = [];
  private utteranceMs = 0;
  private preRoll: Buffer[] = [];
  /** Serializes STT → response turns so they never interleave. */
  private turnChain: Promise<void> = Promise.resolve();
  private warnedNonPcm = false;
  private closed = false;

  constructor(
    session: RealtimeSession,
    sendRaw: (message: Record<string, unknown>) => void,
    options?: TwilioBridgeOptions,
  ) {
    this.session = session;
    this.sendRaw = sendRaw;
    this.options = options ?? {};
  }

  /**
   * Session event sink: converts streamed TTS audio (pcm/wav) to 8 kHz μ-law
   * media frames. All other session events are swallowed — the phone call is
   * the only client.
   */
  onSessionEvent(event: Record<string, unknown>): void {
    if (event.type !== 'response.audio.delta' || !this.streamSid || this.closed) return;
    const base64 = typeof event.audio === 'string' ? event.audio : '';
    if (!base64) return;
    const contentType = String(event.content_type ?? '');
    try {
      const payload = this.toMulawBase64(Buffer.from(base64, 'base64'), contentType);
      if (!payload) return;
      this.sendRaw({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload },
      });
    } catch (error) {
      logger.error('Twilio audio conversion failed', { error, contentType });
    }
  }

  /** Convert TTS output to μ-law/8000 base64. Returns null when unsupported. */
  private toMulawBase64(audio: Buffer, contentType: string): string | null {
    const type = contentType.toLowerCase();
    let pcm: Int16Array;
    let rate: number;

    if (type.includes('wav') || hasWavHeader(audio)) {
      const parsed = parseWav(audio);
      pcm = parsed.samples;
      rate = parsed.sampleRate;
    } else if (type.includes('pcm') || type.includes('l16') || type === '' || type.includes('octet-stream')) {
      pcm = bufferToPcm16(audio);
      rate = TTS_PCM_RATE;
    } else if (type.includes('mulaw') || type.includes('basic')) {
      return audio.toString('base64');
    } else {
      if (!this.warnedNonPcm) {
        this.warnedNonPcm = true;
        logger.error(
          `Twilio bridge needs pcm/wav TTS output but got "${contentType}". `
          + 'Set the realtime model tts_format to "pcm" or "wav".',
        );
      }
      return null;
    }

    if (rate !== TELEPHONY_RATE) {
      pcm = downsamplePcm16(pcm, rate, TELEPHONY_RATE);
    }
    return pcm16ToMulaw(pcm).toString('base64');
  }

  /** Entry point for every parsed Twilio websocket message. */
  handleMessage(message: TwilioInboundMessage): void {
    switch (message.event) {
      case 'connected':
        return;
      case 'start': {
        this.streamSid = message.start?.streamSid ?? message.streamSid ?? null;
        logger.info('Twilio stream started', {
          streamSid: this.streamSid,
          callSid: message.start?.callSid,
        });
        const greeting = this.options.greeting;
        if (greeting) {
          this.turnChain = this.turnChain.then(async () => {
            try {
              await this.session.speak(greeting);
            } catch (error) {
              logger.error('Twilio greeting failed', { error });
            }
          });
        }
        return;
      }
      case 'media': {
        const payload = message.media?.payload;
        if (typeof payload === 'string' && payload.length > 0) {
          this.handleFrame(Buffer.from(payload, 'base64'));
        }
        return;
      }
      case 'stop':
        this.close();
        return;
      default:
        return;
    }
  }

  close(): void {
    this.closed = true;
  }

  // ── VAD / turn detection ────────────────────────────────────────────

  private handleFrame(frame: Buffer): void {
    if (this.closed || frame.length === 0) return;
    const frameMs = frame.length / 8; // 8 samples (bytes) per ms at 8 kHz μ-law
    const energy = rmsEnergy(mulawToPcm16(frame));
    const threshold = this.options.turnSilenceThreshold ?? 0.015;

    if (energy >= threshold) {
      if (!this.speechActive) {
        this.speechActive = true;
        this.silenceMs = 0;
        // Barge-in: the caller starts talking over the assistant.
        if (this.session.isResponding()) {
          this.session.cancelActiveResponse();
          if (this.streamSid) {
            this.sendRaw({ event: 'clear', streamSid: this.streamSid });
          }
        }
        // Seed the utterance with the pre-roll so onsets aren't clipped.
        for (const buffered of this.preRoll) {
          this.utterance.push(buffered);
          this.utteranceMs += buffered.length / 8;
        }
        this.preRoll = [];
      }
      this.silenceMs = 0;
      this.utterance.push(frame);
      this.utteranceMs += frameMs;
      return;
    }

    if (!this.speechActive) {
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      return;
    }

    // Trailing silence inside an active turn.
    this.utterance.push(frame);
    this.utteranceMs += frameMs;
    this.silenceMs += frameMs;
    if (this.silenceMs >= (this.options.turnSilenceMs ?? 700)) {
      this.endTurn();
    }
  }

  private endTurn(): void {
    const frames = this.utterance;
    const lengthMs = this.utteranceMs;
    this.utterance = [];
    this.utteranceMs = 0;
    this.speechActive = false;
    this.silenceMs = 0;

    if (lengthMs < MIN_UTTERANCE_MS) return;

    const mulaw = Buffer.concat(frames);
    this.turnChain = this.turnChain.then(async () => {
      try {
        await this.processTurn(mulaw);
      } catch (error) {
        logger.error('Twilio turn failed', { error });
      }
    });
  }

  private async processTurn(mulaw: Buffer): Promise<void> {
    if (this.closed) return;
    const sttModel = this.options.transcriptionModel;
    if (!sttModel) {
      logger.error('Twilio bridge has no STT model configured; dropping turn');
      return;
    }
    const wav = pcm16ToWav(mulawToPcm16(mulaw), TELEPHONY_RATE);
    const transcript = await this.session.transcribe(sttModel, wav, 'audio/wav', 'call-turn.wav');
    if (!transcript.text.trim()) return;
    if (this.closed) return;
    await this.session.respondToUserText(transcript.text);
  }
}

function hasWavHeader(buffer: Buffer): boolean {
  return buffer.length > 44 && buffer.toString('ascii', 0, 4) === 'RIFF';
}

function parseWav(buffer: Buffer): { samples: Int16Array; sampleRate: number } {
  const sampleRate = buffer.readUInt32LE(24);
  // Find the data chunk (usually at offset 36, but some encoders add chunks).
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      const end = Math.min(offset + 8 + chunkSize, buffer.length);
      return { samples: bufferToPcm16(buffer.subarray(offset + 8, end)), sampleRate };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return { samples: bufferToPcm16(buffer.subarray(44)), sampleRate };
}
