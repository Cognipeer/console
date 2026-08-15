/**
 * Dataset-import helpers — pure utilities shared by the external eval-import
 * wizard (DatasetImportWizard). No React, no I/O: everything here is
 * deterministic string/number shaping so it stays unit-testable.
 *
 * The wire format ids MUST match the pinned /api/dataset-import contract:
 *   detect  → { format?: DatasetImportFormat, preview, counts }
 *   import  → body.format: DatasetImportFormat
 * Labels for the ids live in i18n under `datasetImport.formats.<id>`.
 *
 * Imported data is for evaluation ONLY — it never writes usage/cost rows;
 * that product rule is enforced server-side, the UI just states it.
 */

/** Wire ids of the supported export formats (pinned API contract). */
export const DATASET_IMPORT_FORMATS = [
  'openai-chat-jsonl',
  'openai-pair-jsonl',
  'bedrock-invocation-jsonl',
  'langfuse-generations',
  'embedded-chat-json',
] as const;

export type DatasetImportFormat = (typeof DATASET_IMPORT_FORMATS)[number];

/** Client-side cap mirroring the server's 10MB fetch/import limit. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** True when `value` is one of the pinned wire format ids. */
export function isDatasetImportFormat(value: unknown): value is DatasetImportFormat {
  return (
    typeof value === 'string' &&
    (DATASET_IMPORT_FORMATS as readonly string[]).includes(value)
  );
}

/** UTF-8 byte length of a string (what the server's size caps count). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Human-readable byte count: `842 B`, `1.2 KB`, `10.0 MB`.
 * Values ≥ 100 in a unit drop the decimal (`128 KB`, not `128.0 KB`).
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 'B';
  for (const next of ['KB', 'MB', 'GB'] as const) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? String(Math.round(value)) : value.toFixed(1)} ${unit}`;
}

/** Single-line truncation with a trailing ellipsis character. */
export function truncateText(text: string, max = 100): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Best-effort plain text for a preview message `content` value — the RAW
 * preview items are untyped on the wire, so anything non-string is JSON-ified.
 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** `YYYY-MM-DD` of a local date (used in the suggested dataset name). */
export function toShortDate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** Suggested dataset name: `import <format> <date>` (format may be unknown). */
export function defaultDatasetName(
  format: DatasetImportFormat | null,
  date: Date = new Date(),
): string {
  return `import ${format ?? 'data'} ${toShortDate(date)}`;
}
