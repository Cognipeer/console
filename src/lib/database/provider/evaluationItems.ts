/**
 * Evaluation dataset item helpers shared by the Mongo and SQLite providers
 * (uniqueness checks, search match).
 */
import type { IEvaluationDatasetItem } from '../provider.interface';

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

/** Case-insensitive substring match over an item's id / input / tags. */
export function itemMatchesSearch(item: IEvaluationDatasetItem, search: string): boolean {
  const needle = search.toLowerCase();
  if (item.id.toLowerCase().includes(needle)) return true;
  if ((item.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))) return true;
  return (item.input ?? []).some((m) => (m.content ?? '').toLowerCase().includes(needle));
}
