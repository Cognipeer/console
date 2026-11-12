/**
 * Rows to usable import rows: column mapping, then the rules (empty, skip
 * rules, too long, duplicates). Browser-safe.
 */

import { CUSTOM_PROBE_LIMITS } from '../limits';
import type {
  ColumnMapping,
  ImportFormat,
  ImportRow,
  ImportRowRules,
  ImportStats,
  MappedRows,
  ParsedTable,
} from './types';

/** The rules a format starts with (its skip rules on); no format: just the two generic switches. */
export function defaultRowRules(format?: ImportFormat | null): ImportRowRules {
  return {
    dropDuplicates: true,
    dropEmpty: true,
    skip: (format?.skip ?? []).map((s) => ({ ...s, values: [...s.values] })),
  };
}

function cellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** Scripted turns from a `turns` cell (an array, or a JSON array in a string). */
function readTurns(value: unknown): string[] | undefined {
  let list: unknown = value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      list = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const turns = list.filter((t): t is string => typeof t === 'string').map((t) => t.trim());
  return turns.length === list.length && turns.every((t) => t) ? turns : undefined;
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Map parsed rows with a column mapping and apply the rules. Counters add up: total = usable + skipped. */
export function mapRows(table: ParsedTable, mapping: ColumnMapping, rules: ImportRowRules): MappedRows {
  const stats: ImportStats = {
    total: table.rows.length,
    usable: 0,
    skipped: 0,
    duplicates: 0,
    empty: 0,
    skippedByRule: 0,
    tooLong: 0,
  };
  const rows: ImportRow[] = [];
  const seen = new Set<string>();
  const max = CUSTOM_PROBE_LIMITS.maxTurnChars;

  table.rows.forEach((raw, index) => {
    const promptCell = mapping.prompt ? cellText(raw[mapping.prompt]).trim() : '';
    // A `turns` list is used when it is the mapped column, when nothing is mapped, or when the
    // mapped prompt is those turns joined (the promptfoo layout). Any other `turns` column is ignored.
    const listed = raw.turns !== undefined ? readTurns(raw.turns) : undefined;
    const turns =
      listed && (!mapping.prompt || mapping.prompt === 'turns' || promptCell === listed.join('\n').trim())
        ? listed
        : undefined;
    const prompt = turns ? turns.join('\n') : promptCell;
    const context = mapping.context ? cellText(raw[mapping.context]).trim() : '';

    if (!prompt && rules.dropEmpty) {
      stats.empty++;
      return;
    }

    for (const rule of rules.skip) {
      const cell = cellText(raw[rule.column]).trim().toLowerCase();
      if (rule.values.some((v) => v.trim().toLowerCase() === cell)) {
        stats.skippedByRule++;
        return;
      }
    }

    const pieces = turns ?? [prompt];
    const first = context && pieces.length ? [`${context}\n\n${pieces[0]}`, ...pieces.slice(1)] : pieces;
    if (first.some((t) => t.length > max) || first.length > CUSTOM_PROBE_LIMITS.maxTurnsPerAttempt) {
      stats.tooLong++;
      return;
    }

    if (rules.dropDuplicates) {
      const key = normalise(`${context}\n${prompt}`);
      if (seen.has(key)) {
        stats.duplicates++;
        return;
      }
      seen.add(key);
    }

    const row: ImportRow = { line: index + 1, prompt };
    const id = mapping.id ? cellText(raw[mapping.id]).trim() : '';
    if (id) row.id = id;
    const category = mapping.category ? cellText(raw[mapping.category]).trim() : '';
    if (category) row.category = category;
    if (context) row.context = context;
    if (turns && turns.length > 1) row.turns = turns;
    rows.push(row);
  });

  stats.usable = rows.length;
  stats.skipped = stats.duplicates + stats.empty + stats.skippedByRule + stats.tooLong;
  return { rows, stats };
}
