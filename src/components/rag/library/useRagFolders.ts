'use client';

/**
 * The folders of a knowledge base for the Documents tab. A failed read is silent: the tab works without folders
 * (a server that has none answers 404), and `ready` tells whether the list can be trusted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ragAccessApi, type RagFolderView } from '@/components/rag/access/ragAccessApi';

export interface RagFoldersState {
  folders: RagFolderView[];
  /** The list was read at least once, so a folder missing from it is gone. */
  ready: boolean;
  /** The last read failed (the previous list stays). */
  failed: boolean;
  /** Reads the list again; resolves when the new list is in. */
  reload: () => Promise<void>;
}

export function useRagFolders(moduleKey: string | undefined): RagFoldersState {
  const [folders, setFolders] = useState<RagFolderView[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // The newest read owns the list: an older answer that arrives late is dropped.
  const latest = useRef(0);

  const reload = useCallback(async () => {
    if (!moduleKey) return;
    const read = ++latest.current;
    try {
      const list = await ragAccessApi.folders(moduleKey);
      if (read !== latest.current) return;
      setFolders(list);
      setReady(true);
      setFailed(false);
    } catch {
      if (read !== latest.current) return;
      setFailed(true);
    }
  }, [moduleKey]);

  useEffect(() => {
    void reload();
    return () => {
      // A read still in flight when the module changes or the page goes away must not land, and the next module
      // starts from an empty list.
      latest.current += 1;
      setFolders([]);
      setReady(false);
      setFailed(false);
    };
  }, [reload]);

  return { folders, ready, failed, reload };
}
