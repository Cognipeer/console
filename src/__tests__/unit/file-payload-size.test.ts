/**
 * Unit tests - the size of an upload's `data` as text (`decodedByteLength`), which the quotas and the rate limit are
 * asked about. It must never be less than what the file service decodes from the same text, whatever the text holds,
 * and it is exact for base64 in either alphabet.
 */

import { describe, expect, it } from 'vitest';
import { base64TextOf, decodedByteLength } from '@/lib/services/files/payloadSize';

/** What the file service stores for a text. */
const stored = (text: string) => Buffer.from(base64TextOf(text), 'base64');

const sample = (length: number) => Buffer.from(Array.from({ length }, (_, index) => (index * 37 + 11) % 256));
const urlSafe = (text: string) => text.replace(/\+/g, '-').replace(/\//g, '_');
const wrapped = (text: string, width = 76) => (text.match(new RegExp(`.{1,${width}}`, 'g')) ?? []).join('\r\n');

describe('decodedByteLength of base64 text', () => {
  it('is the size of the bytes, for every length, in either alphabet, padded or not, and wrapped in lines', () => {
    for (let length = 0; length <= 300; length += 1) {
      const bytes = sample(length);
      const standard = bytes.toString('base64');
      for (const text of [standard, standard.replace(/=+$/, ''), urlSafe(standard), wrapped(standard), ` \n${standard}\t`]) {
        expect(decodedByteLength(text), `${length} bytes as ${JSON.stringify(text.slice(0, 24))}`).toBe(length);
        expect(stored(text).equals(bytes)).toBe(true);
      }
    }
  });

  it('is zero for no text and for text without a single symbol of the alphabet', () => {
    for (const text of ['', '   ', '====', ',;:!?', 'é€']) expect(decodedByteLength(text), JSON.stringify(text)).toBe(0);
  });
});

describe('decodedByteLength of a data URL', () => {
  it('counts what follows ;base64, and not the letters of its head', () => {
    const bytes = sample(300);
    const text = `data:application/octet-stream;base64,${bytes.toString('base64')}`;
    expect(base64TextOf(text)).toBe(bytes.toString('base64'));
    expect(decodedByteLength(text)).toBe(300);
    expect(stored(text).equals(bytes)).toBe(true);
  });

  it('reads a payload that runs over several lines', () => {
    const bytes = sample(200);
    const text = `data:text/plain;base64,${wrapped(bytes.toString('base64'), 20)}`;
    expect(base64TextOf(text).startsWith('data')).toBe(false);
    expect(decodedByteLength(text)).toBe(200);
    expect(stored(text).equals(bytes)).toBe(true);
  });

  it('takes a text that only looks like one (not at its start) for plain base64 text', () => {
    const text = `${sample(30).toString('base64')} data:x;base64,AAAA`;
    expect(base64TextOf(text)).toBe(text);
  });
});

describe('decodedByteLength is never less than what is stored', () => {
  it('for text that holds a data URL head after real data: the tail that used to hide 2000 bytes', () => {
    const bytes = Buffer.alloc(2001, 9);
    const text = `${bytes.toString('base64')}base64,AA`;
    expect(stored(text).length).toBe(2007);
    expect(decodedByteLength(text)).toBeGreaterThanOrEqual(2007);
  });

  it('for text that is not base64 at all: the decoder skips what is outside the alphabet', () => {
    const text = 'hello, this is not base64!';
    expect(stored(text).length).toBe(15);
    expect(decodedByteLength(text)).toBe(15);
  });

  it('for padding signs in the middle of the text (the decoder may stop there; the count does not)', () => {
    for (const text of ['QQ==QUJD', '=QUJD', 'QUJD====', 'QU=JD', '==']) {
      expect(decodedByteLength(text), JSON.stringify(text)).toBeGreaterThanOrEqual(stored(text).length);
    }
  });

  it('for a few thousand texts made of base64 symbols, separators, padding, head-like words and other letters', () => {
    const pieces = ['A', 'Z', 'a', 'z', '0', '9', '+', '/', '-', '_', '=', '==', ' ', '\n', '\t', ',', ';', ':', '!', 'base64,', 'data:', ';base64,', 'é', '€', '\u0000'];
    let seed = 20261020;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let round = 0; round < 4000; round += 1) {
      let text = '';
      const length = Math.floor(next() * 40);
      for (let index = 0; index < length; index += 1) text += pieces[Math.floor(next() * pieces.length)];
      expect(decodedByteLength(text), JSON.stringify(text)).toBeGreaterThanOrEqual(stored(text).length);
    }
  });
});
