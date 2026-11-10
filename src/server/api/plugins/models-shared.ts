/**
 * Model response/update helpers shared by the dashboard (`models.ts`) and the
 * token-authenticated client (`client-models.ts`) plugins.
 *
 * Model `settings` may hold provider credentials. Reads mask them with a
 * placeholder (`sanitizeModel`); updates merge the incoming settings over the
 * stored ones so a masked value round-tripped from a read is preserved rather
 * than overwriting the stored secret (`mergeSettings`).
 */
import type { IModel, ModelCategory } from '@/lib/database';
import { resolveModelCapabilities } from '@/lib/services/models/modelCapabilities';
import { normalizeModelSettings } from '@/lib/services/models/modelSettings';

export const PLACEHOLDER = '••••••••';

const SENSITIVE_FIELDS = new Set([
  'apiKey',
  'secretAccessKey',
  'serviceAccountKey',
  'sessionToken',
]);

export type ModelQuery = {
  category?: ModelCategory;
  includeProviders?: string;
  providerDriver?: string;
  providerKey?: string;
};

export function sanitizeSettings(settings: Record<string, unknown>) {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings || {})) {
    sanitized[key] = SENSITIVE_FIELDS.has(key) && value ? PLACEHOLDER : value;
  }
  return sanitized;
}

export function sanitizeModel(model: IModel) {
  return {
    ...model,
    capabilities: resolveModelCapabilities(model),
    settings: sanitizeSettings(model.settings || {}),
  };
}

/**
 * `null` deletes a key, the placeholder and `undefined` mean "unchanged".
 * Normalising on the way out heals rows whose values were persisted with the
 * wrong type — see `normalizeModelSettings`.
 */
export function mergeSettings(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
) {
  const merged: Record<string, unknown> = { ...existing };

  for (const [key, value] of Object.entries(incoming)) {
    if (value === PLACEHOLDER || value === undefined) {
      continue;
    }

    if (value === null) {
      delete merged[key];
      continue;
    }

    merged[key] = value;
  }

  return normalizeModelSettings(merged);
}
