/**
 * Unit tests — PII text normalization, redaction and the detection paths that
 * back them (`pii/detector`, `families/secrets`). All pure functions with no
 * external dependencies.
 */

import { describe, it, expect } from 'vitest';
import { detect } from '@/lib/services/pii/detector';
import { normalizeText, deobfuscateEmails } from '@/lib/services/guardrail/textNormalization';
import { redactFindings } from '@/lib/services/guardrail/redactFindings';
import { scanSecrets } from '@/lib/services/guardrail/families/secrets';
import type { GuardrailFinding } from '@/lib/services/guardrail/types';

/** Detection over the original text plus the normalized view, as the PII family does. */
function detectWithNormalization(text: string, categories: Record<string, boolean>) {
  const view = deobfuscateEmails(normalizeText(text));
  return detect(view, { categories });
}

function toFindings(text: string, categories: Record<string, boolean>): GuardrailFinding[] {
  return detect(text, { categories }).map((f) => ({
    type: 'pii',
    category: f.category,
    severity: 'high',
    message: '',
    action: 'redact',
    block: false,
    value: f.value,
  })) as GuardrailFinding[];
}

describe('detect — iban', () => {
  const categories = { iban: true };

  it('detects a checksum-valid Turkish IBAN', () => {
    const findings = detect('IBAN: TR330006100519786457841326', { categories });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe('iban');
  });

  it('detects a checksum-valid UK IBAN', () => {
    expect(detect('GB29NWBK60161331926819', { categories }).length).toBeGreaterThan(0);
  });
});

describe('text normalization — obfuscation resistance', () => {
  const categories = { email: true };

  it('detects spelled-out email obfuscation "(at) … (dot)"', () => {
    const findings = detectWithNormalization('reach me: john (at) example (dot) com', categories);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe('email');
  });

  it('detects "[at]" bracket style', () => {
    expect(detectWithNormalization('mail: jane[at]corp[dot]org', categories).length).toBeGreaterThan(0);
  });

  it('does not rewrite ordinary sentences containing " at "', () => {
    expect(deobfuscateEmails('the meeting is at 5.30 today')).toBe('the meeting is at 5.30 today');
    expect(detectWithNormalization('the meeting is at 5.30 today', categories)).toHaveLength(0);
  });

  it('detects an email hidden with zero-width characters', () => {
    const hidden = 'john​@​example​.com';
    expect(normalizeText(hidden)).toBe('john@example.com');
    expect(detectWithNormalization(`contact ${hidden}`, categories).length).toBeGreaterThan(0);
  });

  it('folds fullwidth characters (NFKC)', () => {
    expect(normalizeText('ｅｘａｍｐｌｅ')).toBe('example');
  });
});

describe('scanSecrets — known prefixes and entropy', () => {
  it('detects short known-prefix secrets (AWS access key)', () => {
    const findings = scanSecrets('key = AKIAIOSFODNN7EXAMPLE');
    expect(findings.length).toBeGreaterThan(0);
  });

  it('detects sk- style keys', () => {
    expect(scanSecrets('OPENAI_KEY=sk-proj-Ab3dEf9hIjKl2mNoPq').length).toBeGreaterThan(0);
  });

  it('detects JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(scanSecrets(`token: ${jwt}`).length).toBeGreaterThan(0);
  });

  it('does not flag low-entropy repeated strings', () => {
    expect(scanSecrets('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toHaveLength(0);
  });
});

describe('redactFindings', () => {
  it('masks detected values with category tags', () => {
    const text = 'Email hello@example.com and card 4242 4242 4242 4242';
    const findings = toFindings(text, { email: true, creditCard: true });
    const redacted = redactFindings(text, findings);
    expect(redacted).not.toContain('hello@example.com');
    expect(redacted).not.toContain('4242 4242 4242 4242');
    expect(redacted).toContain('[REDACTED:email]');
    expect(redacted).toContain('[REDACTED:creditCard]');
  });

  it('masks every occurrence of a repeated value', () => {
    const text = 'a@b.com again a@b.com';
    const redacted = redactFindings(text, toFindings(text, { email: true }));
    expect(redacted).not.toContain('a@b.com');
  });

  it('labels non-PII finding types by their category (e.g. word_filter)', () => {
    const redacted = redactFindings('well damn that', [
      { type: 'word_filter', category: 'banned_word', severity: 'high', message: '', action: 'redact', block: false, value: 'damn' },
    ]);
    expect(redacted).toContain('[REDACTED:banned_word]');
    expect(redacted).not.toContain('damn');
  });
});
