/**
 * Parity tests — the memo and the skip rules of the usage-log PII pass.
 *
 * What a payload is stored as must not change: the memo only repeats what the detector answered for the same text,
 * and the skip rules apply to strings that carry nothing the detector looks for (under 4 characters, a UUID, a hex id).
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ calls: 0, fail: false }));

vi.mock('@/lib/services/pii/piiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/pii/piiService')>();
  return {
    ...actual,
    redactPii: async (input: Parameters<typeof actual.redactPii>[0]) => {
      hoisted.calls += 1;
      if (hoisted.fail) throw new Error('detector down');
      return actual.redactPii(input);
    },
  };
});

import { redactPii } from '@/lib/services/pii/piiService';
import {
  clearLogPiiMemoForTests,
  redactPiiFromLogPayload,
  redactPiiFromLogString,
} from '@/lib/services/logPiiRedaction';
import { redactLogPayload } from '@/lib/services/logRedaction';

const LONG_FILLER = 'The quarterly report is attached and nothing else needs doing this week. '.repeat(8);

/** Strings the pass has always scanned. */
const SCANNED_CORPUS = [
  'My name is Jane Doe, reach me at jane.doe@example.com',
  'Contact support at help@example.com for assistance.',
  'What is the capital of France?',
  'Delivery failed for jane.doe@example.com: mailbox full',
  'Card 4111 1111 1111 1111 expires next year',
  '4111111111111111',
  '05321234567',
  'TR330006100519786457841326',
  `${LONG_FILLER} write to long.tail@example.com`,
  `${LONG_FILLER} nothing personal here`,
  'a@b.co',
];

beforeEach(() => {
  clearLogPiiMemoForTests();
  hoisted.calls = 0;
  hoisted.fail = false;
});

/** The detector's own answer: what the pass stored before the memo existed. */
const detectorAnswer = async (text: string) => (await redactPii({ text })).outputText;

describe('memo parity', () => {
  it('gives the detector\'s answer on the first call and the same answer from the memo on the next', async () => {
    for (const text of SCANNED_CORPUS) {
      const expected = await detectorAnswer(text);
      expect(await redactPiiFromLogString(text)).toBe(expected);
    }
    const callsAfterCold = hoisted.calls;
    // The corpus loop above called the detector itself once per string too: only the pass's calls are compared below.
    hoisted.calls = 0;

    for (const text of SCANNED_CORPUS) {
      expect(await redactPiiFromLogString(text)).toBe(await detectorAnswer(text));
    }
    // Every second-round call of the pass was answered from the memo: the detector ran only for the expectation.
    expect(hoisted.calls).toBe(SCANNED_CORPUS.length);
    expect(callsAfterCold).toBe(SCANNED_CORPUS.length * 2);
  });

  it('still redacts what it did before, from the memo as well', async () => {
    const email = 'My name is Jane Doe, reach me at jane.doe@example.com';
    expect(await redactPiiFromLogString(email)).not.toContain('jane.doe@example.com');
    expect(await redactPiiFromLogString(email)).not.toContain('jane.doe@example.com');
    expect(await redactPiiFromLogString('4111111111111111')).toContain('REDACTED');
    expect(await redactPiiFromLogString('05321234567')).toContain('REDACTED');
  });

  it('gives a payload the same result cold and warm, in nested keys and arrays too', async () => {
    const payload = () => ({
      apiKey: 'sk-left-to-the-secret-scrub',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'My name is Jane Doe, reach me at jane.doe@example.com' },
        { role: 'assistant', content: [{ type: 'text', text: 'Noted: 4111 1111 1111 1111' }] },
      ],
      choices: [{ message: { content: 'Contact support at help@example.com for assistance.' } }],
      deep: { a: { b: { c: { note: 'ping deep.person@example.com' } } } },
      n: 7,
      flag: true,
      empty: null,
    });

    const cold = await redactPiiFromLogPayload(payload());
    const warm = await redactPiiFromLogPayload(payload());

    expect(warm).toEqual(cold);
    const json = JSON.stringify(warm);
    for (const leaked of ['jane.doe@example.com', 'help@example.com', 'deep.person@example.com', '4111 1111 1111 1111']) {
      expect(json).not.toContain(leaked);
    }
    expect((warm as { apiKey: string }).apiKey).toBe('sk-left-to-the-secret-scrub');
  });

  it('scans an agent step\'s repeated history once, however many steps repeat it', async () => {
    const history = [
      { role: 'user', content: 'My name is Jane Doe, reach me at jane.doe@example.com' },
      { role: 'assistant', content: 'Thanks, I have your details on file now.' },
    ];
    await redactPiiFromLogPayload({ messages: history });
    const afterFirstStep = hoisted.calls;

    await redactPiiFromLogPayload({ messages: [...history, { role: 'user', content: 'And what about my order status?' }] });

    // Only the new message reached the detector.
    expect(hoisted.calls - afterFirstStep).toBe(1);
  });

  it('keys a long string by its content: two long strings that start alike do not share an answer', async () => {
    const clean = await redactPiiFromLogString(`${LONG_FILLER} nothing personal here`);
    const dirty = await redactPiiFromLogString(`${LONG_FILLER} write to long.tail@example.com`);
    expect(clean).toContain('nothing personal here');
    expect(dirty).not.toContain('long.tail@example.com');
  });

  it('keeps a short string from spelling the key of a long one', async () => {
    const long = `${LONG_FILLER} write to long.tail@example.com`;
    await redactPiiFromLogString(long);
    const lookalike = `h:${createHash('sha1').update(long).digest('hex')}`;
    expect(await redactPiiFromLogString(lookalike)).toBe(await detectorAnswer(lookalike));
  });

  it('does not keep an answer the detector failed to give', async () => {
    const text = 'Write to jane.doe@example.com please';
    hoisted.fail = true;
    expect(await redactPiiFromLogString(text)).toBe(text); // falls back to the untouched string, as before
    hoisted.fail = false;
    expect(await redactPiiFromLogString(text)).not.toContain('jane.doe@example.com');
  });

  it('is a bounded LRU: the oldest entry goes first, a use renews an entry', async () => {
    const kept = 'keep jane.doe@example.com in view';
    await redactPiiFromLogString(kept);
    for (let i = 0; i < 1999; i += 1) await redactPiiFromLogString(`filler number ${i} for the memo bound`);
    await redactPiiFromLogString(kept); // renewed: now the newest
    for (let i = 0; i < 5; i += 1) await redactPiiFromLogString(`more filler ${i} for the memo bound`);

    hoisted.calls = 0;
    await redactPiiFromLogString(kept);
    expect(hoisted.calls).toBe(0);
    await redactPiiFromLogString('filler number 0 for the memo bound');
    expect(hoisted.calls).toBe(1);
  });
});

describe('skip rules', () => {
  it('does not run the detector on strings under 4 characters, a UUID or a hex id', async () => {
    const skipped = ['', 'ab', 'abc', '550e8400-e29b-41d4-a716-446655440000', 'abcd1234abcd1234', '5f1d7f3e9b2a4c6d8e0f1a2b'];
    for (const text of skipped) expect(await redactPiiFromLogString(text)).toBe(text);
    expect(hoisted.calls).toBe(0);
  });

  it('still scans a string that is only digits, and a hex-looking string with no letters', async () => {
    expect(await redactPiiFromLogString('4111111111111111')).toBe(await detectorAnswer('4111111111111111'));
    expect(await redactPiiFromLogString('12345678901234567890')).toBe(await detectorAnswer('12345678901234567890'));
    expect(hoisted.calls).toBeGreaterThanOrEqual(2);
  });

  it('still scans the shortest string the detector can find something in', async () => {
    expect(await redactPiiFromLogString('a@b.c')).toBe(await detectorAnswer('a@b.c'));
  });
});

describe('the truncation preview', () => {
  it('is cut before the PII pass and what is left of it is still redacted', async () => {
    const payload = {
      messages: [{ role: 'user', content: 'reach me at jane.doe@example.com' }],
      padding: 'x'.repeat(5_000),
    };
    const capped = redactLogPayload(payload, { maxBytes: 400 }) as { _truncated?: boolean; preview?: string };
    expect(capped._truncated).toBe(true);
    expect(capped.preview).toContain('jane.doe@example.com');

    const stored = await redactPiiFromLogPayload(capped);
    expect(JSON.stringify(stored)).not.toContain('jane.doe@example.com');
  });
});
