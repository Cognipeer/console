'use client';

import { useMemo } from 'react';
import { useAlertMetaQuery } from '@/lib/api/queries/alerts';
import { createAlertCatalog, type AlertCatalog } from './alertCatalog';
import type { AlertMeta } from './alertTypes';

/**
 * The server's `meta` of `GET /alerts/rules` (metric catalog, mode availability, channel types) for
 * the screens that do not list rules themselves (incidents, incident detail, history, the overview
 * card). One request is shared by every consumer and the answer is kept for a minute, so moving
 * between alerts screens does not refetch it. Until it arrives (or when it fails) the catalog bundled
 * with the build stands in, so a metric is never shown as a raw id on the first paint.
 */

export interface UseAlertMeta {
  meta: AlertMeta | null;
  catalog: AlertCatalog;
  /** The request finished (successfully or not). */
  settled: boolean;
  /** The request finished without a meta: the bundled catalog is in use and mode availability is unknown. */
  failed: boolean;
}

export function useAlertMeta(options: { enabled?: boolean } = {}): UseAlertMeta {
  const query = useAlertMetaQuery(options.enabled ?? true);
  const meta = query.data ?? null;
  const settled = query.isSuccess || query.isError;
  const catalog = useMemo(() => createAlertCatalog(meta?.catalog), [meta?.catalog]);
  return { meta, catalog, settled, failed: settled && !meta };
}
