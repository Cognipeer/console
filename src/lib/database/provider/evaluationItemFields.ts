/**
 * The fields a dataset item row may carry, shared by both providers.
 *
 * Item writers used to spread whatever object they were handed into the row
 * (Mongo) — an item imported from a file or sent over the API could smuggle
 * arbitrary keys (or `$`-operators on update) into the collection. Both
 * providers now copy only these keys; `labels` / `labelMeta` stay allowed
 * because internal callers (AI labeling) write them through the same methods.
 */

import type { IEvaluationDatasetItem } from './types.domain';

/** Item keys other than the id that a dataset item row stores. */
export const EVALUATION_ITEM_FIELDS = [
  'input',
  'expected',
  'tools',
  'toolResults',
  'responseFormat',
  'tags',
  'labels',
  'labelMeta',
] as const;

/**
 * The whitelisted, DEFINED fields of `item` (`null` is kept: on update it
 * means "clear this field"). `id` is never copied — callers own it.
 */
export function pickEvaluationItemFields(
  item: object,
): Partial<Omit<IEvaluationDatasetItem, 'id'>> {
  const source = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of EVALUATION_ITEM_FIELDS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out as Partial<Omit<IEvaluationDatasetItem, 'id'>>;
}

/** Dataset metadata block keys `patchEvaluationDatasetMetadata` accepts. */
const METADATA_KEY = /^[A-Za-z0-9_-]+$/;

/** Throw unless `key` is a safe top-level metadata block name. */
export function assertMetadataPatchKeys(patch: Record<string, unknown>): void {
  for (const key of Object.keys(patch)) {
    if (!METADATA_KEY.test(key)) {
      throw new Error(`Invalid dataset metadata key "${key}"`);
    }
  }
}
