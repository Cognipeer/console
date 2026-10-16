'use client';

import { useEffect, useMemo, useState } from 'react';
import { createAlertCatalog, type AlertCatalog } from './alertCatalog';
import type { AlertMeta } from './alertTypes';

/**
 * The server's `meta` of `GET /alerts/rules` (metric catalog, mode availability, channel types) for
 * the screens that do not list rules themselves (incidents, incident detail, history, the overview
 * card). One request is shared by every consumer and the answer is kept for a minute, so moving
 * between alerts screens does not refetch it. Until it arrives (or when it fails) the catalog bundled
 * with the build stands in, so a metric is never shown as a raw id on the first paint.
 */

const TTL_MS = 60_000;

let cached: { meta: AlertMeta; at: number } | null = null;
let inflight: Promise<AlertMeta | null> | null = null;

function fresh(): AlertMeta | null {
  return cached && Date.now() - cached.at < TTL_MS ? cached.meta : null;
}

/** The rules page already holds the meta; handing it over saves the other screens a request. */
export function primeAlertMeta(meta: AlertMeta | null | undefined): void {
  if (meta) cached = { meta, at: Date.now() };
}

/** Test seam. */
export function resetAlertMetaCache(): void {
  cached = null;
  inflight = null;
}

export async function fetchAlertMeta(): Promise<AlertMeta | null> {
  const hit = fresh();
  if (hit) return hit;
  if (!inflight) {
    inflight = fetch('/api/alerts/rules')
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as { meta?: AlertMeta };
        if (data.meta) primeAlertMeta(data.meta);
        return data.meta ?? null;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export interface UseAlertMeta {
  meta: AlertMeta | null;
  catalog: AlertCatalog;
  /** The request finished (successfully or not). */
  settled: boolean;
  /** The request finished without a meta: the bundled catalog is in use and mode availability is unknown. */
  failed: boolean;
}

export function useAlertMeta(options: { enabled?: boolean } = {}): UseAlertMeta {
  const enabled = options.enabled ?? true;
  const [meta, setMeta] = useState<AlertMeta | null>(() => fresh());
  const [settled, setSettled] = useState(() => fresh() !== null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchAlertMeta().then((result) => {
      if (cancelled) return;
      if (result) setMeta(result);
      setSettled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const catalog = useMemo(() => createAlertCatalog(meta?.catalog), [meta?.catalog]);
  return { meta, catalog, settled, failed: settled && !meta };
}
