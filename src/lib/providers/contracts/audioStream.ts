import type { TtsOutputFormat } from '../domains/audio';

/**
 * Sample rate of the `pcm` TTS output format: signed 16-bit little-endian mono
 * at 24 kHz on OpenAI and Azure OpenAI (and the OpenAI-compatible servers that
 * copy their `/audio/speech` contract).
 */
export const TTS_PCM_SAMPLE_RATE = 24000;

const TTS_FORMAT_MIME: Record<TtsOutputFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/L16',
};

/** MIME type for a TTS output format (the fallback when the upstream sends none). */
export function ttsMimeType(format: TtsOutputFormat): string {
  return TTS_FORMAT_MIME[format] ?? 'application/octet-stream';
}

/**
 * Content type for raw PCM, carrying the rate the way the realtime protocol
 * spells it (`audio/L16;rate=24000`). The bytes are little-endian — the label
 * is the one v1 clients already parse, not a claim of RFC 2586 byte order.
 */
export function pcmContentType(sampleRate: number = TTS_PCM_SAMPLE_RATE): string {
  return `audio/L16;rate=${sampleRate}`;
}

/**
 * Iterates a fetch response body chunk by chunk.
 *
 * A consumer that stops early (break / return / throw in its `for await`)
 * cancels the body, which releases the upstream socket instead of leaving the
 * provider generating audio nobody reads. Aborting the request's signal makes
 * the pending read reject, which is how a stalled body is cut loose.
 */
export async function* iterateResponseBody(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = body.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => undefined);
    }
  }
}

/**
 * Re-chunks an s16le byte stream so every chunk holds whole samples.
 *
 * HTTP chunk boundaries fall wherever the network put them, so a 2-byte sample
 * can be split across two chunks. A consumer that decodes each chunk on its own
 * (`Int16Array` over the bytes, resampling, G.711 encoding) would then read
 * every following sample shifted by one byte — loud noise. The odd trailing
 * byte is carried into the next chunk; one left over when the stream ends is
 * half a sample and is dropped.
 */
export async function* alignPcm16Chunks(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Buffer, void, undefined> {
  let carry: number | null = null;
  for await (const chunk of source) {
    if (chunk.byteLength === 0) continue;
    let bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (carry !== null) {
      bytes = Buffer.concat([Buffer.from([carry]), bytes]);
      carry = null;
    }
    if (bytes.byteLength % 2 === 1) {
      carry = bytes[bytes.byteLength - 1];
      bytes = bytes.subarray(0, bytes.byteLength - 1);
    }
    if (bytes.byteLength > 0) yield bytes;
  }
}

/**
 * Stateful linear-interpolation resampler for s16le mono, for feeding a
 * provider that accepts one fixed rate (OpenAI realtime transcription: 24 kHz
 * only) from a pipeline running at another. Interpolation state carries across
 * `process` calls, so chunking the input does not change the output — no clicks
 * at chunk boundaries. Linear is plenty for speech recognition input; it is not
 * meant for playback-quality conversion.
 */
export class LinearPcm16Resampler {
  private readonly step: number;

  /** Last input sample of the previous chunk (index 0 of the next one). */
  private previous: number | null = null;

  /** Read position of the next output sample, relative to `previous`. */
  private position = 0;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
  ) {
    if (!(fromRate > 0) || !(toRate > 0)) {
      throw new Error(`Invalid resampling rates ${fromRate} → ${toRate}`);
    }
    this.step = fromRate / toRate;
  }

  process(input: Int16Array): Int16Array {
    if (this.fromRate === this.toRate) return input;
    if (input.length === 0) return new Int16Array(0);

    const offset = this.previous === null ? 0 : 1;
    const length = input.length + offset;
    const at = (index: number) =>
      index < offset ? (this.previous as number) : input[index - offset];

    const out: number[] = [];
    let t = this.position;
    while (t < length - 1) {
      const index = Math.floor(t);
      const frac = t - index;
      const a = at(index);
      const b = at(index + 1);
      out.push(Math.round(a + (b - a) * frac));
      t += this.step;
    }
    this.previous = at(length - 1);
    this.position = t - (length - 1);
    return Int16Array.from(out);
  }
}
