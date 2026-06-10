/**
 * G.711 μ-law codec + small PCM helpers, pure TypeScript.
 *
 * Telephony providers (Twilio Media Streams, Vonage, Plivo…) speak 8 kHz
 * G.711 μ-law. These helpers convert between that and linear PCM16 so the
 * realtime bridge can feed STT (WAV) and play TTS output (PCM → μ-law)
 * without any native audio dependency.
 */

const BIAS = 0x84;
const CLIP = 32635;

/** Encode one PCM16 sample to μ-law. */
export function linearToMulawSample(sample: number): number {
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode one μ-law byte to PCM16. */
export function mulawToLinearSample(mulaw: number): number {
  mulaw = ~mulaw & 0xff;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

export function mulawToPcm16(mulaw: Buffer): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    out[i] = mulawToLinearSample(mulaw[i]);
  }
  return out;
}

export function pcm16ToMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = linearToMulawSample(pcm[i]);
  }
  return out;
}

/** Read little-endian PCM16 bytes into samples. */
export function bufferToPcm16(buffer: Buffer): Int16Array {
  const samples = new Int16Array(Math.floor(buffer.length / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = buffer.readInt16LE(i * 2);
  }
  return samples;
}

/**
 * Integer-ratio downsampler with boxcar averaging (cheap anti-aliasing).
 * 24000→8000 (ratio 3) covers the OpenAI-PCM → telephony path.
 */
export function downsamplePcm16(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return pcm;
  if (fromRate % toRate !== 0) {
    throw new Error(`Downsample ratio must be an integer (${fromRate} → ${toRate})`);
  }
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < ratio; j++) sum += pcm[i * ratio + j];
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sum / ratio)));
  }
  return out;
}

/** Wrap PCM16 samples in a minimal mono WAV container (for STT uploads). */
export function pcm16ToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataLength = pcm.length * 2;
  const buffer = Buffer.allocUnsafe(44 + dataLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < pcm.length; i++) {
    buffer.writeInt16LE(pcm[i], 44 + i * 2);
  }
  return buffer;
}

/** Normalized RMS energy (0..1) of a PCM16 frame — the VAD signal. */
export function rmsEnergy(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const normalized = pcm[i] / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / pcm.length);
}
