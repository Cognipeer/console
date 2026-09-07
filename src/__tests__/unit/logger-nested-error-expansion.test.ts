/**
 * Regression test for a live incident's real root cause: `logger.error('X
 * failed', { error })` -- the dominant error-logging pattern across this
 * codebase -- silently dropped the error's own `message` and `stack` from
 * every JSON log line, leaving only whatever a custom Error subclass happened
 * to assign as an enumerable own property (e.g. Playwright's TimeoutError
 * setting `this.name`). A plain `Error`'s `message`/`stack` are non-enumerable
 * own properties, so `JSON.stringify` drops them with no special handling --
 * which is exactly why pod logs showed `{"name":"TimeoutError"}` and nothing
 * else, no matter what the underlying failure actually was.
 *
 * Goes through the REAL pipeline (redactSecretsFormat -> winston's own
 * errors({stack:true}) -> json()) rather than testing a helper in isolation,
 * because the bug was specifically about what survives to the final
 * serialized line.
 */
import { describe, it, expect } from 'vitest';
import winston from 'winston';
import { redactSecretsFormat, SENSITIVE_KEY_PATTERN } from '@/lib/core/logger';

function serialize(message: string, meta: Record<string, unknown>): Record<string, unknown> {
  const pipeline = winston.format.combine(
    redactSecretsFormat(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  );
  const info = pipeline.transform({ level: 'error', message, ...meta }, {}) as Record<string, unknown> | false;
  if (!info) throw new Error('format pipeline dropped the log entry');
  return JSON.parse((info[Symbol.for('message') as unknown as string] as string) ?? JSON.stringify(info));
}

describe('logger — nested Error expansion (redactSecretsFormat)', () => {
  it('preserves message and stack for an Error nested in metadata, not just name', () => {
    const error = new (class extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'TimeoutError'; // matches Playwright's own error classes
      }
    })('page.screenshot: Timeout 5000ms exceeded.');

    const line = serialize('Live screenshot failed', { error });

    const logged = line.error as Record<string, unknown>;
    expect(logged.name).toBe('TimeoutError');
    expect(logged.message).toBe('page.screenshot: Timeout 5000ms exceeded.');
    expect(typeof logged.stack).toBe('string');
    expect((logged.stack as string).length).toBeGreaterThan(0);
  });

  it('still redacts a sensitive-named property carried on a custom Error subclass', () => {
    const error = new (class extends Error {
      apiKey = 'sk-should-never-appear-in-logs';
      constructor() {
        super('request failed');
        this.name = 'UpstreamError';
      }
    })();

    const line = serialize('Upstream call failed', { error });
    const logged = line.error as Record<string, unknown>;
    expect(logged.message).toBe('request failed');
    expect(logged.apiKey).toBe('[REDACTED]');
  });

  it('does not affect a plain (non-Error) metadata object', () => {
    const line = serialize('Something happened', { count: 3, ok: true });
    expect(line.count).toBe(3);
    expect(line.ok).toBe(true);
  });
});

// Sanity check the pattern itself still exists, so this test would fail loudly
// if the sensitive-key regex it exercises above is ever renamed.
describe('SENSITIVE_KEY_PATTERN sanity', () => {
  it('matches apiKey', () => {
    expect(SENSITIVE_KEY_PATTERN.test('apiKey')).toBe(true);
  });
});
