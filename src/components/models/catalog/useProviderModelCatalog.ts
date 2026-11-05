'use client';

import { useCallback, useEffect, useReducer } from 'react';
import { useTranslations } from '@/lib/i18n';
import type { ProviderModelCatalog } from '@/lib/services/models/catalog/types';

/**
 * The models a provider can serve (`GET /api/models/providers/:providerKey/catalog`), for the "Add model" catalog
 * and the Model ID autocomplete of the create and edit forms.
 *
 * Every listing calls the provider's own API with its stored credentials, so one listing is kept in memory per
 * provider for a few minutes and shared by every caller on the page: the catalog and the form it opens make one
 * call between them. `refresh()` always lists again. The memo lives as long as the page does; switching projects
 * reloads the page, which drops it.
 */

const TTL_MS = 5 * 60_000;

interface Entry {
  data?: ProviderModelCatalog;
  /** When `data` arrived (ms); the entry is listed again after the TTL. */
  loadedAt?: number;
  /** The server's error text, when it sent one. */
  errorMessage?: string;
  /** HTTP status of a failed request; 0 = no response (network failure, unreadable body). */
  errorStatus?: number;
  /** The request in flight, if any; a newer one aborts it (latest wins). */
  controller?: AbortController;
}

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function notify(providerKey: string) {
  listeners.get(providerKey)?.forEach((listener) => listener());
}

function subscribe(providerKey: string, listener: () => void): () => void {
  let set = listeners.get(providerKey);
  if (!set) {
    set = new Set();
    listeners.set(providerKey, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(providerKey);
  };
}

function isFresh(entry: Entry | undefined, now = Date.now()): boolean {
  return Boolean(entry?.data && entry.loadedAt !== undefined && now - entry.loadedAt < TTL_MS && entry.errorStatus === undefined);
}

function looksLikeCatalog(value: unknown): value is ProviderModelCatalog {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as { models?: unknown }).models);
}

/** Lists the provider's models (again, when `force`): one request per provider at a time, the newest one wins. */
function load(providerKey: string, force: boolean) {
  const current = entries.get(providerKey) ?? {};
  if (!force && (current.controller || isFresh(current))) return;
  current.controller?.abort();
  const controller = new AbortController();
  entries.set(providerKey, { ...current, controller });
  notify(providerKey);

  const settle = (patch: Partial<Entry>) => {
    const latest = entries.get(providerKey);
    // A request that was replaced (refresh) or dropped (test reset) says nothing anymore.
    if (!latest || latest.controller !== controller) return;
    entries.set(providerKey, { ...latest, ...patch, controller: undefined });
    notify(providerKey);
  };

  void (async () => {
    try {
      const response = await fetch(`/api/models/providers/${encodeURIComponent(providerKey)}/catalog`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        settle({
          errorStatus: response.status,
          errorMessage: typeof body?.error === 'string' && body.error.trim() ? body.error : undefined,
        });
        return;
      }
      const body: unknown = await response.json();
      if (!looksLikeCatalog(body)) {
        settle({ errorStatus: 0, errorMessage: undefined });
        return;
      }
      settle({ data: body, loadedAt: Date.now(), errorStatus: undefined, errorMessage: undefined });
    } catch (error) {
      if (controller.signal.aborted) return;
      settle({ errorStatus: 0, errorMessage: error instanceof Error && error.message ? error.message : undefined });
    }
  })();
}

/**
 * Marks catalog entries as added to the project, so the catalog's "Added" badges are right without listing the
 * provider again. Called after a model was created from the catalog or the form.
 */
export function noteCatalogModelsCreated(providerKey: string, created: ReadonlyArray<{ modelId: string; key: string }>) {
  const entry = entries.get(providerKey);
  if (!entry?.data || created.length === 0) return;
  const byModelId = new Map<string, string[]>();
  for (const { modelId, key } of created) {
    const id = modelId.trim();
    if (!id || !key) continue;
    byModelId.set(id, [...(byModelId.get(id) ?? []), key]);
  }
  let changed = false;
  const models = entry.data.models.map((model) => {
    const keys = byModelId.get(model.id.trim());
    if (!keys) return model;
    changed = true;
    return { ...model, registeredModelKeys: [...new Set([...(model.registeredModelKeys ?? []), ...keys])] };
  });
  if (!changed) return;
  entries.set(providerKey, { ...entry, data: { ...entry.data, models } });
  notify(providerKey);
}

/** Drops every remembered listing (tests; a page that must not reuse one). */
export function resetProviderModelCatalogCache() {
  for (const entry of entries.values()) entry.controller?.abort();
  entries.clear();
  for (const key of [...listeners.keys()]) notify(key);
}

export interface ProviderModelCatalogState {
  data?: ProviderModelCatalog;
  /** The first listing of this provider is on its way (nothing to show yet). */
  loading: boolean;
  /** A listing is on its way while an earlier one is shown. */
  refreshing: boolean;
  /** The request failed (HTTP or network). A listing the provider refused arrives as `data.error` instead. */
  error?: string;
  /** Lists the provider again, ignoring the remembered listing. */
  refresh: () => void;
}

export function useProviderModelCatalog(
  providerKey: string | undefined,
  opts?: { enabled?: boolean },
): ProviderModelCatalogState {
  const t = useTranslations('modelCatalog');
  const key = (opts?.enabled ?? true) && providerKey ? providerKey : undefined;
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!key) return;
    const unsubscribe = subscribe(key, rerender);
    load(key, false);
    return unsubscribe;
  }, [key]);

  const refresh = useCallback(() => {
    if (key) load(key, true);
  }, [key]);

  const entry = key ? entries.get(key) : undefined;
  const inFlight = Boolean(entry?.controller);
  let error: string | undefined;
  if (entry?.errorStatus !== undefined) {
    error = entry.errorMessage
      ?? (entry.errorStatus > 0 ? t('errors.http', { status: entry.errorStatus }) : t('errors.network'));
  }
  return {
    data: entry?.data,
    // Before the effect's first request goes out there is no entry yet: that is loading too.
    loading: Boolean(key) && !entry?.data && (inFlight || !entry),
    refreshing: inFlight && Boolean(entry?.data),
    error,
    refresh,
  };
}
