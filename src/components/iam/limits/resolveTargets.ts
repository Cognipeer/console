/**
 * Names the models, indexes, buckets and providers the Limits table points at.
 *
 * `GET /api/quota/policies?include=targets` names people, groups, tokens and
 * agents; for a `resource` / `provider` limit it only has the KEY the guard
 * compares. The table wants the NAME with the key underneath, and a note when
 * nothing has that key any more, so the keys are looked up in the resource
 * registry (`GET /api/resources/search`, the search behind the editor's
 * pickers): one lookup per distinct (kind of target, key, project), a few at a
 * time, answers kept for a minute so a refresh or a toggle asks nothing again.
 *
 * Pure of React: the hook that calls it is `useLimits`.
 */

import { resolveTargetOption, type FetchLike, type TargetResolution } from '@/components/quota/pickerSources';
import { registryLookupOf, targetPatchOf, type LimitRow, type TargetPatchEntry } from './limitsModel';

/** Lookups running at once. */
export const RESOLVE_CONCURRENCY = 4;
/** Distinct targets looked up in one pass; the rest keep showing their key. */
export const RESOLVE_MAX_LOOKUPS = 40;
/** How long an answer is trusted. */
export const RESOLVE_TTL_MS = 60_000;

export interface ResolutionCache {
  get(key: string): { at: number; resolution: TargetResolution } | undefined;
  set(key: string, value: { at: number; resolution: TargetResolution }): void;
}

export function createResolutionCache(): ResolutionCache {
  return new Map<string, { at: number; resolution: TargetResolution }>();
}

export interface ResolveOptions {
  fetcher?: FetchLike;
  signal?: AbortSignal;
  cache?: ResolutionCache;
  now?: () => number;
}

/** A patch for every row whose target the registry could name (or prove gone); keyed by the row's `_id`. */
export async function resolveLimitTargets(
  rows: readonly LimitRow[],
  { fetcher, signal, cache, now = Date.now }: ResolveOptions = {},
): Promise<Map<string, TargetPatchEntry>> {
  const lookups = new Map<string, NonNullable<ReturnType<typeof registryLookupOf>>>();
  const rowsByLookup = new Map<string, string[]>();
  for (const row of rows) {
    const lookup = registryLookupOf(row);
    if (!lookup) continue;
    if (!lookups.has(lookup.key)) lookups.set(lookup.key, lookup);
    rowsByLookup.set(lookup.key, [...(rowsByLookup.get(lookup.key) ?? []), String(row._id)]);
  }

  const answers = new Map<string, TargetResolution>();
  const pending: string[] = [];
  for (const key of lookups.keys()) {
    const hit = cache?.get(key);
    if (hit && now() - hit.at < RESOLVE_TTL_MS) answers.set(key, hit.resolution);
    else pending.push(key);
  }

  // A fixed number of workers pulling from one queue: never more than RESOLVE_CONCURRENCY requests in flight.
  const queue = pending.slice(0, RESOLVE_MAX_LOOKUPS);
  // The caller may not browse the registry: the first refusal is the answer to all the rest.
  let closed = false;
  const worker = async () => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      if (signal?.aborted || closed) return;
      const lookup = lookups.get(key)!;
      const resolution = await resolveTargetOption(lookup.source, lookup.value, fetcher, signal, lookup.projectId);
      if (resolution.status === 'unavailable') closed = true;
      answers.set(key, resolution);
      // Only an answer is worth keeping; "could not ask" is tried again next time.
      if (resolution.status === 'found' || resolution.status === 'missing') cache?.set(key, { at: now(), resolution });
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, queue.length) }, worker));

  const patches = new Map<string, TargetPatchEntry>();
  for (const [key, resolution] of answers) {
    const patch = targetPatchOf(lookups.get(key)!.source, resolution);
    if (!patch) continue;
    for (const rowId of rowsByLookup.get(key) ?? []) patches.set(rowId, { lookupKey: key, patch });
  }
  return patches;
}
