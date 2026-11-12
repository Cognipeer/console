/**
 * File parsing for the probe import: CSV (RFC 4180), JSONL, JSON and YAML into
 * a ParsedTable. Browser-safe: only the `yaml` package, no Node APIs.
 */

import { parse as parseYaml } from 'yaml';
import { IMPORT_LIMITS } from '../limits';
import { ImportError } from './types';
import type { ImportFileType, ParsedTable } from './types';

/** FNV-1a, 32 bit, unsigned. Used to seed sampling and derive canaries. */
export function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** RFC 4180 CSV into rows of cells. One pass, linear in the text length. */
export function parseCsv(text: string): string[][] {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let pending = false;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true;
      pending = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
      pending = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      pending = false;
    } else {
      cell += ch;
      pending = true;
    }
  }
  // Without this, one stray opening quote would swallow every row after it without a word.
  if (inQuotes) throw new ImportError(`A quoted value that starts in row ${rows.length + 1} is never closed`);
  if (pending || cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One JSON/YAML array element as a row object, or null when it is not a usable row. */
function toRow(item: unknown): Record<string, unknown> | null {
  if (isPlainObject(item)) return item;
  if (typeof item === 'string') return { prompt: item };
  if (Array.isArray(item) && item.every((x) => typeof x === 'string')) return { turns: item };
  return null;
}

function unionColumns(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function tableFromValue(fileName: string, fileType: ImportFileType, value: unknown, where: string): ParsedTable {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new ImportError(`${where} has no rows`);
    const kept = value.slice(0, IMPORT_LIMITS.maxRows);
    const rows: Array<Record<string, unknown>> = [];
    kept.forEach((item, index) => {
      const row = toRow(item);
      if (!row) throw new ImportError(`${where}: item ${index + 1} is not an object, a string or a list of strings`);
      rows.push(row);
    });
    return { fileName, fileType, columns: unionColumns(rows), rows, truncatedRows: value.length - kept.length };
  }
  if (isPlainObject(value)) {
    return { fileName, fileType, columns: [], rows: [], truncatedRows: 0, document: value };
  }
  throw new ImportError(`${where} must contain a list or an object`);
}

const isBlankRow = (cellRow: string[]) => cellRow.length === 1 && cellRow[0].trim() === '';

function parseCsvTable(fileName: string, text: string): ParsedTable {
  const all = parseCsv(text);
  // Blank lines before the header are skipped, like blank lines between rows.
  const first = all.findIndex((cellRow) => !isBlankRow(cellRow));
  const cells = first < 0 ? [] : all.slice(first);
  if (cells.length === 0) throw new ImportError('The file has no header row');
  const header = cells[0].map((h) => h.trim());
  if (header.every((h) => h === '')) throw new ImportError('The file has no header row');
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const h of header) {
    if (h && !seen.has(h)) {
      seen.add(h);
      columns.push(h);
    }
  }
  const rows: Array<Record<string, unknown>> = [];
  let truncatedRows = 0;
  for (let r = 1; r < cells.length; r++) {
    const cellRow = cells[r];
    if (isBlankRow(cellRow)) continue;
    if (rows.length >= IMPORT_LIMITS.maxRows) {
      truncatedRows++;
      continue;
    }
    const obj: Record<string, unknown> = {};
    const used = new Set<string>();
    for (let c = 0; c < header.length; c++) {
      const name = header[c];
      if (!name || used.has(name)) continue;
      used.add(name);
      obj[name] = cellRow[c] ?? '';
    }
    rows.push(obj);
  }
  if (rows.length === 0) throw new ImportError('The file has a header but no rows');
  return { fileName, fileType: 'csv', columns, rows, truncatedRows };
}

function parseJsonlTable(fileName: string, text: string): ParsedTable {
  const rows: Array<Record<string, unknown>> = [];
  let truncatedRows = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (i === 0 && lines[i].charCodeAt(0) === 0xfeff ? lines[i].slice(1) : lines[i]).trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ImportError(`Line ${i + 1} is not valid JSON`);
    }
    const row = toRow(value);
    if (!row) throw new ImportError(`Line ${i + 1} is not an object, a string or a list of strings`);
    if (rows.length >= IMPORT_LIMITS.maxRows) {
      truncatedRows++;
      continue;
    }
    rows.push(row);
  }
  if (rows.length === 0) throw new ImportError('The file has no rows');
  return { fileName, fileType: 'jsonl', columns: unionColumns(rows), rows, truncatedRows };
}

/** Read a file's text into a table. Throws ImportError with a message fit to show. */
export function parseImportFile(fileName: string, text: string): ParsedTable {
  if (typeof text !== 'string' || text.trim() === '') throw new ImportError('The file is empty');
  if (text.length > IMPORT_LIMITS.maxFileBytes) {
    throw new ImportError(`The file is larger than ${Math.round(IMPORT_LIMITS.maxFileBytes / (1024 * 1024))} MB`);
  }
  const ext = extensionOf(fileName);
  if (ext === 'csv') return parseCsvTable(fileName, text);
  if (ext === 'jsonl') return parseJsonlTable(fileName, text);
  if (ext === 'json') {
    let value: unknown;
    try {
      value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      throw new ImportError('The file is not valid JSON');
    }
    return tableFromValue(fileName, 'json', value, 'The JSON file');
  }
  if (ext === 'yaml' || ext === 'yml' || ext === 'prompt') {
    let value: unknown;
    try {
      value = parseYaml(text);
    } catch {
      throw new ImportError('The file is not valid YAML');
    }
    return tableFromValue(fileName, 'yaml', value, 'The YAML file');
  }
  throw new ImportError('Unsupported file type. Use .csv, .jsonl, .json, .yaml, .yml or .prompt');
}
