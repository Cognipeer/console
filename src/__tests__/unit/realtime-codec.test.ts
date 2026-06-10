import { describe, expect, it } from 'vitest';
import {
  bufferToPcm16,
  downsamplePcm16,
  linearToMulawSample,
  mulawToLinearSample,
  mulawToPcm16,
  pcm16ToMulaw,
  pcm16ToWav,
  rmsEnergy,
} from '@/lib/services/realtime/g711';
import { SentenceChunker } from '@/lib/services/realtime/sentenceChunker';

describe('G.711 μ-law codec', () => {
  it('round-trips samples within μ-law quantization error', () => {
    const samples = [0, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000];
    for (const sample of samples) {
      const decoded = mulawToLinearSample(linearToMulawSample(sample));
      // μ-law is logarithmic: error grows with amplitude, ~6% worst case.
      const tolerance = Math.max(64, Math.abs(sample) * 0.06);
      expect(Math.abs(decoded - sample)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('encodes/decodes buffers symmetrically', () => {
    const pcm = new Int16Array([0, 500, -500, 12000, -12000]);
    const decoded = mulawToPcm16(pcm16ToMulaw(pcm));
    expect(decoded.length).toBe(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      expect(Math.abs(decoded[i] - pcm[i])).toBeLessThanOrEqual(Math.max(64, Math.abs(pcm[i]) * 0.06));
    }
  });

  it('downsamples 24k → 8k by integer ratio with averaging', () => {
    const pcm = new Int16Array(24);
    pcm.fill(300);
    const out = downsamplePcm16(pcm, 24000, 8000);
    expect(out.length).toBe(8);
    expect(out[0]).toBe(300);
  });

  it('rejects non-integer downsample ratios', () => {
    expect(() => downsamplePcm16(new Int16Array(10), 22050, 8000)).toThrowError(/integer/);
  });

  it('writes a valid mono WAV header', () => {
    const wav = pcm16ToWav(new Int16Array([1, 2, 3]), 8000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(8000); // sample rate
    expect(wav.readUInt32LE(40)).toBe(6); // data bytes (3 samples * 2)
    expect(wav.length).toBe(50);
  });

  it('reads little-endian PCM16 from buffers', () => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt16LE(1234, 0);
    buffer.writeInt16LE(-4321, 2);
    const pcm = bufferToPcm16(buffer);
    expect([...pcm]).toEqual([1234, -4321]);
  });

  it('computes normalized RMS energy', () => {
    expect(rmsEnergy(new Int16Array([0, 0, 0]))).toBe(0);
    const loud = new Int16Array(100).fill(16384); // half amplitude
    expect(rmsEnergy(loud)).toBeCloseTo(0.5, 2);
  });
});

describe('SentenceChunker', () => {
  it('emits sentences as they complete across deltas', () => {
    const chunker = new SentenceChunker();
    const out: string[] = [];
    out.push(...chunker.push('Merhaba, size nasıl '));
    out.push(...chunker.push('yardımcı olabilirim? Bugün '));
    out.push(...chunker.push('hava çok güzel. Devam'));
    expect(out).toEqual([
      'Merhaba, size nasıl yardımcı olabilirim?',
      'Bugün hava çok güzel.',
    ]);
    expect(chunker.flush()).toBe('Devam');
  });

  it('holds tiny sentences until more text arrives', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('Ok. ')).toEqual([]);
    const out = chunker.push('Şimdi uzun bir cümle daha geliyor ve bitiyor. ');
    expect(out.length).toBeGreaterThan(0);
  });

  it('force-flushes very long unpunctuated text at a word boundary', () => {
    const chunker = new SentenceChunker();
    const out = chunker.push('kelime '.repeat(80));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].length).toBeLessThanOrEqual(400);
  });

  it('flush returns null when empty', () => {
    expect(new SentenceChunker().flush()).toBeNull();
  });
});
