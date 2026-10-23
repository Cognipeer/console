/**
 * Against the REAL `@cognipeer/pii` package (a normal npm dependency, always
 * present after `npm install` — nothing to mock or skip), covering both:
 *  - `cognipeerEngine.ts#scanWithCognipeer` directly (the bridge itself)
 *  - `piiService.ts`'s ad-hoc `detect/redact/mask/tokenizePii` dispatching to
 *    it via `input.engine === 'cognipeer'`, and staying on the unchanged
 *    'regex' path (this repo's own `services/pii/categories.ts`) when
 *    `engine` is absent — the pre-existing-caller compatibility guarantee
 *    `PiiEngine`'s own doc comment describes.
 */
import { describe, it, expect } from 'vitest';
import { scanWithCognipeer } from '@/lib/services/pii/cognipeerEngine';
import { detectPii, redactPii, maskPii, tokenizePii, detokenizePii } from '@/lib/services/pii/piiService';

describe('scanWithCognipeer', () => {
  it('detects an email with the package\'s own category catalog', async () => {
    const { findings, degraded } = await scanWithCognipeer('Reach me at hello@example.com', {}, 'detect');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('email');
    expect(findings[0].value).toBe('hello@example.com');
    expect(findings[0].action).toBe('detect');
    expect(findings[0].block).toBe(false);
    expect(degraded).toEqual([]);
  });

  it('stamps the requested action, not the package\'s own detect-only report', async () => {
    const redacted = await scanWithCognipeer('hello@example.com', {}, 'redact');
    expect(redacted.findings[0].action).toBe('redact');
    const blocked = await scanWithCognipeer('hello@example.com', {}, 'block');
    expect(blocked.findings[0].action).toBe('block');
    expect(blocked.findings[0].block).toBe(true);
  });

  it('respects an explicit categories map (email disabled)', async () => {
    const { findings } = await scanWithCognipeer('hello@example.com', { categories: { email: false } }, 'detect');
    expect(findings).toEqual([]);
  });

  it('reports person/organization/location only when the categories map enables them', async () => {
    const text = 'Sayın Ayşe Yılmaz, işvereni Koç Holding, Kadıköy.';
    const off = await scanWithCognipeer(text, { categories: { person: false, organization: false, location: false }, languages: ['tr'] }, 'detect');
    expect(off.findings).toEqual([]);
    const unset = await scanWithCognipeer(text, { languages: ['tr'] }, 'detect');
    expect(unset.findings).toEqual([]);
    const on = await scanWithCognipeer(text, { categories: { person: true, organization: true, location: false }, languages: ['tr'] }, 'detect');
    expect(on.findings.map((f) => f.category).sort()).toEqual(['organization', 'person']);
  });

  it('applies a custom pattern alongside the built-in catalog', async () => {
    const { findings } = await scanWithCognipeer(
      'Order CUS-12345 for pickup',
      { customPatterns: [{ id: 'p1', categoryId: 'order_id', label: 'Order ID', pattern: 'CUS-\\d{5}', severity: 'medium', enabled: true }] },
      'detect',
    );
    expect(findings.some((f) => f.category === 'order_id' && f.value === 'CUS-12345')).toBe(true);
  });

  it('finds the Turkish national id under its own id ("tc_kimlik" here, "tckn" in the regex engine)', async () => {
    const { findings } = await scanWithCognipeer('Müşteri: 10000000146', { languages: ['tr'] }, 'detect');
    expect(findings.some((f) => f.category === 'tc_kimlik')).toBe(true);
  });
});

describe('piiService ad-hoc functions · engine dispatch', () => {
  it('detectPii defaults to the regex engine (unchanged pre-existing behaviour, locale-aware label)', async () => {
    const result = await detectPii({ text: 'hello@example.com', locale: 'tr' });
    expect(result.findings[0].label).toBe('E-posta adresi');
  });

  it('detectPii with engine:"cognipeer" uses the package\'s own (English-only) label', async () => {
    const result = await detectPii({ text: 'hello@example.com', locale: 'tr', engine: 'cognipeer' });
    expect(result.findings[0].label).toBe('Email address');
  });

  it('redactPii/maskPii produce a rewritten outputText via the cognipeer engine', async () => {
    const redacted = await redactPii({ text: 'Reach me at hello@example.com', engine: 'cognipeer' });
    expect(redacted.outputText).not.toContain('hello@example.com');
    const masked = await maskPii({ text: 'hello@example.com', engine: 'cognipeer' });
    expect(masked.outputText).not.toBe('hello@example.com');
    expect(masked.outputText).toContain('@example.com');
  });

  it('leaves disabled name categories in the output text', async () => {
    const text = 'Sayın Ayşe Yılmaz mail: jane@gmail.com';
    const { outputText } = await tokenizePii({ text, engine: 'cognipeer', categories: { email: true, person: false } });
    expect(outputText).toBe('Sayın Ayşe Yılmaz mail: [EMAIL_1]');
  });

  it('tokenizePii round-trips through detokenizePii regardless of engine', async () => {
    const { outputText, vault } = await tokenizePii({ text: 'Mail me at jane@gmail.com', engine: 'cognipeer' });
    expect(outputText).not.toContain('jane@gmail.com');
    const restored = detokenizePii({ text: outputText, vault });
    expect(restored.outputText).toBe('Mail me at jane@gmail.com');
  });
});
