'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryChannelDto } from '../alertTypes';
import { isAbortError, readApiError } from '../apiError';

export interface ChannelLibraryState {
  channels: LibraryChannelDto[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * `GET /alerts/channels/library` (masked entries with the rules that use them). Plain fetch like the other alerts
 * screens; `enabled: false` keeps a closed form from loading it.
 */
export function useChannelLibrary(options: { enabled?: boolean; fallbackError: string }): ChannelLibraryState {
  const { enabled = true, fallbackError } = options;
  const [channels, setChannels] = useState<LibraryChannelDto[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch('/api/alerts/channels/library', { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(await readApiError(res, fallbackError));
      const data = (await res.json()) as { channels?: LibraryChannelDto[] };
      setChannels(data.channels ?? []);
      setError(null);
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : fallbackError);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [fallbackError]);

  useEffect(() => {
    if (!enabled) return undefined;
    void load();
    return () => controllerRef.current?.abort();
  }, [enabled, load]);

  return { channels, loading, error, reload: () => void load() };
}
