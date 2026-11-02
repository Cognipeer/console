'use client';

/**
 * The loading the access screens share: one request that reloads on a key, a search that asks the server as you
 * type, the names behind a list of principal keys, and the folders of the knowledge base.
 *
 * Every request is abortable and never throws into the render: a failure becomes `error`, a request that was
 * replaced or abandoned is dropped without a trace.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudienceMap } from './principalDisplay';
import { ragAccessApi, type RagAccessAudienceItem, type RagFolderView } from './ragAccessApi';

/** The audience route takes at most this many keys per call. */
const AUDIENCE_BATCH = 1000;
const SEARCH_DEBOUNCE_MS = 250;

export function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(typeof error === 'string' && error ? error : 'Something went wrong');
}

/** The HTTP status of a failed call, when it has one. */
export function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/* ── One request ─────────────────────────────────────────────────────────── */

export interface AccessLoad<T> {
  /** The last answer; kept while the next one loads. */
  data: T | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/**
 * Runs `load` on mount and whenever `key` changes (or `reload()` is called) while `enabled`. The previous answer
 * stays in `data` until the next one arrives, so a refresh does not blank the screen.
 */
export function useAccessLoad<T>(load: (signal: AbortSignal) => Promise<T>, key: string, enabled = true): AccessLoad<T> {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: Error | null }>({
    data: null,
    loading: enabled,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    setState((prev) => ({ data: prev.data, loading: true, error: null }));
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, loading: false, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        setState((prev) => ({ data: prev.data, loading: false, error: toError(error) }));
      },
    );
    return () => controller.abort();
  }, [key, nonce, enabled]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, reload };
}

/* ── A search as you type ────────────────────────────────────────────────── */

export interface ServerSearch<T> {
  query: string;
  setQuery: (query: string) => void;
  items: T[];
  /** A search is waiting out the pause after the last keystroke, or on its way. */
  loading: boolean;
  error: Error | null;
}

/**
 * Asks the server for the matches of `query` (the first page for an empty one), a quarter of a second after the
 * last keystroke. Nothing is ever loaded wholesale: the lists behind it can have tens of thousands of rows.
 * `resetKey` asks again when what is searched changed (another directory, another kind of principal).
 */
export function useServerSearch<T>(
  search: (query: string, signal: AbortSignal) => Promise<T[]>,
  options: { enabled?: boolean; resetKey?: string } = {},
): ServerSearch<T> {
  const { enabled = true, resetKey = '' } = options;
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const words = query.trim();
    setLoading(true);
    const handle = setTimeout(() => {
      searchRef.current(words, controller.signal).then(
        (found) => {
          if (controller.signal.aborted) return;
          setItems(found);
          setError(null);
          setLoading(false);
        },
        (failure: unknown) => {
          if (controller.signal.aborted || isAbort(failure)) return;
          setItems([]);
          setError(toError(failure));
          setLoading(false);
        },
      );
    }, words ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [enabled, query, resetKey]);

  return { query, setQuery, items, loading, error };
}

/* ── Who the keys of a list stand for ────────────────────────────────────── */

export interface RagAudience {
  audience: AudienceMap;
  /** The last call for names failed: the rows fall back to their stored labels. */
  failed: boolean;
}

/**
 * The names and head counts behind principal keys (the audience route). Only keys not asked about yet are asked, in
 * batches of 1000, so adding an entry to a list costs one small request.
 */
export function useRagAudience(moduleKey: string, principals: readonly string[]): RagAudience {
  const [audience, setAudience] = useState<Record<string, RagAccessAudienceItem>>({});
  const [failed, setFailed] = useState(false);
  const known = useRef(new Set<string>());
  // Keys cannot hold a newline (they are rejected as control characters), so a joined list is a safe identity.
  const signature = [...new Set(principals)].join('\n');

  useEffect(() => {
    const wanted = signature ? signature.split('\n') : [];
    const missing = wanted.filter((key) => !known.current.has(key));
    if (missing.length === 0) return undefined;
    const controller = new AbortController();
    void (async () => {
      for (let start = 0; start < missing.length; start += AUDIENCE_BATCH) {
        const batch = missing.slice(start, start + AUDIENCE_BATCH);
        try {
          const answer = await ragAccessApi.audience(moduleKey, batch, controller.signal);
          if (controller.signal.aborted) return;
          // Keys the route left out are invalid ones: remembered too, so they are not asked about again.
          for (const key of batch) known.current.add(key);
          setAudience((prev) => ({ ...prev, ...answer }));
          setFailed(false);
        } catch (error) {
          if (controller.signal.aborted || isAbort(error)) return;
          setFailed(true);
          return;
        }
      }
    })();
    return () => controller.abort();
  }, [moduleKey, signature]);

  return { audience, failed };
}

/* ── The folders ─────────────────────────────────────────────────────────── */

export interface RagFolderIndex {
  folders: RagFolderView[] | null;
  byId: ReadonlyMap<string, RagFolderView>;
  loading: boolean;
  error: Error | null;
}

/** The folders of the knowledge base, by id (loaded once `enabled`, reloaded when `refreshKey` changes). */
export function useRagFolderIndex(moduleKey: string, enabled: boolean, refreshKey: number | string = 0): RagFolderIndex {
  const load = useAccessLoad((signal) => ragAccessApi.folders(moduleKey, signal), `${moduleKey}:${refreshKey}`, enabled);
  const byId = useMemo(() => new Map((load.data ?? []).map((folder) => [folder._id, folder] as const)), [load.data]);
  return { folders: load.data, byId, loading: load.loading, error: load.error };
}
