'use client';

/**
 * The live preview of a draft role or draft per-service permissions: what the
 * policy engine would say for the person WITH the draft, before anything is
 * saved (`POST /api/iam/principals/user/:id/preview`).
 *
 * Debounced, and a slow answer for an older draft never replaces a newer one:
 * each request is aborted when the draft changes, and only the latest request's
 * answer is kept.
 */

import { useEffect, useRef, useState } from 'react';
import type { UserServicePermissions } from '@/lib/security/rbac';
import { isAbortError } from './client';
import { directoryApi, type AccessPreview } from './directoryApi';

export interface PreviewDraft {
  role?: string;
  servicePermissions?: UserServicePermissions;
}

export interface AccessPreviewState {
  preview: AccessPreview | null;
  loading: boolean;
  error: unknown;
}

export const DEFAULT_PREVIEW_DELAY_MS = 500;

/** A stable text for a draft, so an effect re-runs only when its meaning changed. */
export function draftKey(draft: PreviewDraft | null): string {
  if (!draft) return '';
  const permissions = Object.entries(draft.servicePermissions ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([draft.role ?? null, draft.servicePermissions ? permissions : null]);
}

export function useAccessPreview(
  userId: string | null,
  draft: PreviewDraft | null,
  options: { delayMs?: number } = {},
): AccessPreviewState {
  const { delayMs = DEFAULT_PREVIEW_DELAY_MS } = options;
  const [state, setState] = useState<AccessPreviewState>({ preview: null, loading: false, error: null });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const key = draftKey(draft);

  useEffect(() => {
    const current = draftRef.current;
    if (!userId || !current) {
      setState({ preview: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    const timer = window.setTimeout(() => {
      directoryApi
        .previewAccess(userId, current, controller.signal)
        .then((preview) => {
          if (!controller.signal.aborted) setState({ preview, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (isAbortError(error) || controller.signal.aborted) return;
          setState({ preview: null, loading: false, error });
        });
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [userId, key, delayMs]);

  return state;
}
