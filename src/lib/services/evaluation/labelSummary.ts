/**
 * Label distribution over a dataset's items.
 *
 * Labeling is only worth doing if you can then SEE the shape of your traffic —
 * "62% of this dataset is a simple lookup, 11% is multi-step tool use" — and
 * jump straight to a segment. This module computes that breakdown; the pure
 * `summarizeLabels` does the counting so it is unit-testable without a DB.
 */

import type { IEvaluationDatasetItem } from '@/lib/database';
import { canonicalLabelValue } from '@/lib/database/provider/labelMatch';

/** Distinct values are capped per key so one free-text field can't explode the response. */
export const MAX_VALUES_PER_KEY = 12;

export interface LabelValueCount {
  value: string;
  count: number;
  /** Share of the labelled items for this key, in [0, 1]. */
  share: number;
}

export interface LabelKeySummary {
  key: string;
  /** Items carrying this label key. */
  count: number;
  values: LabelValueCount[];
  /** Distinct values beyond the `values` cap, collapsed into a count. */
  otherValues: number;
}

export interface DatasetLabelSummary {
  /** Items considered (the whole dataset, up to the scan cap). */
  total: number;
  /** Items carrying at least one label. */
  labeled: number;
  /** Of those, how many were last written by a human. */
  humanLabeled: number;
  keys: LabelKeySummary[];
  /** Analysis definitions that produced the labels present in the dataset. */
  definitionKeys: string[];
}

/** Only the label fields are read, so callers may pass a projection. */
type LabeledItem = Pick<IEvaluationDatasetItem, 'labels' | 'labelMeta'>;

export function summarizeLabels(items: LabeledItem[]): DatasetLabelSummary {
  const counts = new Map<string, Map<string, number>>();
  const definitionKeys = new Set<string>();
  let labeled = 0;
  let humanLabeled = 0;

  for (const item of items) {
    const labels = item.labels;
    if (!labels || Object.keys(labels).length === 0) continue;
    labeled += 1;
    if (item.labelMeta?.source === 'human') humanLabeled += 1;
    if (item.labelMeta?.definitionKey) definitionKeys.add(item.labelMeta.definitionKey);
    for (const [key, raw] of Object.entries(labels)) {
      // An empty extraction ("field not found") is not a segment.
      const value = canonicalLabelValue(raw);
      if (value === '') continue;
      const byValue = counts.get(key) ?? new Map<string, number>();
      byValue.set(value, (byValue.get(value) ?? 0) + 1);
      counts.set(key, byValue);
    }
  }

  const keys: LabelKeySummary[] = Array.from(counts.entries())
    .map(([key, byValue]) => {
      const total = Array.from(byValue.values()).reduce((sum, n) => sum + n, 0);
      const ranked = Array.from(byValue.entries())
        .map(([value, count]) => ({ value, count, share: total > 0 ? count / total : 0 }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      return {
        key,
        count: total,
        values: ranked.slice(0, MAX_VALUES_PER_KEY),
        otherValues: Math.max(0, ranked.length - MAX_VALUES_PER_KEY),
      };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    total: items.length,
    labeled,
    humanLabeled,
    keys,
    definitionKeys: Array.from(definitionKeys).sort(),
  };
}
