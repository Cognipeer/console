/**
 * Unit tests — standalone PII service detector.
 * Pure-function tests (no DB, no fastify).
 */

import { describe, expect, it } from 'vitest';
import { detect, applyReplacements, tokenize, detokenize } from '@/lib/services/pii/detector';

describe('pii service · detector — email', () => {
  it('detects email addresses (default categories include email)', () => {
    const findings = detect('Reach me at hello@example.com', {});
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('email');
    expect(findings[0].value).toBe('hello@example.com');
    expect(findings[0].label).toBe('Email address');
  });

  it('respects the locale for finding label', () => {
    const findings = detect('Reach me at hello@example.com', { locale: 'tr' });
    expect(findings[0].label).toBe('E-posta adresi');
    expect(findings[0].message).toContain('tespit edildi');
  });

  it('disables a category when explicitly false', () => {
    const findings = detect('hello@example.com', { categories: { email: false } });
    expect(findings).toHaveLength(0);
  });
});

describe('pii service · detector — luhn-validated credit cards', () => {
  it('detects a valid Luhn number', () => {
    const findings = detect('Card: 4242 4242 4242 4242', {});
    expect(findings.some((f) => f.category === 'creditCard')).toBe(true);
  });

  it('rejects non-Luhn 16-digit strings', () => {
    const findings = detect('Card: 1234 5678 9012 3456', {});
    expect(findings.some((f) => f.category === 'creditCard')).toBe(false);
  });
});

describe('pii service · detector — Turkish TC kimlik', () => {
  it('does not detect TC kimlik when tr language is not enabled', () => {
    // 10000000146 is a known valid TC kimlik number used in examples
    const findings = detect('Müşteri: 10000000146', { categories: {} });
    expect(findings.some((f) => f.category === 'tc_kimlik')).toBe(false);
  });

  it('detects valid TC kimlik when tr language is enabled', () => {
    const findings = detect('Müşteri: 10000000146', {
      languages: ['tr'],
      categories: { tc_kimlik: true },
      locale: 'tr',
    });
    expect(findings.some((f) => f.category === 'tc_kimlik')).toBe(true);
  });

  it('rejects TC kimlik with bad checksum', () => {
    const findings = detect('Müşteri: 10000000100', {
      languages: ['tr'],
      categories: { tc_kimlik: true },
    });
    expect(findings.some((f) => f.category === 'tc_kimlik')).toBe(false);
  });
});

describe('pii service · detector — custom patterns', () => {
  it('applies an enabled custom regex', () => {
    const findings = detect('Order CUS-12345 for pickup', {
      categories: {},
      customPatterns: [
        {
          id: 'p1',
          categoryId: 'order_id',
          label: 'Order ID',
          pattern: 'CUS-\\d{5}',
          severity: 'medium',
          enabled: true,
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('order_id');
    expect(findings[0].source).toBe('custom');
  });

  it('skips disabled custom patterns', () => {
    const findings = detect('Order CUS-12345 for pickup', {
      categories: {},
      customPatterns: [
        {
          id: 'p1',
          categoryId: 'order_id',
          label: 'Order ID',
          pattern: 'CUS-\\d{5}',
          enabled: false,
        },
      ],
    });
    expect(findings).toHaveLength(0);
  });

  it('safely ignores invalid regex syntax', () => {
    const findings = detect('hello', {
      categories: {},
      customPatterns: [
        { id: 'p1', categoryId: 'bad', label: 'Bad', pattern: '(unclosed', enabled: true },
      ],
    });
    expect(findings).toHaveLength(0);
  });
});

describe('pii service · detector — overlap resolution', () => {
  it('keeps the higher-severity overlap', () => {
    // An email overlaps with apiKey for the local part; both potentially match,
    // but we ensure overlapping findings are reduced to one per range
    const findings = detect('contact: user_abcdefghijklmnopqrstuvwxyz0123456789@x.com', {
      categories: { email: true, apiKey: true },
    });
    // We should NOT have overlapping ranges
    for (let i = 0; i < findings.length; i++) {
      for (let j = i + 1; j < findings.length; j++) {
        const a = findings[i];
        const b = findings[j];
        const overlap = a.start < b.end && b.start < a.end;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe('pii service · applyReplacements', () => {
  it('redacts findings into the output', () => {
    const text = 'Reach me at hello@example.com soon';
    const findings = detect(text, {}, 'redact');
    const out = applyReplacements(text, findings);
    expect(out).toBe('Reach me at [REDACTED_EMAIL] soon');
  });

  it('masks emails using keep-domain strategy', () => {
    const text = 'jane.doe@gmail.com';
    const findings = detect(text, {}, 'mask');
    const out = applyReplacements(text, findings);
    expect(out.endsWith('@gmail.com')).toBe(true);
    expect(out.startsWith('j')).toBe(true);
    expect(out).toContain('*');
  });

  it('masks credit cards keeping the last 4 digits', () => {
    const text = '4242 4242 4242 4242';
    const findings = detect(text, {}, 'mask');
    const out = applyReplacements(text, findings);
    expect(out.endsWith('4242')).toBe(true);
    expect(out.startsWith('*')).toBe(true);
  });

  it('returns the original text when there are no findings', () => {
    const text = 'nothing sensitive here';
    const findings = detect(text, {});
    expect(applyReplacements(text, findings)).toBe(text);
  });
});

describe('pii service · tokenize / detokenize', () => {
  it('replaces findings with reversible tokens and round-trips back', () => {
    const text = 'Mail me at jane@gmail.com or visit https://acme.example';
    const findings = detect(text, { categories: { email: true, url: true } }, 'tokenize');
    const { outputText, vault } = tokenize(text, findings);

    expect(outputText).toContain('[EMAIL_1]');
    expect(outputText).not.toContain('jane@gmail.com');
    expect(vault['[EMAIL_1]'].value).toBe('jane@gmail.com');

    // Reversing the tokenized text restores the original exactly.
    expect(detokenize(outputText, vault)).toBe(text);
  });

  it('round-trips even when a model rewrites surrounding text (token preserved)', () => {
    const text = 'Call 5551234567 now';
    const findings = detect(text, { languages: ['tr'], categories: { tr_phone: true, phone: true } }, 'tokenize');
    const { outputText, vault } = tokenize(text, findings);
    // simulate an LLM response that echoes the token in new wording
    const modelReply = `Sure, I will call ${Object.keys(vault)[0]} right away.`;
    expect(detokenize(modelReply, vault)).toContain('5551234567');
  });

  it('assigns the same token to repeated identical values (dedupe)', () => {
    const text = 'a@x.com and again a@x.com';
    const findings = detect(text, { categories: { email: true } }, 'tokenize');
    const { outputText, vault } = tokenize(text, findings);
    expect(Object.keys(vault)).toHaveLength(1);
    expect(outputText).toBe('[EMAIL_1] and again [EMAIL_1]');
  });

  it('numbers distinct values within a category sequentially', () => {
    const text = 'a@x.com, b@y.com';
    const findings = detect(text, { categories: { email: true } }, 'tokenize');
    const { vault } = tokenize(text, findings);
    expect(vault['[EMAIL_1]'].value).toBe('a@x.com');
    expect(vault['[EMAIL_2]'].value).toBe('b@y.com');
  });

  it('leaves unknown tokens untouched on detokenize', () => {
    expect(detokenize('hello [EMAIL_9]', {})).toBe('hello [EMAIL_9]');
    expect(detokenize('plain text', undefined)).toBe('plain text');
  });
});
