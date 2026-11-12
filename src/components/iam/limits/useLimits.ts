'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import { useProjects } from '@/lib/api/queries/projects';
import { useDeleteQuotaPolicy, useQuotaPolicies, useSaveQuotaPolicy, useSetQuotaPolicyEnabled } from '@/lib/api/queries/quota';
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

/** A failed call to the quota API as `LimitsApiError`: the server's message (or the status), status and code. */
function toLimitsError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const record = (error.payload && typeof error.payload === 'object' ? error.payload : {}) as { error?: unknown; code?: unknown };
  return new LimitsApiError(
    typeof record.error === 'string' ? record.error : `Request failed (${error.status})`,
    error.status,
    typeof record.code === 'string' ? record.code : undefined,
  );
}

/** Runs a call of the quota hooks and throws its failure as `LimitsApiError`. */
async function asLimitsError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toLimitsError(error);
  }
}

export interface ProjectOption {
  value: string;
  label: string;
}

/** The tenant's projects as select options (a tenant has tens, so the list is loaded whole). */
export function useProjectOptions(): ProjectOption[] {
  // The editor still works when the list cannot be read: it just cannot offer a project list.
  const list = useProjects<{ _id?: unknown; name?: unknown; key?: unknown }>().data?.projects;
  return useMemo(
    () =>
      (Array.isArray(list) ? list : []).flatMap((project): ProjectOption[] => {
        if (typeof project._id !== 'string') return [];
        const name = typeof project.name === 'string' ? project.name : project._id;
        return [{ value: project._id, label: typeof project.key === 'string' ? `${name} (${project.key})` : name }];
      }),
    [list],
  );
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
  const policies = useQuotaPolicies();
  const savePolicy = useSaveQuotaPolicy();
  const setPolicyEnabled = useSetQuotaPolicyEnabled();
  const deletePolicy = useDeleteQuotaPolicy();
  const loadedRows = useMemo(() => (policies.data === undefined ? [] : parseLimitRows(policies.data)), [policies.data]);
  // A switch is shown at once; the reload that follows the call puts it back if the server said no.
  const [shownEnabled, setShownEnabled] = useState<ReadonlyMap<string, boolean>>(() => new Map());

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
  const rows = useMemo(
    () =>
      applyTargetPatches(loadedRows, patches).map((row) => {
        const enabled = shownEnabled.get(String(row._id));
        return enabled === undefined ? row : { ...row, enabled };
      }),
    [loadedRows, patches, shownEnabled],
  );

  const refetch = policies.refetch;
  const reload = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const save = useCallback(
    async (id: string | null, data: QuotaPolicyFormData) => {
      const body = (await asLimitsError(() => savePolicy.mutateAsync({ id, body: toBody(data) }))) as { warnings?: unknown } | null;
      return { warnings: Array.isArray(body?.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : [] };
    },
    [savePolicy],
  );

  const setEnabled = useCallback(
    async (row: LimitRow, enabled: boolean) => {
      const id = String(row._id);
      setShownEnabled((current) => new Map(current).set(id, enabled));
      try {
        await asLimitsError(() => setPolicyEnabled.mutateAsync({ id, enabled }));
      } finally {
        setShownEnabled((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      }
    },
    [setPolicyEnabled],
  );

  const remove = useCallback(
    async (row: LimitRow) => {
      // Addressed by the project it is in, so the server can confirm which project the policy is in.
      await asLimitsError(() => deletePolicy.mutateAsync({ id: String(row._id), projectId: row.projectId || undefined }));
    },
    [deletePolicy],
  );

  const failure = policies.error ? toLimitsError(policies.error) : null;
  const error = failure ? (failure instanceof Error ? failure.message : String(failure)) : null;
  return {
    rows,
    loading: policies.isPending,
    refreshing: policies.isFetching && policies.data !== undefined,
    error,
    forbidden: policies.error instanceof ApiError && policies.error.status === 403,
    saving: savePolicy.isPending,
    reload,
    save,
    setEnabled,
    remove,
  };
}
