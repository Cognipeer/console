/**
 * Shared matching rules for dataset-item labels.
 *
 * Labels are stored as free-shape JSON (`Record<string, unknown>`), so a value
 * can arrive as a string, number or boolean depending on the analysis field's
 * type. Filters, however, always come off a URL query as text. These helpers
 * define ONE comparison semantic — compare the canonical lowercase string form,
 * treating JSON `true`/`false` and SQLite's `1`/`0` as the same value — so the
 * MongoDB provider, the SQLite provider and the in-memory legacy path all agree
 * on what "labels.intent = refund" means.
 */

/** Canonical comparable form of a stored (or queried) label value. */
export function canonicalLabelValue(value: unknown): string {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

/**
 * Every canonical form a queried value may take in storage. Booleans get their
 * numeric alias because SQLite's json_extract yields 1/0 for JSON true/false.
 */
export function labelValueCandidates(value: string): string[] {
  const canonical = canonicalLabelValue(value);
  if (canonical === 'true') return ['true', '1'];
  if (canonical === 'false') return ['false', '0'];
  return [canonical];
}

/** Typed values a MongoDB equality filter should accept for a queried value. */
export function mongoLabelCandidates(value: string): unknown[] {
  const raw = value.trim();
  const canonical = canonicalLabelValue(raw);
  const candidates: unknown[] = [raw];
  if (raw !== canonical) candidates.push(canonical);
  if (canonical === 'true') candidates.push(true, 1);
  else if (canonical === 'false') candidates.push(false, 0);
  else if (raw !== '' && Number.isFinite(Number(raw))) candidates.push(Number(raw));
  return candidates;
}

/** A JSON path usable as a bound json_extract() argument. */
export function labelJsonPath(key: string): string {
  // Double quotes would terminate the quoted path segment; nothing else in a
  // key can break out of it.
  return `$."${key.replace(/"/g, '')}"`;
}

export function hasAnyLabel(labels: unknown): boolean {
  return !!labels && typeof labels === 'object' && Object.keys(labels as object).length > 0;
}

/** In-memory equivalent of the provider label filters (legacy embedded items). */
export function matchesLabel(
  labels: Record<string, unknown> | undefined,
  key: string,
  value?: string,
): boolean {
  if (!labels || !(key in labels)) return false;
  if (value === undefined) return true;
  return labelValueCandidates(value).includes(canonicalLabelValue(labels[key]));
}
