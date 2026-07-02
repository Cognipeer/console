/**
 * Dataset import helpers — turn Excel / CSV / JSON into evaluation dataset
 * items. Excel and CSV are both parsed with `xlsx` (CSV via `type: 'string'`),
 * so a single typed dependency covers both; JSON is parsed directly.
 *
 * Tabular rows are mapped by (case-insensitive) header to a single-turn item:
 *   input/question/prompt  → the user message
 *   system                 → an optional leading system message
 *   reference/expected/...  → expected.reference (gold answer for judge/semantic)
 *   contains/must_contain  → expected.mustContain (split on | or ;)
 *   equals                 → expected.equals
 *   tags                   → comma-separated tags
 *   id                     → item id (auto if absent)
 */

import * as XLSX from 'xlsx';
import type { EvalDatasetItemView } from './types';

type Row = Record<string, unknown>;

const ALIASES = {
  id: ['id', 'key'],
  input: ['input', 'question', 'prompt', 'user', 'user_message', 'message', 'soru'],
  system: ['system', 'system_prompt', 'system_message'],
  reference: ['reference', 'expected', 'expected_answer', 'answer', 'gold', 'cevap', 'beklenen', 'reference_answer'],
  contains: ['contains', 'must_contain', 'expected_contains', 'mustcontain', 'icermeli'],
  equals: ['equals', 'exact', 'exact_match'],
  tags: ['tags', 'etiketler', 'labels'],
};

function pick(row: Row, aliases: string[]): string | undefined {
  for (const key of Object.keys(row)) {
    const norm = key.trim().toLowerCase().replace(/\s+/g, '_');
    if (aliases.includes(norm)) {
      const val = row[key];
      if (val !== null && val !== undefined && String(val).trim() !== '') return String(val).trim();
    }
  }
  return undefined;
}

/** Map flat tabular rows (from CSV/Excel) into single-turn dataset items. */
export function rowsToItems(rows: Row[]): EvalDatasetItemView[] {
  const items: EvalDatasetItemView[] = [];
  rows.forEach((row, i) => {
    const input = pick(row, ALIASES.input);
    if (!input) return; // skip rows without a question

    const messages: EvalDatasetItemView['input'] = [];
    const system = pick(row, ALIASES.system);
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: input });

    const expected: Record<string, unknown> = {};
    const reference = pick(row, ALIASES.reference);
    if (reference) expected.reference = reference;
    const contains = pick(row, ALIASES.contains);
    if (contains) expected.mustContain = contains.split(/[|;,]/).map((s) => s.trim()).filter(Boolean);
    const equals = pick(row, ALIASES.equals);
    if (equals) expected.equals = equals;

    const tagsRaw = pick(row, ALIASES.tags);
    items.push({
      id: pick(row, ALIASES.id) || `item-${i + 1}`,
      input: messages,
      expected: Object.keys(expected).length ? expected : undefined,
      tags: tagsRaw ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    });
  });
  return items;
}

/** Validate + normalise a raw JSON array (full control: message arrays, expected). */
export function parseJsonItems(raw: string): { items: EvalDatasetItemView[] } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { items: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { error: `Invalid JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { error: 'Items must be a JSON array' };
  const items: EvalDatasetItemView[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const entry = parsed[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') return { error: `Item ${i} is not an object` };
    if (!Array.isArray(entry.input)) return { error: `Item ${i} must have an "input" array of messages` };
    items.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : `item-${i + 1}`,
      input: entry.input as EvalDatasetItemView['input'],
      expected: (entry.expected as Record<string, unknown> | undefined) ?? undefined,
      tags: Array.isArray(entry.tags) ? (entry.tags as string[]) : undefined,
    });
  }
  return { items };
}

/** The column layout used by the importer + the downloadable templates. */
export const TEMPLATE_HEADERS = ['id', 'question', 'system', 'expected', 'contains', 'tags'] as const;

const TEMPLATE_ROWS: Array<Record<string, string>> = [
  {
    id: 'q1',
    question: 'What is the capital of France?',
    system: 'You are a concise geography assistant.',
    expected: 'Paris',
    contains: 'Paris',
    tags: 'geography,smoke',
  },
  {
    id: 'q2',
    question: 'List two primary colors.',
    system: '',
    expected: 'Red and blue are primary colors.',
    contains: 'red|blue',
    tags: 'art',
  },
];

/**
 * Build and download a starter template in the importer's column format.
 * Uses `xlsx` for both spreadsheet (.xlsx) and .csv output, so the headers
 * always match what {@link parseDatasetFile} understands.
 */
export function downloadDatasetTemplate(format: 'xlsx' | 'csv'): void {
  const sheet = XLSX.utils.json_to_sheet(TEMPLATE_ROWS, { header: [...TEMPLATE_HEADERS] });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'dataset');
  if (format === 'csv') {
    XLSX.writeFile(workbook, 'evaluation-dataset-template.csv', { bookType: 'csv' });
  } else {
    XLSX.writeFile(workbook, 'evaluation-dataset-template.xlsx');
  }
}

/** A copy-pasteable JSON starter, matching the importer's expectations. */
export const JSON_TEMPLATE = JSON.stringify(
  [
    {
      id: 'q1',
      input: [
        { role: 'system', content: 'You are a concise geography assistant.' },
        { role: 'user', content: 'What is the capital of France?' },
      ],
      expected: { reference: 'Paris', mustContain: ['Paris'] },
      tags: ['geography'],
    },
    {
      id: 'q2',
      input: [{ role: 'user', content: 'List two primary colors.' }],
      expected: { mustContain: ['red', 'blue'] },
    },
  ],
  null,
  2,
);

/** Parse an uploaded file (.xlsx/.xls/.csv/.json) into dataset items. */
export async function parseDatasetFile(file: File): Promise<{ items: EvalDatasetItemView[] } | { error: string }> {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.json')) {
      return parseJsonItems(await file.text());
    }
    if (name.endsWith('.csv') || name.endsWith('.tsv')) {
      const wb = XLSX.read(await file.text(), { type: 'string' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      return { items: rowsToItems(XLSX.utils.sheet_to_json<Row>(sheet, { defval: '' })) };
    }
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      return { items: rowsToItems(XLSX.utils.sheet_to_json<Row>(sheet, { defval: '' })) };
    }
    return { error: 'Unsupported file type — use .xlsx, .xls, .csv or .json' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to parse file' };
  }
}

/** A single row in the UI editor (simple single-turn Q/A entry). */
export interface EditorRow {
  id: string;
  input: string;
  reference: string;
  contains: string;
  tags: string;
}

export const emptyEditorRow = (): EditorRow => ({ id: '', input: '', reference: '', contains: '', tags: '' });

/** Build dataset items from the UI editor rows (skips rows without a question). */
export function editorRowsToItems(rows: EditorRow[]): EvalDatasetItemView[] {
  const items: EvalDatasetItemView[] = [];
  rows.forEach((r, i) => {
    if (!r.input.trim()) return;
    const expected: Record<string, unknown> = {};
    if (r.reference.trim()) expected.reference = r.reference.trim();
    if (r.contains.trim()) expected.mustContain = r.contains.split(/[|;,]/).map((s) => s.trim()).filter(Boolean);
    items.push({
      id: r.id.trim() || `item-${i + 1}`,
      input: [{ role: 'user', content: r.input.trim() }],
      expected: Object.keys(expected).length ? expected : undefined,
      tags: r.tags.trim() ? r.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    });
  });
  return items;
}
