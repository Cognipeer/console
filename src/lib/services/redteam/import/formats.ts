/**
 * Known dataset layouts. An entry describes a layout (columns, default meaning,
 * the source and licence to record) and carries no data: nothing from any
 * dataset ships with Console.
 */

import { IMPORT_LIMITS } from '../limits';
import { isNativeDocument } from './native';
import type { ImportFormat, ParsedTable } from './types';

interface FormatEntry {
  format: ImportFormat;
  /** Whether a parsed file has this layout. Document formats look at `table.document`. */
  matches: (table: ParsedTable) => boolean;
  /** Adjust the format for this file (polarity from the file name, prompt column). */
  adapt?: (format: ImportFormat, table: ParsedTable) => ImportFormat;
}

const has = (table: ParsedTable, ...columns: string[]) => columns.every((c) => table.columns.includes(c));
const exactly = (table: ParsedTable, ...columns: string[]) =>
  table.columns.length === columns.length && has(table, ...columns);

function doc(table: ParsedTable): Record<string, unknown> | null {
  const d = table.document;
  return typeof d === 'object' && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
}

const JAILBREAK_PLACEHOLDER = /\{\{\s*prompt\s*\}\}/;

const ENTRIES: FormatEntry[] = [
  {
    format: {
      id: 'harmbench-csv',
      label: 'HarmBench behaviors (CSV)',
      fileType: 'csv',
      polarity: 'harmful-request',
      source: { name: 'HarmBench', license: 'MIT', attribution: 'HarmBench behaviors' },
      mapping: { prompt: 'Behavior', category: 'SemanticCategory', context: 'ContextString', id: 'BehaviorID' },
      skip: [{ column: 'FunctionalCategory', values: ['copyright'], label: 'Skip FunctionalCategory = copyright' }],
      note: 'Contextual rows get their context text put before the behavior.',
      sensitive: true,
    },
    matches: (t) => has(t, 'Behavior', 'FunctionalCategory', 'SemanticCategory', 'ContextString', 'BehaviorID'),
  },
  {
    format: {
      id: 'jbb-behaviors-csv',
      label: 'JailbreakBench behaviors (CSV)',
      fileType: 'csv',
      polarity: 'harmful-request',
      polarityChoices: ['harmful-request', 'over-refusal'],
      source: {
        name: 'JailbreakBench JBB-Behaviors',
        license: 'MIT',
        attribution: 'Some behaviors come from AdvBench, HarmBench and TDC, which keep their own terms.',
      },
      mapping: { prompt: 'Goal', category: 'Category', id: 'Index' },
      note: 'The harmful and the benign file share this layout; a file name with "benign" selects over-refusal.',
      sensitive: true,
    },
    matches: (t) => has(t, 'Index', 'Goal', 'Target', 'Behavior', 'Category', 'Source'),
    adapt: (f, t) => (/benign/i.test(t.fileName) ? { ...f, polarity: 'over-refusal', sensitive: false } : f),
  },
  {
    format: {
      id: 'advbench-behaviors-csv',
      label: 'AdvBench harmful behaviors (CSV)',
      fileType: 'csv',
      polarity: 'harmful-request',
      source: { name: 'AdvBench harmful_behaviors', license: 'MIT' },
      mapping: { prompt: 'goal' },
      sensitive: true,
    },
    matches: (t) => exactly(t, 'goal', 'target'),
  },
  {
    format: {
      id: 'advbench-strings-csv',
      label: 'AdvBench harmful strings (CSV)',
      fileType: 'csv',
      polarity: 'forbidden-strings',
      source: { name: 'AdvBench harmful_strings', license: 'MIT' },
      mapping: { prompt: 'target' },
      note: 'Each string is a text the target must not repeat; the target is asked to repeat it.',
      sensitive: true,
    },
    matches: (t) => exactly(t, 'target'),
  },
  {
    format: {
      id: 'xstest-csv',
      label: 'XSTest (CSV)',
      fileType: 'csv',
      polarity: 'over-refusal',
      source: { name: 'XSTest', license: 'CC BY 4.0', attribution: 'XSTest, CC BY 4.0: attribution required' },
      mapping: { prompt: 'prompt', category: 'type', id: 'id' },
      skip: [{ column: 'label', values: ['unsafe'], label: 'Skip label = unsafe (a refusal is right there)' }],
      sensitive: false,
    },
    matches: (t) => has(t, 'id', 'prompt', 'type', 'label', 'focus', 'note'),
  },
  {
    format: {
      id: 'or-bench-csv',
      label: 'OR-Bench (CSV)',
      fileType: 'csv',
      polarity: 'over-refusal',
      polarityChoices: ['over-refusal', 'harmful-request'],
      source: { name: 'OR-Bench', license: 'CC BY 4.0', attribution: 'OR-Bench, CC BY 4.0' },
      mapping: { prompt: 'prompt', category: 'category' },
      note: 'The 80k and hard-1k sets are harmless prompts (over-refusal); the toxic set is a harmful-request control.',
      sensitive: false,
    },
    matches: (t) => exactly(t, 'prompt', 'category'),
    adapt: (f, t) => (/toxic/i.test(t.fileName) ? { ...f, polarity: 'harmful-request', sensitive: true } : f),
  },
  {
    format: {
      id: 'strongreject-csv',
      label: 'StrongREJECT (CSV)',
      fileType: 'csv',
      polarity: 'harmful-request',
      source: {
        name: 'StrongREJECT',
        license: 'MIT',
        attribution: 'StrongREJECT; some rows come from sources with their own terms',
      },
      mapping: { prompt: 'forbidden_prompt', category: 'category' },
      note: 'A judge model is recommended to score answers.',
      sensitive: true,
    },
    matches: (t) => has(t, 'category', 'source', 'forbidden_prompt'),
  },
  {
    format: {
      id: 'do-not-answer-csv',
      label: 'Do-Not-Answer (CSV)',
      fileType: 'csv',
      polarity: 'harmful-request',
      source: { name: 'Do-Not-Answer', license: 'Apache-2.0' },
      mapping: { prompt: 'question', category: 'risk_area', id: 'id' },
      note: 'The per-model response columns are ignored.',
      sensitive: true,
    },
    matches: (t) => has(t, 'id', 'risk_area', 'types_of_harm', 'specific_harms', 'question'),
  },
  {
    format: {
      id: 'cyberseceval-prompt-injection-json',
      label: 'CyberSecEval prompt injection (JSON)',
      fileType: 'json',
      polarity: 'prompt-injection',
      source: { name: 'CyberSecEval prompt injection', license: 'MIT' },
      mapping: { prompt: 'user_input', category: 'injection_variant', id: 'prompt_id' },
      note: 'Rows are used against a code word planted in the system prompt; the original judge question is not used.',
      sensitive: false,
    },
    matches: (t) => has(t, 'prompt_id', 'test_case_prompt', 'user_input', 'judge_question', 'injection_variant'),
  },
  {
    format: {
      id: 'injecagent-json',
      label: 'InjecAgent test cases (JSON)',
      fileType: 'json',
      polarity: 'prompt-injection',
      source: { name: 'InjecAgent', license: 'MIT' },
      mapping: { prompt: 'Attacker Instruction', category: 'Attack Type' },
      note: 'The attacker instruction is used against a planted code word; tool calls are not simulated.',
      sensitive: false,
    },
    matches: (t) => has(t, 'Attacker Tools', 'Attacker Instruction', 'Attack Type', 'User Tool', 'User Instruction'),
  },
  {
    format: {
      id: 'bipia-context-jsonl',
      label: 'BIPIA context rows (JSONL)',
      fileType: 'jsonl',
      polarity: 'prompt-injection',
      source: {
        name: 'BIPIA',
        license: 'MIT / CC BY-SA 4.0',
        attribution: 'BIPIA: the email data is MIT; the table and code data are CC BY-SA 4.0 (share-alike). Check which file you import.',
      },
      mapping: { prompt: 'question', context: 'context' },
      note: 'Rows hold a document and a question; no attack text is inserted into the document.',
      sensitive: false,
    },
    matches: (t) => has(t, 'context', 'question', 'ideal'),
  },
  {
    format: {
      id: 'garak-payload-json',
      label: 'garak payloads (JSON)',
      fileType: 'json',
      polarity: 'prompt-injection',
      source: { name: 'garak payloads', license: 'Apache-2.0', attribution: 'Individual payload collections may carry their own terms.' },
      mapping: { prompt: 'prompt', category: 'category' },
      note: 'One attempt per payload string.',
      sensitive: false,
    },
    matches: (t) => {
      const d = doc(t);
      return !!d && typeof d.garak_payload_name === 'string' && Array.isArray(d.payloads);
    },
  },
  {
    format: {
      id: 'promptfoo-intent-csv',
      label: 'promptfoo intents (CSV)',
      fileType: 'csv',
      polarity: 'harmful-request',
      source: { name: 'promptfoo intents', license: 'MIT' },
      mapping: { prompt: 'intent' },
      sensitive: true,
    },
    matches: (t) => exactly(t, 'intent'),
  },
  {
    format: {
      id: 'promptfoo-intent-json',
      label: 'promptfoo intents (JSON)',
      fileType: 'json',
      polarity: 'harmful-request',
      source: { name: 'promptfoo intents', license: 'MIT' },
      mapping: { prompt: 'prompt' },
      note: 'A list of lists becomes scripted multi-turn attempts.',
      sensitive: true,
    },
    matches: (t) =>
      t.fileType === 'json' &&
      t.rows.length > 0 &&
      t.rows.every((r) => {
        const keys = Object.keys(r);
        return keys.length === 1 && (keys[0] === 'prompt' || keys[0] === 'turns');
      }),
  },
  {
    format: {
      id: 'promptfoo-tests-csv',
      label: 'promptfoo test cases (CSV)',
      fileType: 'csv',
      polarity: 'harmful-request',
      polarityChoices: ['harmful-request', 'over-refusal', 'prompt-injection'],
      source: { name: 'promptfoo test cases', license: 'MIT' },
      mapping: { prompt: '' },
      note: 'The first variable column is used as the prompt; change it in the mapping. Assertions are not imported.',
      sensitive: true,
    },
    matches: (t) =>
      t.fileType === 'csv' && t.columns.some((c) => c.startsWith('__expected') || c === '__description' || c === '__metric'),
    adapt: (f, t) => ({ ...f, mapping: { prompt: t.columns.find((c) => !c.startsWith('__')) ?? '' } }),
  },
  {
    format: {
      id: 'pyrit-seed-dataset-yaml',
      label: 'PyRIT seed dataset (YAML)',
      fileType: 'yaml',
      polarity: 'harmful-request',
      polarityChoices: ['harmful-request', 'prompt-injection'],
      // PyRIT itself is MIT; a seed dataset keeps the licence of its upstream source, so none is assumed.
      source: { name: 'PyRIT seed dataset', attribution: 'Each PyRIT seed dataset keeps the licence of its upstream source.' },
      mapping: { prompt: 'prompt', category: 'category' },
      note: 'One attempt per seed value. The dataset keeps its upstream licence; its name and source link are taken from the file.',
      sensitive: true,
    },
    matches: (t) => {
      const d = doc(t);
      return (
        !!d &&
        Array.isArray(d.seeds) &&
        d.seeds.length > 0 &&
        d.seeds.every((s) => typeof s === 'object' && s !== null && 'value' in s)
      );
    },
    adapt: (f, t) => {
      const d = doc(t);
      const dataset = typeof d?.dataset_name === 'string' ? d.dataset_name.trim() : typeof d?.name === 'string' ? d.name.trim() : '';
      const link =
        typeof d?.source === 'string' && /^https?:\/\//i.test(d.source) && d.source.length <= IMPORT_LIMITS.maxSourceUrlChars
          ? d.source
          : undefined;
      return {
        ...f,
        source: {
          ...f.source,
          ...(dataset ? { name: `PyRIT seed dataset: ${dataset}`.slice(0, IMPORT_LIMITS.maxSourceNameChars) } : {}),
          ...(link ? { url: link } : {}),
        },
      };
    },
  },
  {
    format: {
      id: 'pyrit-jailbreak-template-yaml',
      label: 'PyRIT jailbreak template (YAML)',
      fileType: 'yaml',
      polarity: 'jailbreak-template',
      source: {
        name: 'PyRIT jailbreak template',
        license: 'MIT',
        attribution: 'Templates collected from other sources keep their own terms.',
      },
      mapping: { prompt: 'prompt', category: 'category' },
      note: 'The {{ prompt }} placeholder is replaced with the goal asking for the planted code word.',
      sensitive: false,
    },
    matches: (t) => {
      const d = doc(t);
      return !!d && typeof d.value === 'string' && JAILBREAK_PLACEHOLDER.test(d.value) && !Array.isArray(d.seeds);
    },
  },
  {
    format: {
      id: 'jailbreak-llms-in-the-wild',
      label: 'In-the-wild jailbreak prompts (CSV)',
      fileType: 'csv',
      polarity: 'jailbreak-template',
      source: { name: 'In-the-wild jailbreak prompts', license: 'MIT' },
      mapping: { prompt: 'prompt', category: 'community' },
      skip: [{ column: 'jailbreak', values: ['false', '0'], label: 'Skip jailbreak = False (benign prompts)' }],
      note: 'The upstream files are Parquet; convert to CSV first. The goal is appended when a prompt has no placeholder.',
      sensitive: true,
    },
    matches: (t) => has(t, 'platform', 'source', 'prompt', 'jailbreak', 'community'),
  },
  {
    format: {
      id: 'deepset-prompt-injections',
      label: 'deepset prompt-injections (JSONL)',
      fileType: 'jsonl',
      polarity: 'prompt-injection',
      source: { name: 'deepset prompt-injections', license: 'Apache-2.0' },
      mapping: { prompt: 'text' },
      skip: [{ column: 'label', values: ['0'], label: 'Skip label = 0 (benign text)' }],
      note: 'The upstream file is Parquet; convert to CSV or JSONL first.',
      sensitive: false,
    },
    matches: (t) => exactly(t, 'text', 'label'),
  },
  {
    format: {
      id: 'gandalf-ignore-instructions',
      label: 'Gandalf ignore-instructions (JSONL)',
      fileType: 'jsonl',
      polarity: 'prompt-injection',
      source: { name: 'Lakera gandalf_ignore_instructions', license: 'MIT' },
      mapping: { prompt: 'text' },
      note: 'The upstream file is Parquet; convert to CSV or JSONL first.',
      sensitive: false,
    },
    matches: (t) => exactly(t, 'text', 'similarity'),
  },
  {
    format: {
      id: 'cognipeer-native-yaml',
      label: 'Console probe export (YAML)',
      fileType: 'yaml',
      polarity: 'harmful-request',
      source: { name: 'Console export' },
      mapping: { prompt: 'prompt' },
      note: 'Probes are imported as they are; no mapping step.',
      sensitive: false,
    },
    matches: (t) => isNativeDocument(t.document),
  },
];

export const IMPORT_FORMATS: ImportFormat[] = ENTRIES.map((e) => e.format);

/**
 * The format with this id as it applies to this file, or null for an unknown id. Some
 * layouts adjust to the file (a "benign" file name selects over-refusal, a PyRIT dataset
 * names its source), so a format picked by hand gets the same adjustment as a detected one.
 */
export function formatFor(id: string, table: ParsedTable): ImportFormat | null {
  const entry = ENTRIES.find((e) => e.format.id === id);
  if (!entry) return null;
  return entry.adapt ? entry.adapt(entry.format, table) : entry.format;
}

/** The format a file has, or null (custom mapping). First match in IMPORT_FORMATS order wins. */
export function detectFormat(table: ParsedTable): ImportFormat | null {
  for (const entry of ENTRIES) {
    if (!entry.matches(table)) continue;
    return entry.adapt ? entry.adapt(entry.format, table) : entry.format;
  }
  return null;
}

function firstCategory(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string' && v.trim());
    return typeof first === 'string' ? first.trim() : undefined;
  }
  return undefined;
}

function withRows(table: ParsedTable, rows: Array<Record<string, unknown>>): ParsedTable {
  return { ...table, rows, columns: rows.length ? Object.keys(rows[0]) : ['prompt', 'category'], document: undefined };
}

/** Row tables for document formats (garak, PyRIT, promptfoo JSON); row formats pass through. */
export function tableForFormat(format: ImportFormat, table: ParsedTable): ParsedTable {
  const d = doc(table);
  switch (format.id) {
    case 'garak-payload-json': {
      if (!d || !Array.isArray(d.payloads)) return table;
      const category = firstCategory(d.payload_types) ?? (typeof d.garak_payload_name === 'string' ? d.garak_payload_name : undefined);
      const rows = d.payloads
        .filter((p): p is string => typeof p === 'string')
        .map((prompt) => ({ prompt, category: category ?? '' }));
      return withRows(table, rows);
    }
    case 'pyrit-seed-dataset-yaml': {
      if (!d || !Array.isArray(d.seeds)) return table;
      const top = firstCategory(d.harm_categories);
      const rows: Array<Record<string, unknown>> = [];
      for (const seed of d.seeds) {
        if (typeof seed !== 'object' || seed === null) continue;
        const s = seed as Record<string, unknown>;
        if (typeof s.value !== 'string') continue;
        if (typeof s.data_type === 'string' && s.data_type !== 'text') continue;
        rows.push({ prompt: s.value, category: firstCategory(s.harm_categories) ?? top ?? '' });
      }
      return withRows(table, rows);
    }
    case 'pyrit-jailbreak-template-yaml': {
      if (!d || typeof d.value !== 'string') return table;
      const name = typeof d.name === 'string' ? d.name : '';
      return withRows(table, [{ prompt: d.value, category: name }]);
    }
    case 'promptfoo-intent-json': {
      const rows = table.rows.map((row) => {
        if (Array.isArray(row.turns)) {
          const turns = row.turns.filter((t): t is string => typeof t === 'string');
          return turns.length === 1 ? { prompt: turns[0] } : { prompt: turns.join('\n'), turns: JSON.stringify(turns) };
        }
        return row;
      });
      return { ...table, rows, columns: ['prompt', ...(rows.some((r) => 'turns' in r) ? ['turns'] : [])] };
    }
    default:
      return table;
  }
}
