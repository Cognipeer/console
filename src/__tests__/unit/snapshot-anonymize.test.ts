/**
 * Unit tests — PII anonymization pipeline (snapshots gate).
 *
 * Pure module: rides on the existing detector, no DB access to mock.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  anonymizeMessages,
  anonymizeText,
  pseudonymToken,
  type AnonymizeOptions,
} from '@/lib/services/pii/anonymize';

const SALT = 'unit-test-salt';

function opts(overrides: Partial<AnonymizeOptions> = {}): AnonymizeOptions {
  return { categories: ['email'], strategy: 'pseudonym', salt: SALT, ...overrides };
}

function expectedToken(salt: string, category: string, value: string): string {
  const digest = createHmac('sha256', salt).update(value).digest('hex').slice(0, 6);
  return `<${category.toUpperCase()}_${digest}>`;
}

describe('pseudonym strategy', () => {
  it('replaces findings with deterministic <CATEGORY_hash> tokens', () => {
    const email = 'john.doe@example.com';
    const result = anonymizeText(`contact ${email} please`, opts());
    expect(result.findings).toBe(1);
    expect(result.text).toBe(`contact ${expectedToken(SALT, 'email', email)} please`);
    expect(result.text).not.toContain(email);
  });

  it('same value + same salt → same token (across calls and positions)', () => {
    const email = 'jane@corp.io';
    const a = anonymizeText(`${email} wrote to ${email}`, opts());
    const b = anonymizeText(`reply to ${email}`, opts());
    const token = expectedToken(SALT, 'email', email);
    expect(a.text).toBe(`${token} wrote to ${token}`);
    expect(b.text).toBe(`reply to ${token}`);
  });

  it('different salt → different token', () => {
    const email = 'jane@corp.io';
    const a = anonymizeText(email, opts());
    const b = anonymizeText(email, opts({ salt: 'other-salt' }));
    expect(a.text).not.toBe(b.text);
    expect(a.text).toMatch(/^<EMAIL_[0-9a-f]{6}>$/);
    expect(b.text).toMatch(/^<EMAIL_[0-9a-f]{6}>$/);
  });

  it('sanitizes category ids into the token prefix', () => {
    expect(pseudonymToken(SALT, 'tr_phone', '0532 111 22 33')).toMatch(/^<TR_PHONE_[0-9a-f]{6}>$/);
  });

  it('only runs the requested categories', () => {
    const text = 'mail a@b.co or call +1 212 555 0100';
    const emailOnly = anonymizeText(text, opts({ categories: ['email'] }));
    expect(emailOnly.findings).toBe(1);
    expect(emailOnly.text).toContain('+1 212 555 0100');

    const both = anonymizeText(text, opts({ categories: ['email', 'phone'] }));
    expect(both.findings).toBe(2);
    expect(both.text).not.toContain('212 555 0100');
  });
});

describe('mask strategy', () => {
  it("applies each category's existing mask strategy", () => {
    const result = anonymizeText(
      'from john.doe@example.com',
      opts({ strategy: 'mask' }),
    );
    expect(result.findings).toBe(1);
    // keep-domain mask: local part masked, domain kept.
    expect(result.text).toBe('from j*******@example.com');
  });

  it('keep-last mask for phone numbers', () => {
    const result = anonymizeText(
      'call +12125550100 now',
      opts({ strategy: 'mask', categories: ['phone'] }),
    );
    expect(result.findings).toBe(1);
    expect(result.text).toContain('0100');
    expect(result.text).not.toContain('+12125550100');
  });
});

describe('custom patterns', () => {
  it('reuses the IPiiPolicy custom pattern shape', () => {
    const result = anonymizeText('order ORD-12345 shipped', opts({
      categories: [],
      customPatterns: [{
        id: 'p1',
        categoryId: 'order_id',
        label: 'Order id',
        pattern: 'ORD-\\d{5}',
        enabled: true,
      }],
    }));
    expect(result.findings).toBe(1);
    expect(result.text).toBe(`order ${expectedToken(SALT, 'order_id', 'ORD-12345')} shipped`);
  });
});

describe('anonymizeMessages', () => {
  it('walks string content and array-of-parts content', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'I am reachable at john.doe@example.com' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'backup mail: jane@corp.io' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xyz' } },
        ],
      },
    ];
    const result = anonymizeMessages(messages, opts());
    expect(result.findings).toBe(2);
    expect(result.messages[0].content).toBe('You are helpful.');
    expect(result.messages[1].content).toBe(
      `I am reachable at ${expectedToken(SALT, 'email', 'john.doe@example.com')}`,
    );
    const parts = result.messages[2].content as Array<Record<string, unknown>>;
    expect(parts[0].text).toBe(`backup mail: ${expectedToken(SALT, 'email', 'jane@corp.io')}`);
    // Non-text parts pass through untouched.
    expect(parts[1]).toEqual((messages[2].content as Array<Record<string, unknown>>)[1]);
  });

  it('does not mutate the input', () => {
    const messages = [{ role: 'user', content: 'ping a@b.co' }];
    anonymizeMessages(messages, opts());
    expect(messages[0].content).toBe('ping a@b.co');
  });

  it('passes non-string, non-array content through untouched', () => {
    const messages = [{ role: 'assistant', content: null }];
    const result = anonymizeMessages(messages, opts());
    expect(result.messages[0].content).toBeNull();
    expect(result.findings).toBe(0);
  });
});
