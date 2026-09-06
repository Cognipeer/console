/**
 * Regression tests for F-12 (finance-institution assessment, 2026-09-05):
 * secret-key/value redaction masked `apiKey` but left a synthetic person's
 * email untouched inside `messages[].content`. logPiiRedaction.ts wires the
 * already-existing PII detector (@/lib/services/pii/piiService) — whose own
 * file header admitted it "was intentionally not wired into other
 * modules... yet" — into the usage-log write path.
 */
import { describe, expect, it } from 'vitest';
import { redactPiiFromLogPayload, redactPiiFromLogString } from '@/lib/services/logPiiRedaction';

describe('redactPiiFromLogPayload', () => {
  it('redacts an email nested inside messages[].content, matching the assessment\'s synthetic example', () => {
    const payload = {
      apiKey: 'sk-should-be-untouched-by-this-module', // logRedaction.ts's job, not this one
      messages: [
        { role: 'user', content: 'My name is Jane Doe, reach me at jane.doe@example.com' },
      ],
    };

    const result = redactPiiFromLogPayload(payload);

    expect(result.messages[0].content).not.toContain('jane.doe@example.com');
    expect(result.apiKey).toBe('sk-should-be-untouched-by-this-module');
  });

  it('leaves content with no PII completely unchanged', () => {
    const payload = { messages: [{ role: 'user', content: 'What is the capital of France?' }] };
    const result = redactPiiFromLogPayload(payload);
    expect(result).toEqual(payload);
  });

  it('walks arrays and nested objects', () => {
    const payload = {
      choices: [
        { message: { content: 'Contact support at help@example.com for assistance.' } },
      ],
    };
    const result = redactPiiFromLogPayload(payload);
    expect(result.choices[0].message.content).not.toContain('help@example.com');
  });

  it('preserves Date, Buffer, and Error instances instead of flattening them to {}', () => {
    const date = new Date('2026-09-06T00:00:00Z');
    const buf = Buffer.from('binary');
    const err = new Error('boom');
    const payload = { date, buf, err };

    const result = redactPiiFromLogPayload(payload);

    expect(result.date).toBe(date);
    expect(result.buf).toBe(buf);
    expect(result.err).toBe(err);
  });

  it('handles a circular reference without throwing', () => {
    const payload: Record<string, unknown> = { note: 'hi' };
    payload.self = payload;

    expect(() => redactPiiFromLogPayload(payload)).not.toThrow();
  });

  it('passes null/undefined through unchanged', () => {
    expect(redactPiiFromLogPayload(null)).toBeNull();
    expect(redactPiiFromLogPayload(undefined)).toBeUndefined();
  });
});

describe('redactPiiFromLogString', () => {
  it('redacts an email inside a free-text error message', () => {
    const result = redactPiiFromLogString('Delivery failed for jane.doe@example.com: mailbox full');
    expect(result).not.toContain('jane.doe@example.com');
  });

  it('passes an empty/undefined string through unchanged', () => {
    expect(redactPiiFromLogString(undefined)).toBeUndefined();
    expect(redactPiiFromLogString('')).toBe('');
  });
});
