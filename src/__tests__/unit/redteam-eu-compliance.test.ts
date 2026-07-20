/**
 * Unit tests — EU AI Act compliance layer.
 *
 * euTaxonomy: every built-in probe category folds onto at least one EU risk
 * family, and the mapping is stable.
 * system-prompt-leakage probe: registered, LLM07-categorised, generates attempts
 * that plant a canary and expect a refusal.
 * getOverview EU fold + report evidence sampling are covered via the pure helpers
 * they rely on.
 */

import { describe, it, expect } from 'vitest';
import {
  BUILTIN_PROBE_KEYS,
  PROBE_REGISTRY,
  buildProbes,
} from '@/lib/services/redteam/probes';
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
