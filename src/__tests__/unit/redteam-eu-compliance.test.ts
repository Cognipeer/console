/**
 * Unit tests — EU AI Act compliance layer.
 *
 * euTaxonomy: every built-in probe category folds onto at least one EU risk
 * family, every OWASP 2025 category is mapped, keys stored before the 2025 list
 * fold exactly like their 2025 key, and the mapping is stable.
 * system-prompt-leakage probe: registered, LLM07-categorised, generates attempts
 * that plant a canary and expect a refusal, and detects only on planted markers.
 * getOverview EU fold + report evidence sampling are covered via the pure helpers
 * they rely on.
 */

import { describe, it, expect } from 'vitest';
import {
  BUILTIN_PROBE_KEYS,
  DEFAULT_PROBE_KEYS,
  PROBE_REGISTRY,
  buildProbes,
} from '@/lib/services/redteam/probes';
import { LEGACY_OWASP_CATEGORY_MAP, OWASP_LLM_CATEGORIES, isOwaspLlmCategory } from '@/lib/services/redteam/owasp';
import {
  mapOwaspToEu,
  EU_RISK_CATEGORIES,
  EU_RISK_CATEGORY_KEYS,
} from '@/lib/services/redteam/euTaxonomy';

describe('EU risk taxonomy', () => {
  it('maps every built-in probe category to at least one EU risk family', () => {
    for (const key of BUILTIN_PROBE_KEYS) {
      const probe = PROBE_REGISTRY[key]();
      const eu = mapOwaspToEu(probe.category);
      expect(eu.length).toBeGreaterThan(0);
      // Each mapped family must have canonical metadata.
      for (const fam of eu) expect(EU_RISK_CATEGORIES[fam]).toBeDefined();
    }
  });

  it('maps prompt injection to both manipulation and cyber-offence', () => {
    expect(mapOwaspToEu('LLM01-prompt-injection')).toEqual(
      expect.arrayContaining(['harmful-manipulation', 'cyber-offence']),
    );
  });

  it('every built-in probe is categorised under a 2025 OWASP key', () => {
    const expected: Record<string, string> = {
      'prompt-injection': 'LLM01-prompt-injection',
      'encoding-injection': 'LLM01-prompt-injection',
      jailbreak: 'LLM01-prompt-injection',
      'sensitive-info-disclosure': 'LLM02-sensitive-information-disclosure',
      'data-extraction': 'LLM02-sensitive-information-disclosure',
      'pii-generation': 'LLM02-sensitive-information-disclosure',
      'insecure-output-handling': 'LLM05-improper-output-handling',
      'excessive-agency': 'LLM06-excessive-agency',
      'system-prompt-leakage': 'LLM07-system-prompt-leakage',
      'overreliance-hallucination': 'LLM09-misinformation',
    };
    expect([...DEFAULT_PROBE_KEYS].sort()).toEqual(Object.keys(expected).sort());
    for (const key of DEFAULT_PROBE_KEYS) {
      const probe = PROBE_REGISTRY[key]();
      expect(isOwaspLlmCategory(probe.category)).toBe(true);
      expect(probe.category).toBe(expected[key]);
    }
    // The library probes are opt-in but carry a 2025 key too.
    for (const key of BUILTIN_PROBE_KEYS) {
      expect(isOwaspLlmCategory(PROBE_REGISTRY[key]().category)).toBe(true);
    }
  });

  it('maps all ten OWASP 2025 categories to a defined EU family', () => {
    expect(OWASP_LLM_CATEGORIES).toHaveLength(10);
    for (const category of OWASP_LLM_CATEGORIES) {
      const eu = mapOwaspToEu(category);
      expect(eu.length).toBeGreaterThan(0);
      for (const fam of eu) expect(EU_RISK_CATEGORIES[fam]).toBeDefined();
    }
    expect(mapOwaspToEu('LLM05-improper-output-handling')).toEqual(['cyber-offence']);
    expect(mapOwaspToEu('LLM10-unbounded-consumption')).toEqual(['availability-robustness']);
    expect(mapOwaspToEu('LLM09-misinformation')).toEqual(['misinformation']);
  });

  it('a key stored before the 2025 list folds like its 2025 key', () => {
    for (const [legacy, current] of Object.entries(LEGACY_OWASP_CATEGORY_MAP)) {
      expect(mapOwaspToEu(legacy)).toEqual(mapOwaspToEu(current));
    }
    expect(mapOwaspToEu('LLM08-excessive-agency')).toEqual(expect.arrayContaining(['loss-of-control']));
    expect(mapOwaspToEu('LLM02-insecure-output-handling')).toEqual(['cyber-offence']);
  });

  it('falls back to availability-robustness for unknown categories', () => {
    expect(mapOwaspToEu('LLM99-made-up')).toEqual(['availability-robustness']);
  });

  it('every EU category carries at least one regulatory article reference', () => {
    for (const key of EU_RISK_CATEGORY_KEYS) {
      expect(EU_RISK_CATEGORIES[key].articleRefs.length).toBeGreaterThan(0);
    }
  });
});

describe('system-prompt-leakage probe (LLM07)', () => {
  it('is registered as a built-in probe', () => {
    expect(BUILTIN_PROBE_KEYS).toContain('system-prompt-leakage');
  });

  it('is categorised under LLM07 and folds to sensitive-data-disclosure', () => {
    const probe = PROBE_REGISTRY['system-prompt-leakage']();
    expect(probe.category).toBe('LLM07-system-prompt-leakage');
    expect(mapOwaspToEu(probe.category)).toContain('sensitive-data-disclosure');
  });

  it('detects on planted markers only, never on paraphrasable rule text', () => {
    const [probe] = buildProbes(['system-prompt-leakage']);
    for (const a of probe.generate()) {
      const patterns = a.expect?.forbiddenPatterns ?? [];
      expect(patterns.length).toBeGreaterThan(0);
      for (const pattern of patterns) {
        // a unique marker: ALL-CAPS tokens with a dash, present in the planted prompt
        expect(pattern).toMatch(/^[A-Z0-9]+(-[A-Z0-9]+)+$/);
        expect(a.system).toContain(pattern);
      }
      expect(a.system).toContain(a.expect!.canary!);
    }
  });

  it('generates attempts that plant a canary and expect a refusal', () => {
    const [probe] = buildProbes(['system-prompt-leakage']);
    const attempts = probe.generate();
    expect(attempts.length).toBeGreaterThan(0);
    for (const a of attempts) {
      expect(a.system).toBeTruthy();
      expect(a.expect?.canary).toBeTruthy();
      expect(a.expect?.refusalExpected).toBe(true);
    }
  });
});
