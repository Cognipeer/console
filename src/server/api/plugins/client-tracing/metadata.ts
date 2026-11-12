import { logger } from './logger';

/** Caller-supplied `metadata` key format — shared with the read-side
 *  `group_by`/`group_by_entity=metadata.<key>` validation (`usageBreakdown.ts`). */
const METADATA_KEY_PATTERN = /^[a-zA-Z0-9_]{1,40}$/;
const MAX_METADATA_KEYS = 10;
const MAX_METADATA_VALUE_LENGTH = 200;

/**
 * Sanitize the free-form `metadata` attribution bag callers attach to a
 * tracing session: plain string values only, bounded key count/length, safe
 * key charset (it later becomes a Mongo `metadata.<key>` dot-path / SQLite
 * JSON key in read queries — unsanitized keys would be an injection surface).
 * Drops offending entries rather than rejecting the whole ingest; logs once
 * per call when anything was dropped.
 */
export function sanitizeTracingMetadata(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, string> = {};
  let droppedCount = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(result).length >= MAX_METADATA_KEYS) {
      droppedCount += 1;
      continue;
    }
    if (
      !METADATA_KEY_PATTERN.test(key)
      || typeof value !== 'string'
      || value.length > MAX_METADATA_VALUE_LENGTH
    ) {
      droppedCount += 1;
      continue;
    }
    result[key] = value;
  }
  if (droppedCount > 0) {
    logger.warn('Tracing metadata: dropped invalid entries', { droppedCount });
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
