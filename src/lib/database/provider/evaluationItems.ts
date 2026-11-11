/**
 * Evaluation dataset item helpers shared by the Mongo and SQLite providers
 * (uniqueness checks, legacy embedded-array sanitising, search/label match).
 */
import type { EvaluationDatasetItemQuery, IEvaluationDatasetItem } from '../provider.interface';
import { hasAnyLabel, matchesLabel } from './labelMatch';

/** Throw the sanctioned duplicate error when a payload repeats an item id. */
export function assertUniqueItemIds(items: IEvaluationDatasetItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`A dataset item with one of the given ids already exists: "${item.id}"`);
    }
    seen.add(item.id);
  }
}

/**
 * Legacy embedded arrays were never uniqueness-checked and items could lack
 * ids entirely — sanitize before migrating under the unique (datasetId, id)
 * index: missing ids are filled positionally, duplicates get a deterministic
 * numeric suffix. Nothing is dropped, so itemCount stays truthful.
 */
export function sanitizeLegacyItemIds(items: IEvaluationDatasetItem[]): IEvaluationDatasetItem[] {
  const seen = new Set<string>();
  return items.map((item, index) => {
    const base = typeof item?.id === 'string' && item.id.trim() !== '' ? item.id : `item-${index + 1}`;
    let id = base;
    for (let n = 2; seen.has(id); n += 1) id = `${base}-${n}`;
    seen.add(id);
    return id === item?.id ? item : { ...item, id };
  });
}

/** Case-insensitive substring match over an item's id / input / tags. */
export function itemMatchesSearch(item: IEvaluationDatasetItem, search: string): boolean {
  const needle = search.toLowerCase();
  if (item.id.toLowerCase().includes(needle)) return true;
  if ((item.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))) return true;
  return (item.input ?? []).some((m) => (m.content ?? '').toLowerCase().includes(needle));
}

/** Search + label filtering for the legacy embedded-items read path. */
export function legacyItemMatches(item: IEvaluationDatasetItem, options?: EvaluationDatasetItemQuery): boolean {
  if (options?.search && !itemMatchesSearch(item, options.search)) return false;
  if (options?.labeled !== undefined && hasAnyLabel(item.labels) !== options.labeled) return false;
  if (options?.label && !matchesLabel(item.labels, options.label.key, options.label.value)) return false;
  return true;
}
