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
import { platformModelCredits } from '@/lib/services/models/catalog';

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
  includePlatform?: string;
  includeUnavailable?: string;
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
  const credits = model.platform ? platformModelCredits(model.metadata) : undefined;
  return {
    ...model,
    platform: Boolean(model.platform),
    capabilities: resolveModelCapabilities(model),
    settings: sanitizeSettings(model.settings || {}),
    // A platform model is paid with credits, not per-token prices: its credit price, for the model list.
    ...(credits ? { credits } : {}),
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
