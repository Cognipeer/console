'use client';

/** The upload queue as a React hook: the rows (re-rendered on every change) and the calls that change them. */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { UploadQueueEngine, type QueueHandlers, type UploadFn } from './uploadQueueEngine';
import type { QueueItem } from './uploadModel';

export interface UseUploadQueueOptions extends QueueHandlers {
  bucketKey: string;
  /** Replaces the real upload call (tests). */
  upload?: UploadFn;
  concurrency?: number;
  maxFiles?: number;
}

export interface UseUploadQueueResult {
  items: readonly QueueItem[];
  /** Something is uploading or waiting for its turn. */
  busy: boolean;
  add: UploadQueueEngine['add'];
  remove: UploadQueueEngine['remove'];
  rename: UploadQueueEngine['rename'];
  setContentType: UploadQueueEngine['setContentType'];
  start: UploadQueueEngine['start'];
  cancelAll: UploadQueueEngine['cancelAll'];
}

/** A row that is being sent or waits for a free slot. */
export function isBusy(items: readonly QueueItem[]): boolean {
  return items.some((item) => item.status === 'uploading' || item.waiting);
}

/**
 * One queue per mounted screen. Uploads still in flight when the screen goes away are aborted, and what the run had
 * stored (or may have, if a request was cut off) is reported through `onSettled` as a finished run is. The two
 * callbacks may change on every render: the queue always calls the latest ones.
 */
export function useUploadQueue({ describeError, onSettled, ...options }: UseUploadQueueOptions): UseUploadQueueResult {
  const engineRef = useRef<UploadQueueEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new UploadQueueEngine({ ...options, handlers: { describeError, onSettled } });
  }
  const engine = engineRef.current;

  useEffect(() => {
    engine.handlers = { describeError, onSettled };
  });

  useEffect(
    () => () => {
      engine.cancelAll();
    },
    [engine],
  );

  const items = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  return {
    items,
    busy: isBusy(items),
    add: (files) => engine.add(files),
    remove: (id) => engine.remove(id),
    rename: (id, name) => engine.rename(id, name),
    setContentType: (id, contentType) => engine.setContentType(id, contentType),
    start: (ids, settings) => engine.start(ids, settings),
    cancelAll: () => engine.cancelAll(),
  };
}
