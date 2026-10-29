'use client';

/**
 * The permission state of the rows on screen, for the Access column: own list or inherited, how many entries, and
 * whether a source owns it. Read for admins only, for exactly the rows listed, and silent on failure: the column
 * then says what the rows themselves say (own, inherited, synced) without the counts.
 */

import { useEffect, useState } from 'react';
import { ragAccessApi, type RagAccessNodeState } from '@/components/rag/access/ragAccessApi';

/** The answer holds at most this many folders and this many documents. */
const MAX_IDS = 500;

export interface RagNodeStatesOptions {
  enabled: boolean;
  folderIds: string[];
  documentIds: string[];
  /** Bumped after permissions changed: read the states again. */
  refreshKey: number;
}

export function useRagNodeStates(moduleKey: string, options: RagNodeStatesOptions): Record<string, RagAccessNodeState> {
  const { enabled, folderIds, documentIds, refreshKey } = options;
  const [states, setStates] = useState<Record<string, RagAccessNodeState>>({});
  // A new array every render must not read again; the ids themselves decide.
  const idsKey = `${folderIds.join(',')}|${documentIds.join(',')}`;

  useEffect(() => {
    if (!enabled) {
      setStates({});
      return undefined;
    }
    if (folderIds.length === 0 && documentIds.length === 0) return undefined;
    const controller = new AbortController();
    ragAccessApi
      .nodes(
        moduleKey,
        { folderIds: folderIds.slice(0, MAX_IDS), documentIds: documentIds.slice(0, MAX_IDS) },
        controller.signal,
      )
      .then((nodes) => {
        if (!controller.signal.aborted) setStates(nodes);
      })
      .catch(() => {
        /* the column falls back to what the rows say */
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleKey, enabled, idsKey, refreshKey]);

  return states;
}
