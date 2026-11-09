/**
 * Unit tests — probe import drafts: grouping, sampling, per-polarity attempt
 * shapes, and proof that every draft passes the server's custom-probe validation.
 * Text is placeholder only.
 */

import { describe, it, expect } from 'vitest';
import {
  buildImportProbes,
  sampleRows,
  defaultOwaspFor,
  defaultSeverityFor,
  DEFAULT_JAILBREAK_GOAL,
  DEFAULT_PLANTED_SYSTEM,
  HARMFUL_COMPLIANCE_RUBRIC,
} from '@/lib/services/redteam/import';
import type { ImportConfig, ImportPolarity, ImportRow, ImportProbeDraft } from '@/lib/services/redteam/import';
import { validateCustomProbe, validateCustomProbeDefinition } from '@/lib/services/redteam/probes/customProbe';
import { patternListError } from '@/lib/services/redteam/detectors/safePattern';
import { ATTEMPT_ID_PATTERN, CUSTOM_PROBE_LIMITS, IMPORT_LIMITS } from '@/lib/services/redteam/limits';
import type { IRedTeamCustomProbe } from '@/lib/database';

function rows(n: number, category?: (i: number) => string | undefined, extra?: (i: number) => Partial<ImportRow>): ImportRow[] {
  return Array.from({ length: n }, (_, i) => ({
    line: i + 1,
    prompt: `placeholder request ${i + 1}`,
    category: category?.(i),
    ...extra?.(i),
  }));
}

function config(polarity: ImportPolarity, over: Partial<ImportConfig> = {}): ImportConfig {
  return {
    polarity,
    grouping: 'per-category',
    attemptsPerProbe: 50,
    namePrefix: 'Sample',
    owaspByCategory: {},
    severityByCategory: {},
    useJudge: false,
    source: { format: 'sample-format', name: 'Sample source', license: 'MIT', fileName: 'sample.csv' },
    seed: 42,
    ...over,
  };
}

const mapped = (r: ImportRow[]) => ({ rows: r, stats: { total: r.length, usable: r.length, skipped: 0, duplicates: 0, empty: 0, skippedByRule: 0, tooLong: 0 } });

/** The server's save-time checks, applied to a draft. */
function expectValid(draft: ImportProbeDraft): void {
  // The polarity goes in too, so the over-refusal rules (refusal on, no pattern, no named detectors) are checked.
  const def = { attempts: draft.attempts, detectors: draft.detectors, category: draft.category, polarity: draft.polarity } as Pick<IRedTeamCustomProbe, 'attempts' | 'detectors' | 'category' | 'polarity'>;
  expect(() => validateCustomProbe(def)).not.toThrow();
  expect(() => validateCustomProbeDefinition(def)).not.toThrow();
  const ids = new Set<string>();
  for (const a of draft.attempts) {
    expect(patternListError(a.forbiddenPatterns ?? [])).toBeNull();
    expect(ATTEMPT_ID_PATTERN.test(a.id)).toBe(true);
    expect(ids.has(a.id)).toBe(false);
    ids.add(a.id);
    expect(a.turns.length).toBeLessThanOrEqual(CUSTOM_PROBE_LIMITS.maxTurnsPerAttempt);
    for (const t of a.turns) expect(t.length).toBeLessThanOrEqual(CUSTOM_PROBE_LIMITS.maxTurnChars);
  }
  expect(draft.attempts.length).toBeLessThanOrEqual(CUSTOM_PROBE_LIMITS.maxAttempts);
}

describe('sampleRows', () => {
  const list = Array.from({ length: 100 }, (_, i) => i);

  it('is deterministic for a seed and differs across seeds', () => {
    expect(sampleRows(list, 10, 7)).toEqual(sampleRows(list, 10, 7));
    expect(sampleRows(list, 10, 7)).not.toEqual(sampleRows(list, 10, 8));
  });

  it('returns distinct items in their original order', () => {
    const picked = sampleRows(list, 25, 1);
    expect(picked).toHaveLength(25);
    expect(new Set(picked).size).toBe(25);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
  });

  it('returns everything when n is large enough and nothing when n is 0', () => {
    expect(sampleRows(list, 100, 1)).toEqual(list);
    expect(sampleRows(list, 500, 1)).toEqual(list);
    expect(sampleRows(list, 0, 1)).toEqual([]);
  });
});

describe('defaults', () => {
  it('maps polarity and category names to OWASP key and severity', () => {
    expect(defaultOwaspFor('harmful-request')).toBe('LLM01-prompt-injection');
    expect(defaultSeverityFor('harmful-request')).toBe('high');
    expect(defaultOwaspFor('over-refusal')).toBe('LLM09-misinformation');
    expect(defaultSeverityFor('over-refusal')).toBe('low');
    expect(defaultOwaspFor('prompt-injection')).toBe('LLM01-prompt-injection');
    expect(defaultSeverityFor('jailbreak-template')).toBe('high');
    expect(defaultSeverityFor('forbidden-strings')).toBe('medium');
    expect(defaultOwaspFor('harmful-request', 'Misinformation and Disinformation')).toBe('LLM09-misinformation');
    expect(defaultSeverityFor('harmful-request', 'disinformation')).toBe('medium');
    expect(defaultOwaspFor('harmful-request', 'Privacy')).toBe('LLM02-sensitive-information-disclosure');
    expect(defaultSeverityFor('harmful-request', 'personal data')).toBe('high');
  });

  it('constants fit the limits', () => {
    expect(DEFAULT_PLANTED_SYSTEM).toContain('{{canary}}');
    expect(DEFAULT_JAILBREAK_GOAL.length).toBeGreaterThan(0);
    expect(HARMFUL_COMPLIANCE_RUBRIC.length).toBeLessThanOrEqual(CUSTOM_PROBE_LIMITS.maxRubricChars);
  });
});

describe('buildImportProbes grouping', () => {
  it('makes one probe per category, named with the prefix', () => {
    const r = rows(6, (i) => (i % 2 ? 'Alpha' : 'Beta'));
    const plan = buildImportProbes(mapped(r), config('harmful-request'));
    expect(plan.probes.map((p) => p.name).sort()).toEqual(['Sample · Alpha', 'Sample · Beta']);
    expect(plan.probes.every((p) => p.attempts.length === 3)).toBe(true);
    for (const p of plan.probes) {
      expect(p.family).toBe('imported');
      expect(p.source).toEqual({ format: 'sample-format', name: 'Sample source', license: 'MIT', fileName: 'sample.csv' });
      expect(p.description).toContain('Sample source');
      expectValid(p);
    }
  });

  it('makes one probe for everything when grouping is single or no row has a category', () => {
    const single = buildImportProbes(mapped(rows(4, () => 'A')), config('harmful-request', { grouping: 'single' }));
    expect(single.probes).toHaveLength(1);
    expect(single.probes[0].name).toBe('Sample');
    const none = buildImportProbes(mapped(rows(4)), config('harmful-request'));
    expect(none.probes.map((p) => p.name)).toEqual(['Sample']);
  });

  it('names uncategorised rows when others have a category', () => {
    const plan = buildImportProbes(mapped(rows(4, (i) => (i < 2 ? 'A' : undefined))), config('harmful-request'));
    expect(plan.probes.map((p) => p.name).sort()).toEqual(['Sample · A', 'Sample · uncategorized']);
  });

  it('caps groups at the import limit, largest first, and lists the rest', () => {
    const total = IMPORT_LIMITS.maxProbesPerImport + 3;
    // category c0 has 1 row, c1 has 2 rows, ... so the smallest ones are dropped.
    const r: ImportRow[] = [];
    let line = 1;
    for (let c = 0; c < total; c++) {
      for (let k = 0; k <= c; k++) r.push({ line: line++, prompt: `placeholder ${c}-${k}`, category: `c${c}` });
    }
    const plan = buildImportProbes(mapped(r), config('harmful-request'));
    expect(plan.probes).toHaveLength(IMPORT_LIMITS.maxProbesPerImport);
    expect(plan.droppedGroups.sort()).toEqual(['c0', 'c1', 'c2']);
    expect(plan.warnings.join(' ')).toMatch(/left out/);
  });

  it('samples at attemptsPerProbe with a stable choice and counts what was left out', () => {
    const r = rows(30, () => 'A');
    const a = buildImportProbes(mapped(r), config('harmful-request', { attemptsPerProbe: 10 }));
    const b = buildImportProbes(mapped(r), config('harmful-request', { attemptsPerProbe: 10 }));
    expect(a.probes[0].attempts).toHaveLength(10);
    expect(a.sampledOut).toBe(20);
    expect(a.probes[0].attempts.map((x) => x.id)).toEqual(b.probes[0].attempts.map((x) => x.id));
    expect(a.probes[0].description).toContain('sampled from 30');
    const lines = a.probes[0].attempts.map((x) => Number(x.id.replace('row-', '')));
    expect([...lines].sort((x, y) => x - y)).toEqual(lines);
  });

  it('clamps attemptsPerProbe to the maximum', () => {
    const plan = buildImportProbes(mapped(rows(80)), config('harmful-request', { attemptsPerProbe: 500 }));
    expect(plan.probes[0].attempts).toHaveLength(IMPORT_LIMITS.maxAttemptsPerProbe);
    expect(plan.sampledOut).toBe(30);
  });

  it('uses config OWASP and severity per category, else the defaults', () => {
    const plan = buildImportProbes(
      mapped(rows(4, (i) => (i < 2 ? 'Privacy' : 'constructor'))),
      config('harmful-request', {
        owaspByCategory: { Privacy: 'LLM07-system-prompt-leakage' },
        severityByCategory: { Privacy: 'critical' },
      }),
    );
    const byName = Object.fromEntries(plan.probes.map((p) => [p.name, p]));
    expect(byName['Sample · Privacy'].category).toBe('LLM07-system-prompt-leakage');
    expect(byName['Sample · Privacy'].severity).toBe('critical');
    expect(byName['Sample · constructor'].category).toBe('LLM01-prompt-injection');
    expect(byName['Sample · constructor'].severity).toBe('high');
  });
});

describe('buildImportProbes attempt ids', () => {
  it('uses the row id when it fits and is unique, else row-<line>', () => {
    const r: ImportRow[] = [
      { line: 1, prompt: 'p1', id: 'abc_1' },
      { line: 2, prompt: 'p2', id: 'abc_1' },
      { line: 3, prompt: 'p3', id: 'has space' },
      { line: 4, prompt: 'p4', id: 'x'.repeat(65) },
      { line: 5, prompt: 'p5' },
    ];
    const plan = buildImportProbes(mapped(r), config('harmful-request', { grouping: 'single' }));
    expect(plan.probes[0].attempts.map((a) => a.id)).toEqual(['abc_1', 'row-2', 'row-3', 'row-4', 'row-5']);
    expectValid(plan.probes[0]);
  });

  it('never repeats an id when a row id looks like a fallback id', () => {
    const r: ImportRow[] = [
      { line: 1, prompt: 'p1', id: 'row-2' },
      { line: 2, prompt: 'p2' },
    ];
    const plan = buildImportProbes(mapped(r), config('harmful-request', { grouping: 'single' }));
    const ids = plan.probes[0].attempts.map((a) => a.id);
    expect(new Set(ids).size).toBe(2);
    expectValid(plan.probes[0]);
  });
});

describe('buildImportProbes per polarity', () => {
  it('harmful-request: refusal expected, non-refusal named detector, optional judge, context before prompt', () => {
    const r = rows(3, undefined, (i) => (i === 0 ? { context: 'placeholder context' } : {}));
    const plan = buildImportProbes(mapped(r), config('harmful-request'));
    const p = plan.probes[0];
    expect(p.polarity).toBe('attack');
    expect(p.detectors).toEqual({ refusal: true, pattern: false, named: ['non-refusal'], judges: [] });
    expect(p.attempts[0].turns).toEqual(['placeholder context\n\nplaceholder request 1']);
    expect(p.attempts[1].turns).toEqual(['placeholder request 2']);
    expect(p.attempts.every((a) => a.refusalExpected === true && !a.system && !a.canary)).toBe(true);
    expect(p.category).toBe('LLM01-prompt-injection');
    expect(p.severity).toBe('high');
    expectValid(p);

    const judged = buildImportProbes(mapped(r), config('harmful-request', { useJudge: true })).probes[0];
    expect(judged.detectors.judges).toEqual([{ lens: 'harmful-compliance', rubric: HARMFUL_COMPLIANCE_RUBRIC }]);
    expectValid(judged);
  });

  it('harmful-request: scripted turns are kept', () => {
    const r: ImportRow[] = [{ line: 1, prompt: 'one\ntwo', turns: ['placeholder one', 'placeholder two'], context: 'ctx' }];
    const p = buildImportProbes(mapped(r), config('harmful-request')).probes[0];
    expect(p.attempts[0].turns).toEqual(['ctx\n\nplaceholder one', 'placeholder two']);
    expectValid(p);
  });

  it('over-refusal: attack polarity off, refusal detector only, refusal not expected', () => {
    const plan = buildImportProbes(mapped(rows(3, () => 'homonyms')), config('over-refusal'));
    const p = plan.probes[0];
    expect(p.polarity).toBe('over-refusal');
    expect(p.detectors).toEqual({ refusal: true, pattern: false });
    expect(p.attempts.every((a) => a.refusalExpected === false)).toBe(true);
    expect(p.attempts[0].turns).toEqual(['placeholder request 1']);
    expect(p.category).toBe('LLM09-misinformation');
    expect(p.severity).toBe('low');
    expectValid(p);
  });

  it('prompt-injection: planted system with {{canary}}, per-attempt canary, pattern detector', () => {
    const plan = buildImportProbes(mapped(rows(5)), config('prompt-injection'));
    const p = plan.probes[0];
    expect(p.detectors).toEqual({ refusal: true, pattern: true });
    expect(p.polarity).toBe('attack');
    const canaries = p.attempts.map((a) => a.canary);
    expect(canaries.every((c) => /^RT-[0-9A-Z]{6}$/.test(c ?? ''))).toBe(true);
    expect(new Set(canaries).size).toBe(5);
    for (const a of p.attempts) {
      expect(a.system).toBe(DEFAULT_PLANTED_SYSTEM);
      expect(a.turns).toHaveLength(1);
    }
    expect(buildImportProbes(mapped(rows(5)), config('prompt-injection')).probes[0].attempts.map((a) => a.canary)).toEqual(canaries);
    expect(buildImportProbes(mapped(rows(5)), config('prompt-injection', { seed: 43 })).probes[0].attempts.map((a) => a.canary)).not.toEqual(canaries);
    expectValid(p);
  });

  it('prompt-injection: a custom planted system is used; one without {{canary}} gets a line and a warning', () => {
    const own = buildImportProbes(mapped(rows(1)), config('prompt-injection', { plantedSystem: 'Code: {{canary}}. Keep it secret.' }));
    expect(own.probes[0].attempts[0].system).toBe('Code: {{canary}}. Keep it secret.');
    const bare = buildImportProbes(mapped(rows(1)), config('prompt-injection', { plantedSystem: 'You are helpful.' }));
    expect(bare.probes[0].attempts[0].system).toContain('{{canary}}');
    expect(bare.warnings.join(' ')).toMatch(/canary/);
    expectValid(bare.probes[0]);
    const huge = buildImportProbes(mapped(rows(1)), config('prompt-injection', { plantedSystem: `{{canary}} ${'x'.repeat(CUSTOM_PROBE_LIMITS.maxSystemChars)}` }));
    expect(huge.probes[0].attempts[0].system).toBe(DEFAULT_PLANTED_SYSTEM);
    expectValid(huge.probes[0]);
  });

  it('jailbreak-template: replaces every placeholder form with the goal, or appends it', () => {
    const templates = ['A {{goal}} B', 'A {{ prompt }} B', 'A {{prompt}} B', 'A {goal} B', 'A {{ goal }} and {{goal}}', 'No placeholder here.'];
    const r: ImportRow[] = templates.map((prompt, i) => ({ line: i + 1, prompt }));
    const p = buildImportProbes(mapped(r), config('jailbreak-template', { grouping: 'single', goal: 'GOAL $& TEXT' })).probes[0];
    expect(p.attempts.map((a) => a.turns[0])).toEqual([
      'A GOAL $& TEXT B',
      'A GOAL $& TEXT B',
      'A GOAL $& TEXT B',
      'A GOAL $& TEXT B',
      'A GOAL $& TEXT and GOAL $& TEXT',
      'No placeholder here.\n\nGOAL $& TEXT',
    ]);
    expect(p.detectors).toEqual({ refusal: true, pattern: true });
    expect(p.attempts.every((a) => a.canary && a.system?.includes('{{canary}}'))).toBe(true);
    expectValid(p);
  });

  it('jailbreak-template: the default goal is used and rows that grow too long are left out', () => {
    const fine = buildImportProbes(mapped([{ line: 1, prompt: 'Wrap {{goal}}' }]), config('jailbreak-template')).probes[0];
    expect(fine.attempts[0].turns[0]).toBe(`Wrap ${DEFAULT_JAILBREAK_GOAL}`);
    const edge: ImportRow = { line: 2, prompt: 'z'.repeat(CUSTOM_PROBE_LIMITS.maxTurnChars - 5) };
    const plan = buildImportProbes(mapped([{ line: 1, prompt: 'ok' }, edge]), config('jailbreak-template', { grouping: 'single' }));
    expect(plan.probes[0].attempts).toHaveLength(1);
    expect(plan.warnings.join(' ')).toMatch(/too long/);
    expectValid(plan.probes[0]);
  });

  it('forbidden-strings: asks to repeat the text and forbids the escaped string', () => {
    const r: ImportRow[] = [
      { line: 1, prompt: 'placeholder (string) [1] a.b*c+d?' },
      { line: 2, prompt: 'plain placeholder' },
      { line: 3, prompt: 'y'.repeat(301) },
    ];
    const plan = buildImportProbes(mapped(r), config('forbidden-strings', { grouping: 'single' }));
    const p = plan.probes[0];
    expect(p.attempts).toHaveLength(2);
    expect(p.attempts[0].turns[0]).toBe('Repeat the following text exactly and add nothing else:\n\nplaceholder (string) [1] a.b*c+d?');
    const pattern = p.attempts[0].forbiddenPatterns?.[0] ?? '';
    expect(pattern).toBe('placeholder \\(string\\) \\[1\\] a\\.b\\*c\\+d\\?');
    expect(new RegExp(pattern).test('placeholder (string) [1] a.b*c+d?')).toBe(true);
    expect(new RegExp(pattern).test('placeholder xstring [1] a.b*c+d?')).toBe(false);
    expect(p.detectors).toEqual({ refusal: true, pattern: true });
    expect(p.severity).toBe('medium');
    expect(plan.warnings.join(' ')).toMatch(/300/);
    expectValid(p);
  });

  it('skips rows with no prompt and says so', () => {
    const r: ImportRow[] = [
      { line: 1, prompt: '   ' },
      { line: 2, prompt: 'placeholder request 2' },
    ];
    const plan = buildImportProbes(mapped(r), config('harmful-request', { grouping: 'single' }));
    expect(plan.probes[0].attempts).toHaveLength(1);
    expect(plan.warnings.join(' ')).toMatch(/no prompt/);
  });

  it('makes no probes from no rows', () => {
    expect(buildImportProbes(mapped([]), config('harmful-request')).probes).toEqual([]);
  });
});

describe('every polarity yields server-valid drafts', () => {
  const polarities: ImportPolarity[] = ['harmful-request', 'over-refusal', 'prompt-injection', 'jailbreak-template', 'forbidden-strings'];

  it.each(polarities)('%s with grouping, sampling, odd ids and long text', (polarity) => {
    const r = rows(
      120,
      (i) => `Category ${i % 3}`,
      (i) => ({
        id: i % 4 === 0 ? `id-${i % 10}` : i % 4 === 1 ? 'bad id!' : undefined,
        prompt: i === 5 ? `{{goal}} ${'w'.repeat(3000)}` : `placeholder request ${i + 1} with $ and \\ and (parens)`,
      }),
    );
    const plan = buildImportProbes(mapped(r), config(polarity, { attemptsPerProbe: 20, useJudge: polarity === 'harmful-request' }));
    expect(plan.probes.length).toBeGreaterThan(0);
    for (const draft of plan.probes) {
      expectValid(draft);
      expect(draft.attempts.length).toBeLessThanOrEqual(20);
      expect(draft.source.name).toBe('Sample source');
    }
  });
});
