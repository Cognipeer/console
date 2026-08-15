/**
 * Model `settings` is a free-form JSON blob, which makes it easy to persist the
 * wrong *type* for a key and never notice: the contract layer reads sampling
 * knobs behind `typeof === 'number'` and structured config behind
 * `typeof === 'object'`, so a stringified value is not rejected — it is silently
 * ignored. The model edit form used to stringify every value on load and PUT it
 * back, so any edit disabled the model's temperature and could take a Dynamic
 * router offline.
 *
 * The form no longer does that, but rows corrupted before the fix are still in
 * the database. Normalising on write heals them the next time the model is
 * saved, without a migration.
 */

const NUMERIC_KEYS = new Set([
  'frequencyPenalty',
  'maxCompletionTokens',
  'maxTokens',
  'presencePenalty',
  'temperature',
  'topP',
]);

const OBJECT_KEYS = new Set([
  'dynamic',
  'extraBody',
  'ocr',
  'reasoning',
  'requestDefaults',
]);

const ARRAY_KEYS = new Set(['unsupportedParams']);

function parseJsonish(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function normalizeModelSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(settings || {})) {
    if (typeof value !== 'string') {
      normalized[key] = value;
      continue;
    }

    if (NUMERIC_KEYS.has(key)) {
      const asNumber = Number(value);
      // An empty string coerces to 0, which would silently pin temperature to 0.
      normalized[key] = value.trim() !== '' && Number.isFinite(asNumber)
        ? asNumber
        : value;
      continue;
    }

    if (OBJECT_KEYS.has(key)) {
      const parsed = parseJsonish(value);
      normalized[key] = parsed && !Array.isArray(parsed) ? parsed : value;
      continue;
    }

    if (ARRAY_KEYS.has(key)) {
      const parsed = parseJsonish(value);
      normalized[key] = Array.isArray(parsed) ? parsed : value;
      continue;
    }

    normalized[key] = value;
  }

  return normalized;
}
