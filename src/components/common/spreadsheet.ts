/**
 * Browser-side spreadsheet helpers shared by the Analysis and Evaluations
 * importers.
 *
 * Replaces the former `xlsx` (SheetJS) dependency, which has unfixable
 * high-severity advisories — npm's latest published version *is* the vulnerable
 * 0.18.5, because SheetJS moved distribution to their own CDN.
 *
 * `xlsx` was doing four separate jobs; each has a distinct replacement:
 *   - read .xlsx  → `exceljs` (`workbook.xlsx.load`)
 *   - read .xls   → `xls-reader` (exceljs is OOXML-only and cannot read BIFF)
 *   - read .csv/.tsv → `exceljs` (`workbook.csv.read`)
 *   - write templates → `exceljs` `writeBuffer()` + a Blob download shim,
 *     because the browser build of exceljs has no `writeFile`.
 *
 * Every reader funnels through {@link tabulate} so .xlsx, .xls and .csv all
 * produce identically-shaped, identically-normalised row objects.
 */

import ExcelJS from 'exceljs';
import { readXls, XlsError, CellError, type Cell as XlsCell, type Sheet as XlsSheet } from 'xls-reader';

/** A tabular row keyed by (raw) header text, matching the previous shape. */
export type SheetRow = Record<string, string>;

/** Raw 2D grid: outer array is rows, inner is columns, in sheet order. */
type Grid = unknown[][];

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_MIME = 'text/csv;charset=utf-8';

/* -------------------------------------------------------------------------- */
/* Cell normalisation                                                          */
/* -------------------------------------------------------------------------- */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Dates render as ISO `YYYY-MM-DD` rather than the raw Excel serial number that
 * SheetJS produced by default — a deliberate readability improvement, since a
 * date landing in a text column used to import as e.g. "45678".
 */
function dateToText(value: Date): string {
  if (Number.isNaN(value.getTime())) return '';
  const iso = `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  const h = value.getUTCHours();
  const m = value.getUTCMinutes();
  const s = value.getUTCSeconds();
  return h || m || s ? `${iso}T${pad2(h)}:${pad2(m)}:${pad2(s)}Z` : iso;
}

/**
 * Flatten one exceljs cell to text. exceljs returns structured objects for rich
 * text, hyperlinks, formulas and errors; without this they would stringify to
 * "[object Object]" and silently corrupt an import.
 */
function normaliseCell(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return dateToText(value);
  if (value instanceof CellError) return value.toString();
  if (depth > 3 || typeof value !== 'object') return String(value);

  const obj = value as Record<string, unknown>;
  // Rich text: { richText: [{ text }, ...] }
  if (Array.isArray(obj.richText)) {
    return obj.richText.map((part) => normaliseCell((part as Record<string, unknown>)?.text, depth + 1)).join('');
  }
  // Formula: { formula, result } — take the computed result.
  if ('result' in obj) return normaliseCell(obj.result, depth + 1);
  // Hyperlink: { text, hyperlink }
  if ('text' in obj) return normaliseCell(obj.text, depth + 1);
  // Error: { error: '#REF!' }
  if ('error' in obj) return normaliseCell(obj.error, depth + 1);
  if (Array.isArray(value)) return value.map((v) => normaliseCell(v, depth + 1)).join('');
  return '';
}

/* -------------------------------------------------------------------------- */
/* Grid → row objects                                                          */
/* -------------------------------------------------------------------------- */

function isBlankRow(row: unknown[]): boolean {
  return row.every((cell) => normaliseCell(cell).trim() === '');
}

/**
 * Turn a raw grid into header-keyed row objects, mirroring the old
 * `XLSX.utils.sheet_to_json(sheet, { defval: '' })` contract: first non-blank
 * row supplies the headers, missing cells become empty strings.
 */
function tabulate(grid: Grid): SheetRow[] {
  let cursor = 0;
  while (cursor < grid.length && isBlankRow(grid[cursor] ?? [])) cursor += 1;
  if (cursor >= grid.length) return [];

  const headerCells = grid[cursor] ?? [];
  const seen = new Map<string, number>();
  const headers = headerCells.map((cell, i) => {
    const base = normaliseCell(cell).trim() || `__EMPTY_${i}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    // Suffix duplicates so a repeated header cannot silently shadow a column.
    return count === 0 ? base : `${base}_${count}`;
  });

  const rows: SheetRow[] = [];
  for (let r = cursor + 1; r < grid.length; r += 1) {
    const raw = grid[r] ?? [];
    if (isBlankRow(raw)) continue;
    const row: SheetRow = {};
    headers.forEach((header, c) => {
      row[header] = normaliseCell(raw[c]);
    });
    rows.push(row);
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Format sniffing                                                             */
/* -------------------------------------------------------------------------- */

type BinaryKind = 'ooxml' | 'ole2' | 'html' | 'unknown';

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * Detect the real format from the bytes rather than trusting the extension.
 * SheetJS sniffed content too, so this preserves behaviour for the very common
 * case of a file whose extension doesn't match its contents.
 */
function sniff(buffer: ArrayBuffer): BinaryKind {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) return 'unknown';
  // ZIP local file header "PK\x03\x04" — every .xlsx is a zip container.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'ooxml';
  if (OLE2_MAGIC.every((b, i) => bytes[i] === b)) return 'ole2';

  // Cheap ASCII sniff over the head of the file for an HTML/XML document.
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 512); i += 1) head += String.fromCharCode(bytes[i]);
  if (/^\s*(<!doctype|<html|<\?xml|<table|<meta|<body)/i.test(head)) return 'html';
  return 'unknown';
}

const HTML_AS_XLS_MESSAGE =
  'This file is an HTML table saved with a spreadsheet extension, not a real Excel file. ' +
  'Some export tools do this. Open it in Excel, Numbers or Google Sheets and re-save it as ' +
  '.xlsx (or export as .csv), then import again.';

const LEGACY_XLS_MESSAGE =
  'This Excel file could not be read. It is either damaged, or saved in an older format ' +
  '(Excel 5.0/95 or earlier) that is no longer supported. Open it in Excel, Numbers or ' +
  'Google Sheets and re-save it as .xlsx, then import again.';

const UNRECOGNISED_MESSAGE =
  'This file is not a readable spreadsheet. Save it as .xlsx, .csv or .json and import again.';

/* -------------------------------------------------------------------------- */
/* Readers                                                                     */
/* -------------------------------------------------------------------------- */

async function readOoxmlGrid(buffer: ArrayBuffer): Promise<Grid> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const grid: Grid = [];
  const width = sheet.columnCount;
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const cells: unknown[] = [];
    for (let c = 1; c <= width; c += 1) cells.push(row.getCell(c).value);
    grid.push(cells);
  }
  return grid;
}

function readXlsGrid(buffer: ArrayBuffer): Grid {
  let sheet: XlsSheet | undefined;
  try {
    sheet = readXls(buffer).sheets.find((s) => s.visibility === 'visible') ?? readXls(buffer).sheets[0];
  } catch (err) {
    // xls-reader is BIFF8-only (Excel 97+). Anything older lands here, as does a
    // truncated or corrupt file — surface something the user can act on rather
    // than a raw parser error or a silently empty import.
    if (err instanceof XlsError) throw new Error(`${LEGACY_XLS_MESSAGE} (${err.message})`);
    throw err;
  }
  if (!sheet) return [];
  return sheet.rows.map((row) => row.slice() as XlsCell[]);
}

/**
 * exceljs's `csv.read()` only ever calls `stream.pipe(csvStream)`, so a tiny
 * duck-typed object satisfies it. This avoids importing `readable-stream`
 * directly, which would be a phantom dependency *and* would bundle a second
 * copy of it (exceljs's prebuilt browser bundle already contains one).
 */
function pipeShim(text: string) {
  return {
    pipe(destination: { write: (chunk: string) => unknown; end: () => unknown }) {
      destination.write(text);
      destination.end();
      return destination;
    },
  };
}

async function readDelimitedGrid(text: string, delimiter: string): Promise<Grid> {
  const workbook = new ExcelJS.Workbook();
  const sheet = await workbook.csv.read(
    pipeShim(text) as never,
    { parserOptions: { delimiter } } as never,
  );
  if (!sheet) return [];

  const grid: Grid = [];
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const values = sheet.getRow(r).values as unknown[];
    // exceljs row values are 1-based with a leading hole; drop it.
    grid.push(Array.isArray(values) ? values.slice(1) : []);
  }
  return grid;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/** True for the extensions the importers accept as tabular (non-JSON) input. */
export function isDelimitedFile(name: string): boolean {
  return name.endsWith('.csv') || name.endsWith('.tsv');
}

export function isSpreadsheetFile(name: string): boolean {
  return name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.xlsm');
}

/** Parse a .csv/.tsv file into header-keyed rows. */
export async function readDelimitedRows(file: File): Promise<SheetRow[]> {
  const delimiter = file.name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
  return tabulate(await readDelimitedGrid(await file.text(), delimiter));
}

/** Parse an .xlsx/.xls file into header-keyed rows, sniffing the real format. */
export async function readSpreadsheetRows(file: File): Promise<SheetRow[]> {
  const buffer = await file.arrayBuffer();
  switch (sniff(buffer)) {
    case 'ooxml':
      return tabulate(await readOoxmlGrid(buffer));
    case 'ole2':
      return tabulate(readXlsGrid(buffer));
    case 'html':
      throw new Error(HTML_AS_XLS_MESSAGE);
    default:
      throw new Error(UNRECOGNISED_MESSAGE);
  }
}

/* -------------------------------------------------------------------------- */
/* Template download                                                           */
/* -------------------------------------------------------------------------- */

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick: Safari cancels an in-flight download otherwise.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Build a single-sheet workbook from plain rows and download it. Replaces
 * `XLSX.writeFile`, which the browser build of exceljs has no equivalent of.
 */
export async function downloadSheet(options: {
  headers: readonly string[];
  rows: ReadonlyArray<Record<string, string>>;
  sheetName: string;
  filename: string;
  format: 'xlsx' | 'csv';
}): Promise<void> {
  const { headers, rows, sheetName, filename, format } = options;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = headers.map((header) => ({ header, key: header }));
  rows.forEach((row) => sheet.addRow(row));

  if (format === 'csv') {
    const buffer = await workbook.csv.writeBuffer();
    downloadBlob(new Blob([buffer], { type: CSV_MIME }), filename);
    return;
  }
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: XLSX_MIME }), filename);
}
