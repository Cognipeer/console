'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QuotaPolicyFormData } from '@/components/quota/QuotaPolicyModal';
import { applyTargetPatches, parseLimitRows, type LimitRow, type TargetPatchEntry } from './limitsModel';
import { createResolutionCache, resolveLimitTargets } from './resolveTargets';

/** A failed call to the quota API: the HTTP status and the server's machine-readable `code`. */
export class LimitsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'LimitsApiError';
  }
}

async function call(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    cache: 'no-store',
    ...init,
    // Fastify refuses a JSON content type on a request without a body (DELETE).
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = (body && typeof body === 'object' ? body : {}) as { error?: unknown; code?: unknown };
    throw new LimitsApiError(
      typeof record.error === 'string' ? record.error : `Request failed (${response.status})`,
      response.status,
      typeof record.code === 'string' ? record.code : undefined,
    );
  }
  return body;
}

export interface ProjectOption {
  value: string;
  label: string;
}

/** The tenant's projects as select options (a tenant has tens, so the list is loaded whole). */
export function useProjectOptions(): ProjectOption[] {
  const [options, setOptions] = useState<ProjectOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    call('/api/projects')
      .then((body) => {
        if (cancelled) return;
        const list = (body && typeof body === 'object' ? (body as { projects?: unknown }).projects : undefined);
        setOptions(
          (Array.isArray(list) ? list : []).flatMap((raw): ProjectOption[] => {
            const project = raw as { _id?: unknown; name?: unknown; key?: unknown };
            if (typeof project._id !== 'string') return [];
            const name = typeof project.name === 'string' ? project.name : project._id;
            return [{ value: project._id, label: typeof project.key === 'string' ? `${name} (${project.key})` : name }];
          }),
        );
      })
      .catch(() => {
        // The editor still works: it just cannot offer a project list.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return options;
}

/** Create / update body: the editor's form data without keys the server would ignore. */
function toBody(data: QuotaPolicyFormData): Record<string, unknown> {
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
}

export interface UseLimits {
  rows: LimitRow[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** The load was refused (403): the person may not see limits at all. */
  forbidden: boolean;
  saving: boolean;
  reload: () => Promise<void>;
  /** `id` null creates. Throws `LimitsApiError` so the editor can stay open with the reason. */
  save: (id: string | null, data: QuotaPolicyFormData) => Promise<{ warnings: string[] }>;
  setEnabled: (row: LimitRow, enabled: boolean) => Promise<void>;
  remove: (row: LimitRow) => Promise<void>;
}

/** Every quota policy of the tenant, with the names of what they point at. */
export function useLimits(): UseLimits {
  const [loadedRows, setRows] = useState<LimitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const loaded = useRef(false);

  // The API names people, groups, tokens and agents; models, indexes, buckets and providers are named
  // from the resource registry (see resolveTargets.ts). Rows show at once, the names follow.
  const resolutions = useRef(createResolutionCache());
  const [patches, setPatches] = useState<ReadonlyMap<string, TargetPatchEntry>>(() => new Map());
  useEffect(() => {
    const controller = new AbortController();
    void resolveLimitTargets(loadedRows, { signal: controller.signal, cache: resolutions.current })
      .then((found) => {
        if (controller.signal.aborted) return;
        // A name that could not be looked up again this time (the registry failed for a moment) is kept.
        setPatches((previous) => (found.size === 0 ? previous : new Map([...previous, ...found])));
      })
      .catch(() => {
        // The table keeps showing the keys.
      });
    return () => controller.abort();
  }, [loadedRows]);
  const rows = useMemo(() => applyTargetPatches(loadedRows, patches), [loadedRows, patches]);

  const reload = useCallback(async () => {
    if (loaded.current) setRefreshing(true);
    try {
      setRows(parseLimitRows(await call('/api/quota/policies?include=targets')));
      setError(null);
      setForbidden(false);
      loaded.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setForbidden(err instanceof LimitsApiError && err.status === 403);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (id: string | null, data: QuotaPolicyFormData) => {
      setSaving(true);
      try {
        const body = (await call(id ? `/api/quota/policies/${encodeURIComponent(id)}` : '/api/quota/policies', {
          method: id ? 'PATCH' : 'POST',
          body: JSON.stringify(toBody(data)),
        })) as { warnings?: unknown } | null;
        await reload();
        return { warnings: Array.isArray(body?.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : [] };
      } finally {
        setSaving(false);
      }
    },
    [reload],
  );

  const setEnabled = useCallback(
    async (row: LimitRow, enabled: boolean) => {
      // Shown at once; put back by the reload below if the server said no.
      setRows((current) => current.map((r) => (r._id === row._id ? { ...r, enabled } : r)));
      try {
        await call(`/api/quota/policies/${encodeURIComponent(String(row._id))}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        });
      } finally {
        await reload();
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (row: LimitRow) => {
      // Addressed by the project it is in, as the project Quotas tab does.
      const query = row.projectId ? `?projectId=${encodeURIComponent(row.projectId)}` : '';
      await call(`/api/quota/policies/${encodeURIComponent(String(row._id))}${query}`, { method: 'DELETE' });
      await reload();
    },
    [reload],
  );

  return { rows, loading, refreshing, error, forbidden, saving, reload, save, setEnabled, remove };
}
