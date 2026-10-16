/**
 * The data-URL scrub in the persisted-log redaction does a bounded amount of
 * work per candidate, so scrubbing a string takes time linear in its length
 * however the text is shaped, and a real data URL is still redacted in full.
 *
 * The time budget is far above what a linear scan of these inputs takes (a few
 * milliseconds each), so it only trips when the work grows faster than the
 * input.
 */

import { describe, expect, it } from 'vitest';
import {
  redactDataUrls,
  redactLogPayload,
  redactLogString,
} from '@/lib/services/logRedaction';

const REDACTED = 'data:[REDACTED];base64,[REDACTED]';
const BUDGET_MS = 1500;
const LARGE = 300_000;

function repeatedTo(unit: string, chars: number): string {
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

function elapsedMs<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

/** Text that repeats the start of a data URL without ever completing one. */
const SHAPES: Record<string, string> = {
  'repeated "data:x/y;" segments': repeatedTo('data:x/y;', LARGE),
  'repeated segments ending in ";base64,!"': `${repeatedTo('data:x/y;', LARGE)};base64,!`,
  'repeated segments with a parameter': repeatedTo('data:a/b;p', LARGE),
  'repeated long parameters': repeatedTo(`data:a/b${`;${'z'.repeat(250)}`.repeat(8)}`, LARGE),
  'repeated parameters ending in a media type': repeatedTo(`;${'z'.repeat(242)}data:a/b`, LARGE),
  'repeated full-length media types': repeatedTo(`data:${'a'.repeat(127)}/${'a'.repeat(127)};`, LARGE),
  'repeated "data:" prefixes': repeatedTo('data:', LARGE),
  'repeated ";base64," markers': repeatedTo(';base64,', LARGE),
  'repeated "data:a/b;base64;"': repeatedTo('data:a/b;base64;', LARGE),
};

describe('data-URL scrub — work is bounded per string', () => {
  it.each(Object.entries(SHAPES))('redactDataUrls takes linear time on %s', (_name, text) => {
    const { value, ms } = elapsedMs(() => redactDataUrls(text));
    expect(ms).toBeLessThan(BUDGET_MS);
    // Nothing in these texts is a complete data URL, so they come back as they were.
    expect(value).toBe(text);
  });

  it.each(Object.entries(SHAPES))('redactLogString takes linear time on %s', (_name, text) => {
    const { ms } = elapsedMs(() => redactLogString(text));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('redactLogPayload takes linear time on such text inside a request payload', () => {
    const text = SHAPES['repeated "data:x/y;" segments'];
    const { value, ms } = elapsedMs(() => redactLogPayload({
      tool: 'lookup',
      arguments: { query: text, nested: [{ note: text.slice(0, 50_000) }] },
    }));
    expect(ms).toBeLessThan(BUDGET_MS);
    // 300 KB is over the size cap, so the payload is replaced by the marker.
    expect(value).toMatchObject({ _truncated: true });
  });

  it('redactLogPayload takes linear time under the smaller cap a public call uses', () => {
    const text = SHAPES['repeated segments ending in ";base64,!"'];
    const { value, ms } = elapsedMs(() => redactLogPayload({ arguments: { query: text } }, { maxBytes: 16 * 1024 }));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toMatchObject({ _truncated: true });
  });

  it('takes linear time on many strings that add up to the same length', () => {
    const piece = repeatedTo('data:x/y;', 150);
    const strings = Array.from({ length: 2000 }, (_, index) => `${index}:${piece}`);
    const { ms } = elapsedMs(() => redactLogPayload({ arguments: { strings } }));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('stays within the time budget at 1 MB and at 4 MB', () => {
    const small = elapsedMs(() => redactDataUrls(repeatedTo('data:x/y;', 1_000_000)));
    const large = elapsedMs(() => redactDataUrls(repeatedTo('data:x/y;', 4_000_000)));
    expect(small.ms).toBeLessThan(BUDGET_MS);
    expect(large.ms).toBeLessThan(BUDGET_MS * 2);
  });
});

describe('data-URL scrub — real data URLs are still redacted', () => {
  it.each([
    ['an image', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'],
    ['a type in capitals', 'DATA:IMAGE/PNG;BASE64,iVBORw0KGgo='],
    ['a charset parameter', 'data:text/plain;charset=utf-8;base64,aGVsbG8gd29ybGQ='],
    ['several parameters', 'data:image/png;name=a.png;size=12;base64,QUJD'],
    ['a vendor media type', 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBBQ='],
    ['url-safe base64', 'data:application/octet-stream;base64,-_-_AAAA=='],
  ])('redacts %s', (_name, url) => {
    expect(redactDataUrls(url)).toBe(REDACTED);
    expect(redactDataUrls(`before ${url} after`)).toBe(`before ${REDACTED} after`);
  });

  it('redacts every data URL in a string', () => {
    const text = 'a data:image/png;base64,AAAA b data:image/gif;base64,BBBB c';
    expect(redactDataUrls(text)).toBe(`a ${REDACTED} b ${REDACTED} c`);
  });

  it('redacts one of the longest forms the pattern allows', () => {
    const type = 'a'.repeat(127);
    const parameters = Array.from({ length: 8 }, (_, index) => `;p${index}=${'v'.repeat(250)}`).join('');
    expect(redactDataUrls(`data:${type}/${type}${parameters};base64,QUJD`)).toBe(REDACTED);
  });

  it('redacts a 5 MB payload quickly and replaces it whole', () => {
    const payload = `data:image/png;base64,${repeatedTo('QUJD', 5 * 1024 * 1024)}`;
    const { value, ms } = elapsedMs(() => redactDataUrls(`image: ${payload}`));
    expect(value).toBe(`image: ${REDACTED}`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('keeps a payload that held a large data URL within the size cap', () => {
    const payload = `data:image/png;base64,${repeatedTo('QUJD', 2 * 1024 * 1024)}`;
    const out = redactLogPayload({ messages: [{ image_url: { url: payload } }] });
    expect(out).toEqual({ messages: [{ image_url: { url: REDACTED } }] });
  });

  it('leaves text that only looks like the start of one alone', () => {
    for (const text of [
      'data:text/plain,hello',
      'data:image/png;base64,',
      'data:image/png;base64;base64,AAAA',
      'metadata: image/png',
      'data:/png;base64,AAAA',
    ]) {
      expect(redactDataUrls(text), text).toBe(text);
    }
  });
});
