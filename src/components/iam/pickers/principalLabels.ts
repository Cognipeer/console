'use client';

/**
 * Display names for the ids a stored policy refers to. A policy spec holds ids
 * only, so before an admin can read (or edit) it the names are looked up.
 * Lookups are bounded: a tenant can have thousands of users, so only a capped
 * number of ids is resolved and the rest stay readable as ids.
 */

import { useEffect, useState } from 'react';
import {
  iamApi,
  iamLookupApi,
  type IamPrincipalType,
} from '../api';
import type { ResourceRef } from '../policies/specModel';

const MAX_RESOLVED = 25;
const CONCURRENCY = 5;

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── groups (listed once, there are few of them) ──────────────────────────

const GROUP_TTL_MS = 60_000;
const GROUP_PAGE = 100;
const GROUP_MAX_PAGES = 10;
let groupCache: { at: number; promise: Promise<Map<string, string>> } | null = null;

export function loadGroupLabels(): Promise<Map<string, string>> {
  const now = Date.now();
  if (groupCache && now - groupCache.at < GROUP_TTL_MS) return groupCache.promise;
  const promise = (async () => {
    const labels = new Map<string, string>();
    let cursor: string | undefined;
    for (let page = 0; page < GROUP_MAX_PAGES; page++) {
      const res = await iamApi.listPrincipals({ type: 'group', limit: GROUP_PAGE, cursor });
      for (const item of res.items) labels.set(item.id, item.label);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return labels;
  })();
  groupCache = { at: now, promise };
  promise.catch(() => {
    if (groupCache?.promise === promise) groupCache = null;
  });
  return promise;
}

/** Group id -> name for tables. Empty until loaded (and when the lookup fails). */
export function useGroupLabels(enabled: boolean): Map<string, string> {
  const [labels, setLabels] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadGroupLabels()
      .then((m) => {
        if (!cancelled) setLabels(m);
      })
      .catch(() => {
        /* names are a nicety: counts still render */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return labels;
}

// ── individual lookups (editor) ──────────────────────────────────────────

/** id -> label for up to `MAX_RESOLVED` ids of one principal type; unknown ids are simply absent. */
export async function resolvePrincipalLabels(type: IamPrincipalType, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;

  let remaining = unique;
  if (type === 'group') {
    try {
      const all = await loadGroupLabels();
      for (const id of unique) {
        const label = all.get(id);
        if (label) out.set(id, label);
      }
      remaining = unique.filter((id) => !out.has(id));
    } catch {
      /* fall through to per-id lookups */
    }
  }

  await mapPool(remaining.slice(0, MAX_RESOLVED), CONCURRENCY, async (id) => {
    try {
      const detail = await iamApi.getPrincipal(type, id);
      const label = detail.principal.label;
      if (label && label !== id) out.set(id, label);
    } catch {
      /* deleted or inaccessible: the id stays as the label */
    }
  });
  return out;
}

/** `type:id` -> name for specific resources, via the registry search (needs the `resources` service). */
export async function resolveResourceLabels(
  refs: ReadonlyArray<Pick<ResourceRef, 'type' | 'id'>>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await mapPool(refs.slice(0, MAX_RESOLVED), CONCURRENCY, async (ref) => {
    try {
      const res = await iamLookupApi.searchResources({ type: ref.type, q: ref.id, limit: 10 });
      const found = res.items.find((x) => x.id === ref.id);
      if (found?.name) out.set(`${ref.type}:${ref.id}`, found.name);
    } catch {
      /* not allowed to read the registry, or gone */
    }
  });
  return out;
}
