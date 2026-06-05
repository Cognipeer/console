'use client';

import { useCallback, useEffect, useState } from 'react';

const PIN_KEY = 'cgn:launcher:pinned';
const RECENT_KEY = 'cgn:launcher:recents';
const RECENT_LIMIT = 5;

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
}

export function useLauncherState(defaultPinnedIds: string[]) {
  const [pinned, setPinned] = useState<Set<string>>(() => new Set());
  const [recents, setRecents] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = readJSON<string[] | null>(PIN_KEY, null);
    setPinned(new Set(stored ?? defaultPinnedIds));
    setRecents(readJSON<string[]>(RECENT_KEY, []));
    setHydrated(true);
    // We deliberately only sync from defaults on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePin = useCallback((id: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      writeJSON(PIN_KEY, Array.from(next));
      return next;
    });
  }, []);

  const recordVisit = useCallback((id: string) => {
    setRecents((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
      writeJSON(RECENT_KEY, next);
      return next;
    });
  }, []);

  return { pinned, recents, togglePin, recordVisit, hydrated };
}
