/**
 * Unit tests — Word Filter
 * runWordFilter is a pure function with no external dependencies.
 */

import { describe, it, expect } from 'vitest';
import { runWordFilter } from '@/lib/services/guardrail/wordFilter';
import type { IGuardrailWordFilterPolicy } from '@/lib/database';

function makePolicy(overrides: Partial<IGuardrailWordFilterPolicy> = {}): IGuardrailWordFilterPolicy {
  return { enabled: true, action: 'block', ...overrides };
}

describe('runWordFilter — disabled / empty', () => {
  it('returns no findings when disabled', () => {
    expect(runWordFilter('fuck this', { enabled: false })).toHaveLength(0);
  });

  it('returns no findings for empty text', () => {
    expect(runWordFilter('   ', makePolicy())).toHaveLength(0);
  });

  it('returns no findings for clean text', () => {
    expect(runWordFilter('What a lovely day for a walk', makePolicy())).toHaveLength(0);
  });
});

describe('runWordFilter — English profanity', () => {
  it('detects plain profanity', () => {
    const findings = runWordFilter('this is fucking terrible', makePolicy());
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].type).toBe('word_filter');
    expect(findings[0].block).toBe(true);
  });

  it('detects mixed-case profanity', () => {
    expect(runWordFilter('FuCk you', makePolicy()).length).toBeGreaterThan(0);
  });

  it('detects leetspeak profanity (fvck-style substitutions)', () => {
    expect(runWordFilter('f0ck off', makePolicy()).length).toBeGreaterThan(0);
    expect(runWordFilter('b1tch please', makePolicy()).length).toBeGreaterThan(0);
    expect(runWordFilter('$hit happens', makePolicy()).length).toBeGreaterThan(0);
  });

  it('detects stretched letters', () => {
    expect(runWordFilter('fuuuuck', makePolicy()).length).toBeGreaterThan(0);
  });

  it('detects spaced-out letters', () => {
    expect(runWordFilter('f u c k this', makePolicy()).length).toBeGreaterThan(0);
  });

  it('detects glued compounds via stems', () => {
    expect(runWordFilter('you motherfuckers', makePolicy()).length).toBeGreaterThan(0);
  });
});

describe('runWordFilter — Turkish profanity', () => {
  it('detects plain Turkish profanity', () => {
    expect(runWordFilter('orospu çocuğu', makePolicy()).length).toBeGreaterThan(0);
    expect(runWordFilter('siktir git', makePolicy()).length).toBeGreaterThan(0);
    expect(runWordFilter('amk ya', makePolicy()).length).toBeGreaterThan(0);
  });

  it('detects diacritic variants', () => {
    expect(runWordFilter('amcık', makePolicy()).length).toBeGreaterThan(0);
    expect(runWordFilter('amcik', makePolicy()).length).toBeGreaterThan(0);
  });

  it('detects leet variants of Turkish profanity', () => {
    expect(runWordFilter('s1kt1r', makePolicy()).length).toBeGreaterThan(0);
  });

  it('detects glued Turkish compounds via stems', () => {
    expect(runWordFilter('ananısikeyim dedi', makePolicy()).length).toBeGreaterThan(0);
  });

  it('detects raw-only entries with diacritics', () => {
    expect(runWordFilter('tam bir piç', makePolicy()).length).toBeGreaterThan(0);
  });
});

describe('runWordFilter — false positive resistance', () => {
  it('does not flag words merely containing banned substrings', () => {
    expect(runWordFilter('a classic assessment of Scunthorpe', makePolicy())).toHaveLength(0);
  });

  it('does not flag the English word "pic" (folded collision with piç)', () => {
    expect(runWordFilter('send me the pic please', makePolicy())).toHaveLength(0);
  });

  it('does not flag the English word "got" (folded collision with göt)', () => {
    expect(runWordFilter('I got the answer', makePolicy())).toHaveLength(0);
  });

  it('does not leet-fold number-dominant tokens like "51k"', () => {
    expect(runWordFilter('the price is 51k', makePolicy())).toHaveLength(0);
  });
});

describe('runWordFilter — configuration', () => {
  it('respects disabled builtin lists', () => {
    const policy = makePolicy({ builtinLists: { 'profanity-en': false, 'profanity-tr': false } });
    expect(runWordFilter('fuck', policy)).toHaveLength(0);
  });

  it('matches custom words', () => {
    const policy = makePolicy({
      builtinLists: { 'profanity-en': false, 'profanity-tr': false },
      words: ['acmecorp'],
    });
    const findings = runWordFilter('have you tried AcmeCorp?', policy);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('banned_word');
  });

  it('matches custom regexes and reports the matched value', () => {
    const policy = makePolicy({
      builtinLists: { 'profanity-en': false, 'profanity-tr': false },
      regexes: ['secret-\\d+'],
    });
    const findings = runWordFilter('the code is secret-42', policy);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('custom_pattern');
    expect(findings[0].value).toBe('secret-42');
  });

  it('skips invalid regexes without throwing', () => {
    const policy = makePolicy({ regexes: ['([invalid'] });
    expect(() => runWordFilter('hello', policy)).not.toThrow();
  });

  it('uses the policy action for findings', () => {
    const findings = runWordFilter('fuck', makePolicy({ action: 'warn' }));
    expect(findings[0].action).toBe('warn');
    expect(findings[0].block).toBe(false);
  });
});

describe('runWordFilter — broad built-in coverage', () => {
  it('detects a spread of Turkish profanity from the expanded list', () => {
    for (const text of ['şerefsiz herif', 'tam bir yavşak', 'kahpelik yapma', 'pezevenk', 'hassiktir ordan']) {
      expect(runWordFilter(text, makePolicy()).length, text).toBeGreaterThan(0);
    }
  });

  it('detects a spread of English profanity/slurs from the expanded list', () => {
    for (const text of ['what a wanker', 'stupid dumbass', 'kys loser', 'total scumbag']) {
      expect(runWordFilter(text, makePolicy()).length, text).toBeGreaterThan(0);
    }
  });

  it('detects banned phrases across diacritic variants', () => {
    expect(runWordFilter('seni orospu cocugu', makePolicy()).length).toBeGreaterThan(0);
    expect(runWordFilter('go kill yourself now', makePolicy()).length).toBeGreaterThan(0);
  });

  it('does not flag curated innocent collisions', () => {
    for (const text of [
      'git push origin main',
      'af dilerim hocam',
      'salatalık ve hıyar turşusu',
      'the maine coon cat',
      'naked eye observation',
      'damn the torpedoes'.replace('damn', 'darn'),
    ]) {
      expect(runWordFilter(text, makePolicy()), text).toHaveLength(0);
    }
  });
});

describe('runWordFilter — uploaded custom lists', () => {
  const noBuiltins = { builtinLists: { 'profanity-en': false, 'profanity-tr': false } };

  it('matches words from resolved tenant lists', () => {
    const findings = runWordFilter(
      'have you seen AcmeWidget lately?',
      makePolicy(noBuiltins),
      [{ key: 'competitors', words: ['acmewidget'] }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('banned_word');
  });

  it('matches normalized variants of uploaded words (diacritics/leet)', () => {
    const findings = runWordFilter(
      'bu ürün çakma-ürün gibi',
      makePolicy(noBuiltins),
      [{ key: 'brands', words: ['çakma-ürün'] }],
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('matches multi-word phrases from uploaded lists', () => {
    const findings = runWordFilter(
      'lütfen rakip marka hakkında konuşma',
      makePolicy(noBuiltins),
      [{ key: 'phrases', words: ['rakip marka'] }],
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it('merges multiple lists', () => {
    const findings = runWordFilter(
      'alpha and beta words',
      makePolicy(noBuiltins),
      [
        { key: 'l1', words: ['alpha'] },
        { key: 'l2', words: ['beta'] },
      ],
    );
    expect(findings).toHaveLength(2);
  });
});
