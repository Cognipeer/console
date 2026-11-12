'use client';

/**
 * React Query hooks of API tokens (the list of a workspace or of one project, create, edit, delete) and of the
 * tenant's token rules.
 *
 * - Every key starts `['tokens', <project>, ...]` (`tokensKeys`); `<project>` is the marker of `useResourceKey`.
 * - The list of the workspace and the list of one project are two lists (`list(project, projectId)`); a write
 *   reloads the whole `['tokens', <project>, 'list']` prefix.
 * - Editing a token patches it into the cached lists with what the server saved (no reload), as the screen did
 *   with its own state.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from '@/lib/api/client';
import { normalizeTokenPolicy, type ApiTokenRow, type TokenPolicyView } from '@/components/iam/tokens/tokenModel';
import { retryUnlessClientError } from './errors';
import { useProjectScope, useResourceKey } from './projectScope';

/* ── Keys ────────────────────────────────────────────────────────────────── */

export const tokensKeys = {
  all: ['tokens'] as const,
  project: (project: string) => ['tokens', project] as const,
  lists: (project: string) => ['tokens', project, 'list'] as const,
  /** `projectId` undefined: the tokens of the workspace (the caller's own, as the server decides). */
  list: (project: string, projectId?: string) => ['tokens', project, 'list', projectId ?? 'workspace'] as const,
  policy: (project: string) => ['tokens', project, 'policy'] as const,
};

/* ── Routes ──────────────────────────────────────────────────────────────── */

const enc = encodeURIComponent;

/** The list route, and the route of one token, of the workspace or of one project. */
export function tokenRoutes(projectId?: string): { list: string; item: (id: string) => string } {
  return projectId
    ? { list: `/api/projects/${enc(projectId)}/tokens`, item: (id) => `/api/projects/${enc(projectId)}/tokens/${enc(id)}` }
    : { list: '/api/tokens', item: (id) => `/api/tokens/${enc(id)}` };
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

export interface TokensResult {
  tokens: ApiTokenRow[];
  /** The caller may not read the tokens at all (403). */
  forbidden: boolean;
}

/** The tokens of the workspace, or of `projectId`. A 403 is an answer (`forbidden`), not a failure. */
export function useTokens(projectId?: string) {
  const [, project] = useResourceKey('tokens');
  const route = tokenRoutes(projectId).list;
  return useQuery<TokensResult, Error>({
    queryKey: tokensKeys.list(project, projectId),
    queryFn: async ({ signal }) => {
      try {
        const body = await apiGet<{ tokens?: ApiTokenRow[] }>(route, { signal });
        return { tokens: body?.tokens || [], forbidden: false };
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) return { tokens: [], forbidden: true };
        throw error;
      }
    },
    retry: retryUnlessClientError,
    // Tokens are also minted outside these hooks (the people-and-access screens), so a visit always refetches.
    staleTime: 0,
  });
}

/**
 * The tenant's token rules (`GET /api/tokens/policy`), normalized; `enabled` false reads nothing. That route needs
 * only the `tokens` service, so a person minting their own token can read the limits. A form re-reads it on every
 * open (`staleTime: 0`) so a rule changed in the meantime is picked up. No retry: the form works without it and
 * the server enforces the rules anyway.
 */
export function useTokenPolicyQuery(enabled = true) {
  const [, project] = useResourceKey('tokens');
  return useQuery<unknown, Error, TokenPolicyView>({
    queryKey: tokensKeys.policy(project),
    queryFn: ({ signal }) => apiGet<unknown>('/api/tokens/policy', { signal }),
    select: normalizeTokenPolicy,
    enabled,
    retry: false,
    staleTime: 0,
  });
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

/** Mints a token at `createUrl`; the result is the raw body (the secret is in it, shown once). The lists reload. */
export function useCreateToken(createUrl: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<Record<string, unknown>>(createUrl, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tokensKeys.lists(project) }),
  });
}

/** Saves a token (`PUT updateUrl(id)`); the result is the token as the server saved it, merged into the cached lists. */
export function useUpdateToken(updateUrl: (id: string) => string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiPut<ApiTokenRow>(updateUrl(id), body),
    onSuccess: (saved) => {
      queryClient.setQueriesData<TokensResult>({ queryKey: tokensKeys.lists(project) }, (current) =>
        current
          ? {
              ...current,
              tokens: current.tokens.map((token) =>
                String(token._id) === String(saved._id) ? { ...token, ...saved } : token,
              ),
            }
          : current,
      );
    },
  });
}

/** Deletes one token of the workspace or of `projectId`; the lists reload. */
export function useDeleteToken(projectId?: string) {
  const queryClient = useQueryClient();
  const project = useProjectScope();
  const item = tokenRoutes(projectId).item;
  return useMutation({
    mutationFn: (id: string) => apiDelete<unknown>(item(id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tokensKeys.lists(project) }),
  });
}
