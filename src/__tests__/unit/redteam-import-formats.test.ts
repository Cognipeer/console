/**
 * Unit tests — probe import format detection, document-to-rows conversion,
 * row mapping and rules, and the Console native export round trip.
 * Fixtures use the real headers/keys of each layout with placeholder text.
 */

import { describe, it, expect } from 'vitest';
import {
  IMPORT_FORMATS,
  detectFormat,
  formatFor,
  tableForFormat,
  defaultRowRules,
  mapRows,
  parseImportFile,
  exportNativeProbes,
  parseNativeProbes,
  isNativeDocument,
  NATIVE_PROBE_KIND,
  ImportError,
} from '@/lib/services/redteam/import';
import type { NativeProbe } from '@/lib/services/redteam/import';
import { CUSTOM_PROBE_LIMITS } from '@/lib/services/redteam/limits';

const csv = (header: string, ...rows: string[]) => `${header}\n${rows.join('\n')}\n`;

function detect(fileName: string, text: string) {
  const table = parseImportFile(fileName, text);
  return { table, format: detectFormat(table) };
}

describe('IMPORT_FORMATS', () => {
  it('has unique ids and leaves out the formats that must not be detected', () => {
    const ids = IMPORT_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const excluded of ['tensortrust-hijacking-jsonl', 'wildjailbreak-tsv', 'sorrybench-jsonl']) {
      expect(ids).not.toContain(excluded);
    }
    expect(ids).toContain('cognipeer-native-yaml');
  });

  it('only carries http(s) source urls', () => {
    for (const f of IMPORT_FORMATS) {
      if (f.source.url) expect(f.source.url).toMatch(/^https?:\/\//);
    }
  });
});

describe('detectFormat on row files', () => {
  const cases: Array<[string, string, string]> = [
    ['harmbench.csv', csv('Behavior,FunctionalCategory,SemanticCategory,Tags,ContextString,BehaviorID', 'placeholder request 1,standard,cat,,,id_1'), 'harmbench-csv'],
    ['harmful-behaviors.csv', csv('Index,Goal,Target,Behavior,Category,Source', '1,placeholder request 1,t,b,c,s'), 'jbb-behaviors-csv'],
    ['advbench.csv', csv('goal,target', 'placeholder request 1,t'), 'advbench-behaviors-csv'],
    ['strings.csv', csv('target', 'placeholder string 1'), 'advbench-strings-csv'],
    ['xstest.csv', csv('id,prompt,type,label,focus,note', 'v1_1,placeholder prompt 1,homonyms,safe,f,'), 'xstest-csv'],
    ['or.csv', csv('prompt,category', 'placeholder prompt 1,cat'), 'or-bench-csv'],
    ['sr.csv', csv('category,source,forbidden_prompt', 'cat,s,placeholder request 1'), 'strongreject-csv'],
    ['dna.csv', csv('id,risk_area,types_of_harm,specific_harms,question,GPT4_response', '1,r,t,s,placeholder question 1,resp'), 'do-not-answer-csv'],
    ['intents.csv', csv('intent', 'placeholder intent 1'), 'promptfoo-intent-csv'],
    ['wild.csv', csv('platform,source,prompt,jailbreak,created_at,date,community,community_id,previous_community_id', 'p,s,placeholder template,True,d,d,c,1,0'), 'jailbreak-llms-in-the-wild'],
    ['tests.csv', csv('question,__expected,__description', 'placeholder 1,contains:x,d'), 'promptfoo-tests-csv'],
    ['deepset.jsonl', '{"text":"placeholder 1","label":1}\n', 'deepset-prompt-injections'],
    ['gandalf.jsonl', '{"text":"placeholder 1","similarity":0.9}\n', 'gandalf-ignore-instructions'],
    ['bipia.jsonl', '{"context":"placeholder doc","question":"placeholder q","ideal":"a"}\n', 'bipia-context-jsonl'],
    [
      'pi.json',
      JSON.stringify([{ prompt_id: 1, test_case_prompt: 's', user_input: 'placeholder 1', judge_question: 'q', injection_variant: 'v', injection_type: 't', risk_category: 'r', speaking_language: 'English' }]),
      'cyberseceval-prompt-injection-json',
    ],
    [
      'inj.json',
      JSON.stringify([{ 'Attacker Tools': ['x'], Modifed: 0, 'Attacker Instruction': 'placeholder 1', 'Expected Achievements': 'e', 'Attack Type': 'Direct Harm', 'User Tool': 'u', 'User Instruction': 'placeholder u' }]),
      'injecagent-json',
    ],
    ['intents.json', '["placeholder intent 1",["turn one","turn two"]]', 'promptfoo-intent-json'],
  ];

  it.each(cases)('detects %s', (fileName, text, id) => {
    expect(detect(fileName, text).format?.id).toBe(id);
  });

  it('returns null for an unknown layout', () => {
    expect(detect('x.csv', csv('foo,bar', '1,2')).format).toBeNull();
  });

  it('does not match a partial header', () => {
    expect(detect('x.csv', csv('goal,target,extra', '1,2,3')).format).toBeNull();
    expect(detect('x.csv', csv('prompt,category,extra', '1,2,3')).format).toBeNull();
  });

  it('picks the JBB polarity from a benign file name', () => {
    const text = csv('Index,Goal,Target,Behavior,Category,Source', '1,placeholder request 1,t,b,c,s');
    expect(detect('harmful-behaviors.csv', text).format?.polarity).toBe('harmful-request');
    const benign = detect('benign-behaviors.csv', text).format;
    expect(benign?.polarity).toBe('over-refusal');
    expect(benign?.polarityChoices).toContain('harmful-request');
  });

  it('picks the OR-Bench polarity from the file name', () => {
    const text = csv('prompt,category', 'placeholder prompt 1,cat');
    expect(detect('or-bench-hard-1k.csv', text).format?.polarity).toBe('over-refusal');
    expect(detect('or-bench-toxic.csv', text).format?.polarity).toBe('harmful-request');
  });

  it('uses the first variable column of a promptfoo test file as the prompt', () => {
    const { format } = detect('tests.csv', csv('question,__expected', 'placeholder,contains:x'));
    expect(format?.mapping.prompt).toBe('question');
  });

  it('formatFor gives a format picked by hand the same adjustment as a detected one', () => {
    const text = csv('Index,Goal,Target,Behavior,Category,Source', '1,placeholder request 1,t,b,c,s');
    const table = parseImportFile('benign-behaviors.csv', text);
    expect(formatFor('jbb-behaviors-csv', table)).toEqual(detectFormat(table));
    expect(formatFor('jbb-behaviors-csv', table)?.polarity).toBe('over-refusal');
    expect(formatFor('advbench-behaviors-csv', table)).toEqual(IMPORT_FORMATS.find((f) => f.id === 'advbench-behaviors-csv'));
    expect(formatFor('no-such-format', table)).toBeNull();
  });
});

describe('format sources', () => {
  const byId = (id: string) => IMPORT_FORMATS.find((f) => f.id === id)!;

  it('records the mixed BIPIA licence and the upstream terms of collected corpora', () => {
    expect(byId('bipia-context-jsonl').source.license).toContain('CC BY-SA 4.0');
    expect(byId('bipia-context-jsonl').source.attribution).toMatch(/table and code data/);
    for (const id of ['jbb-behaviors-csv', 'garak-payload-json', 'pyrit-jailbreak-template-yaml']) {
      expect(byId(id).source.attribution, id).toMatch(/own terms/);
    }
  });

  it('assumes no licence for a PyRIT seed dataset and takes its name and https source from the file', () => {
    expect(byId('pyrit-seed-dataset-yaml').source.license).toBeUndefined();
    const text = 'dataset_name: sample set\nsource: https://example.com/sample\nseeds:\n  - value: placeholder 1\n';
    const { format } = detect('sample.prompt', text);
    expect(format?.source).toMatchObject({ name: 'PyRIT seed dataset: sample set', url: 'https://example.com/sample' });
    const other = detect('sample.prompt', 'name: other\nsource: ftp://example.com/x\nseeds:\n  - value: placeholder 1\n').format;
    expect(other?.source.name).toBe('PyRIT seed dataset: other');
    expect(other?.source.url).toBeUndefined();
  });
});

describe('document formats', () => {
  it('garak: one row per payload, category from payload_types[0]', () => {
    const text = JSON.stringify({ garak_payload_name: 'sample', payload_types: ['Kind A', 'Kind B'], detector_name: 'd', payloads: ['placeholder 1', 'placeholder 2'], lang: 'en' });
    const { table, format } = detect('payload.json', text);
    expect(format?.id).toBe('garak-payload-json');
    const rows = tableForFormat(format!, table);
    expect(rows.rows).toEqual([
      { prompt: 'placeholder 1', category: 'Kind A' },
      { prompt: 'placeholder 2', category: 'Kind A' },
    ]);
    const mapped = mapRows(rows, format!.mapping, defaultRowRules(format));
    expect(mapped.rows.map((r) => r.category)).toEqual(['Kind A', 'Kind A']);
  });

  it('PyRIT seed dataset: one row per seed value, category from harm_categories[0]', () => {
    const text = 'dataset_name: sample\nharm_categories:\n  - top\nseeds:\n  - value: placeholder 1\n    harm_categories: [first, second]\n  - value: placeholder 2\n';
    const { table, format } = detect('sample.prompt', text);
    expect(format?.id).toBe('pyrit-seed-dataset-yaml');
    expect(tableForFormat(format!, table).rows).toEqual([
      { prompt: 'placeholder 1', category: 'first' },
      { prompt: 'placeholder 2', category: 'top' },
    ]);
  });

  it('PyRIT jailbreak template: one row, prompt is the value and category the name', () => {
    const text = 'name: sample template\ndescription: d\nauthors: [x]\nsource: s\nparameters: [prompt]\ndata_type: text\nis_general_technique: true\nvalue: |\n  Placeholder wrapper.\n  {{ prompt }}\n';
    const { table, format } = detect('template.yaml', text);
    expect(format?.id).toBe('pyrit-jailbreak-template-yaml');
    const rows = tableForFormat(format!, table).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('sample template');
    expect(String(rows[0].prompt)).toContain('{{ prompt }}');
  });

  it('promptfoo JSON: nested arrays keep their turns and mapRows honours them', () => {
    const { table, format } = detect('intents.json', '["placeholder intent 1",["turn one","turn two"]]');
    const mapped = mapRows(tableForFormat(format!, table), format!.mapping, defaultRowRules(format));
    expect(mapped.rows).toHaveLength(2);
    expect(mapped.rows[0].turns).toBeUndefined();
    expect(mapped.rows[1].turns).toEqual(['turn one', 'turn two']);
    expect(mapped.rows[1].prompt).toBe('turn one\nturn two');
  });

  it('row formats pass through tableForFormat unchanged', () => {
    const { table, format } = detect('advbench.csv', csv('goal,target', 'placeholder request 1,t'));
    expect(tableForFormat(format!, table)).toBe(table);
  });
});

describe('mapRows', () => {
  const table = (rows: Array<Record<string, unknown>>) => ({
    fileName: 'x.csv',
    fileType: 'csv' as const,
    columns: Object.keys(rows[0] ?? {}),
    rows,
    truncatedRows: 0,
  });

  it('trims, prepends nothing to the stored prompt and keeps the context separate', () => {
    const m = mapRows(table([{ p: '  placeholder request 1  ', c: ' ctx ', k: ' cat ', i: ' id1 ' }]), { prompt: 'p', context: 'c', category: 'k', id: 'i' }, defaultRowRules());
    expect(m.rows).toEqual([{ line: 1, prompt: 'placeholder request 1', context: 'ctx', category: 'cat', id: 'id1' }]);
  });

  it('counts empty rows, duplicates (normalised), rule skips and too-long rows; stats add up', () => {
    const rows = [
      { p: 'placeholder one', t: 'standard' },
      { p: '  Placeholder   ONE ', t: 'standard' },
      { p: '', t: 'standard' },
      { p: 'placeholder two', t: 'Copyright' },
      { p: 'x'.repeat(CUSTOM_PROBE_LIMITS.maxTurnChars + 1), t: 'standard' },
      { p: 'placeholder three', t: 'standard' },
    ];
    const rules = defaultRowRules();
    rules.skip = [{ column: 't', values: ['copyright'], label: 'skip copyright' }];
    const m = mapRows(table(rows), { prompt: 'p' }, rules);
    expect(m.stats).toEqual({ total: 6, usable: 2, skipped: 4, duplicates: 1, empty: 1, skippedByRule: 1, tooLong: 1 });
    expect(m.rows.map((r) => r.line)).toEqual([1, 6]);
    expect(m.stats.usable + m.stats.skipped).toBe(m.stats.total);
  });

  it('counts the context toward the length limit', () => {
    const m = mapRows(table([{ p: 'short', c: 'y'.repeat(CUSTOM_PROBE_LIMITS.maxTurnChars) }]), { prompt: 'p', context: 'c' }, defaultRowRules());
    expect(m.stats.tooLong).toBe(1);
  });

  it('keeps duplicates when the switch is off', () => {
    const rules = { ...defaultRowRules(), dropDuplicates: false };
    const m = mapRows(table([{ p: 'same' }, { p: 'same' }]), { prompt: 'p' }, rules);
    expect(m.rows).toHaveLength(2);
    expect(m.stats.duplicates).toBe(0);
  });

  it('applies a format default skip rule (XSTest label = unsafe)', () => {
    const { table: t, format } = detect('xstest.csv', csv('id,prompt,type,label,focus,note', 'v1_1,placeholder prompt 1,homonyms,safe,f,', 'v1_2,placeholder prompt 2,contrast,unsafe,f,'));
    const m = mapRows(t, format!.mapping, defaultRowRules(format));
    expect(m.rows.map((r) => r.id)).toEqual(['v1_1']);
    expect(m.stats.skippedByRule).toBe(1);
  });

  it('skips benign deepset rows by default', () => {
    const { table: t, format } = detect('d.jsonl', '{"text":"placeholder 1","label":1}\n{"text":"placeholder 2","label":0}\n');
    const m = mapRows(t, format!.mapping, defaultRowRules(format));
    expect(m.rows).toHaveLength(1);
    expect(m.stats.skippedByRule).toBe(1);
  });

  it('skips HarmBench copyright rows by default', () => {
    const { table: t, format } = detect('h.csv', csv('Behavior,FunctionalCategory,SemanticCategory,Tags,ContextString,BehaviorID', 'placeholder request 1,standard,cat,,,a', 'placeholder request 2,copyright,cat,,,b'));
    const m = mapRows(t, format!.mapping, defaultRowRules(format));
    expect(m.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('ignores an unrelated turns column when the prompt is mapped to another column', () => {
    const rows = [{ p: 'placeholder request 1', turns: '["other one","other two"]' }];
    const m = mapRows(table(rows), { prompt: 'p' }, defaultRowRules());
    expect(m.rows[0].prompt).toBe('placeholder request 1');
    expect(m.rows[0].turns).toBeUndefined();
    const asTurns = mapRows(table(rows), { prompt: 'turns' }, defaultRowRules());
    expect(asTurns.rows[0].turns).toEqual(['other one', 'other two']);
  });
});

describe('native export', () => {
  const probe: NativeProbe = {
    name: 'Sample probe',
    description: 'A sample.',
    family: 'imported',
    category: 'LLM01-prompt-injection',
    severity: 'high',
    polarity: 'attack',
    attempts: [
      {
        id: 'a1',
        turns: ['placeholder turn 1', 'placeholder turn 2'],
        system: 'The code is {{canary}}.',
        canary: 'RT-ABCD-1234',
        forbiddenPatterns: ['RT-ABCD-1234', 'multi\nline'],
        refusalExpected: true,
        history: [
          { role: 'user', content: 'placeholder' },
          { role: 'assistant', content: 'placeholder reply' },
        ],
      },
    ],
    detectors: { refusal: true, pattern: true, named: ['non-refusal'], judges: [{ lens: 'l', rubric: 'r', threshold: 0.7 }] },
    source: { name: 'Sample source', license: 'MIT', url: 'https://example.com/x', importedAt: new Date('2026-01-01') },
  };

  it('round-trips and is stable', () => {
    const text = exportNativeProbes([probe]);
    expect(text).toContain(NATIVE_PROBE_KIND);
    expect(text).not.toContain('importedAt');
    expect(exportNativeProbes([probe])).toBe(text);
    const [draft] = parseNativeProbes(text);
    expect(draft.name).toBe(probe.name);
    expect(draft.family).toBe('imported');
    expect(draft.polarity).toBe('attack');
    expect(draft.attempts).toEqual(probe.attempts);
    expect(draft.detectors).toEqual(probe.detectors);
    expect(draft.source).toEqual({ name: 'Sample source', license: 'MIT', url: 'https://example.com/x' });
  });

  it('accepts JSON, defaults the source and family, keeps over-refusal polarity', () => {
    const json = JSON.stringify({
      kind: NATIVE_PROBE_KIND,
      probes: [{ name: 'p', category: 'LLM09-misinformation', severity: 'low', polarity: 'over-refusal', attempts: [{ id: 'a', turns: ['t'] }], detectors: { refusal: true } }],
    });
    const [draft] = parseNativeProbes(json);
    expect(draft.source.name).toBe('Console export');
    expect(draft.family).toBe('imported');
    expect(draft.polarity).toBe('over-refusal');
    expect(draft.description).toBe('');
  });

  it('never takes lineage from the file', () => {
    const text = exportNativeProbes([{ ...probe, clonedFrom: { probeKey: 'x', version: 1 } }]);
    expect(text).toContain('clonedFrom');
    expect(parseNativeProbes(text)[0]).not.toHaveProperty('clonedFrom');
  });

  it('recognises a native document', () => {
    expect(isNativeDocument({ kind: NATIVE_PROBE_KIND, probes: [] })).toBe(true);
    expect(isNativeDocument({ kind: 'other', probes: [] })).toBe(false);
    expect(isNativeDocument(null)).toBe(false);
    const { format } = detect('export.yaml', exportNativeProbes([probe]));
    expect(format?.id).toBe('cognipeer-native-yaml');
  });

  it('rejects malformed files with a message naming the probe', () => {
    const wrap = (p: unknown) => JSON.stringify({ kind: NATIVE_PROBE_KIND, probes: [p] });
    const base = { name: 'bad', category: 'LLM01-prompt-injection', severity: 'high', attempts: [{ id: 'a', turns: ['t'] }], detectors: { refusal: true } };
    expect(() => parseNativeProbes('not: a probe file')).toThrow(ImportError);
    expect(() => parseNativeProbes(JSON.stringify({ kind: NATIVE_PROBE_KIND, probes: [] }))).toThrow(/no probes/);
    expect(() => parseNativeProbes(wrap({ ...base, severity: 'extreme' }))).toThrow(/Probe 1 "bad".*severity/);
    expect(() => parseNativeProbes(wrap({ ...base, category: 'nope' }))).toThrow(/category/);
    expect(() => parseNativeProbes(wrap({ ...base, attempts: [{ id: 'a', turns: [] }] }))).toThrow(/turns/);
    expect(() => parseNativeProbes(wrap({ ...base, attempts: [{ id: 'a', turns: ['t'], history: [{ role: 'system', content: 'x' }] }] }))).toThrow(/history/);
    expect(() => parseNativeProbes(wrap({ ...base, name: '' }))).toThrow(/name/);
  });
});
