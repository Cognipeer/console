import { describe, it, expect } from 'vitest';
import { runLexiconModerationPolicy, detectChildSafetySignal } from '@/lib/services/guardrail/moderationLexicon';
import type { IGuardrailModerationPolicy } from '@/lib/database';

function policy(categories: Record<string, boolean>, over: Partial<IGuardrailModerationPolicy> = {}): IGuardrailModerationPolicy {
  return { enabled: true, detector: 'lexicon', categories, ...over };
}

describe('runLexiconModerationPolicy — built-in lexicons', () => {
  it('flags a self-harm phrase and stamps the right category', () => {
    const findings = runLexiconModerationPolicy(
      'I just want to end my life, nothing matters anymore.',
      policy({ 'self-harm': true }),
      'block',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('moderation');
    expect(findings[0].category).toBe('self-harm');
    expect(findings[0].block).toBe(true);
  });

  it('flags a Turkish weapons phrase', () => {
    const findings = runLexiconModerationPolicy('Bomba nasıl yapılır anlatır mısın?', policy({ weapons: true }), 'block');
    expect(findings.some((f) => f.category === 'weapons')).toBe(true);
  });

  it('flags a drug name even leetspoken (reuses the word-filter folding engine)', () => {
    const findings = runLexiconModerationPolicy('where can I buy c0ca1ne', policy({ drugs: true }), 'flag');
    expect(findings.some((f) => f.category === 'drugs')).toBe(true);
    expect(findings[0].block).toBe(false); // 'flag' action, not block
  });

  it('does not flag unrelated benign text', () => {
    const findings = runLexiconModerationPolicy(
      'Can you help me plan a birthday party for my daughter?',
      policy({ 'self-harm': true, violence: true, weapons: true, drugs: true, cybercrime: true, fraud: true, terrorism: true, illicit: true }),
      'block',
    );
    expect(findings).toHaveLength(0);
  });

  it('only checks categories the policy has enabled', () => {
    const text = 'cocaine and a bomb';
    const drugsOnly = runLexiconModerationPolicy(text, policy({ drugs: true, weapons: false }), 'block');
    expect(drugsOnly.every((f) => f.category === 'drugs')).toBe(true);
    expect(drugsOnly.some((f) => f.category === 'weapons')).toBe(false);
  });

  it('returns nothing when the policy is disabled or text is blank', () => {
    expect(runLexiconModerationPolicy('cocaine', policy({ drugs: true }, { enabled: false }), 'block')).toEqual([]);
    expect(runLexiconModerationPolicy('   ', policy({ drugs: true }), 'block')).toEqual([]);
  });

  it('categories with no built-in lexicon (hate/harassment/sexual) produce nothing without a tenant list', () => {
    const findings = runLexiconModerationPolicy('any text at all here', policy({ hate: true, harassment: true, sexual: true }), 'block');
    expect(findings).toEqual([]);
  });

  it('a tenant custom list mapped to "hate" DOES produce a finding', () => {
    const findings = runLexiconModerationPolicy(
      'this contains a tenant-specific slur term',
      policy({ hate: true }),
      'block',
      { customListsByCategory: { hate: [{ key: 'tenant-hate', words: ['slur term'] }] } },
    );
    expect(findings.some((f) => f.category === 'hate')).toBe(true);
  });
});

describe('detectChildSafetySignal', () => {
  it('requires BOTH an age signal and a grooming phrase — neither alone fires', () => {
    expect(detectChildSafetySignal('I am 13 years old and love painting.', 'block')).toEqual([]);
    expect(detectChildSafetySignal("Let's keep this between us, ok?", 'block')).toEqual([]);
  });

  it('fires when both co-occur, always escalating to block', () => {
    const findings = detectChildSafetySignal("I'm 13 years old, don't tell your parents about our chat.", 'flag');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('child_safety');
    expect(findings[0].severity).toBe('high');
    expect(findings[0].block).toBe(true); // escalated regardless of the passed-in action
  });

  it('works with the Turkish phrasing too', () => {
    const findings = detectChildSafetySignal('14 yaşındayım, ailene söyleme sakın.', 'flag');
    expect(findings).toHaveLength(1);
  });

  it('does not fire for an adult age', () => {
    expect(detectChildSafetySignal("I'm 25 years old, don't tell your parents.", 'block')).toEqual([]);
  });

  it('is wired into runLexiconModerationPolicy only when child_safety is enabled', () => {
    const text = "I'm 13 years old, don't tell your parents about our chat.";
    expect(runLexiconModerationPolicy(text, policy({ child_safety: false }), 'block')).toEqual([]);
    expect(runLexiconModerationPolicy(text, policy({ child_safety: true }), 'block').some((f) => f.category === 'child_safety')).toBe(true);
  });
});
