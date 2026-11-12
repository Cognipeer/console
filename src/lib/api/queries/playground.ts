'use client';

/**
 * React Query hooks of the model playgrounds (decisions, embeddings, images).
 *
 * A playground run is a request, not a resource: nothing is cached and nothing is invalidated, so each run is a
 * mutation whose `isPending` is the run's spinner. The chat, transcription, OCR and speech playgrounds stay on
 * their own transport (a stream, an upload, an audio body).
 *
 * The routes are the dashboard's `/api/dashboard/playground` plugin.
 */

import { useMutation } from '@tanstack/react-query';
import { apiPost, isApiError } from '@/lib/api/client';

/**
 * What a failed run says: the server's own message, else `Request failed (<status>)`, else the error's text, else
 * `fallback`. (The shared `errorMessage` would show the HTTP status text where a playground names the status.)
 */
export function playgroundErrorMessage(error: unknown, fallback: string): string {
  if (isApiError(error)) {
    const payload = error.payload;
    if (payload && typeof payload === 'object') {
      const message = (payload as { error?: unknown }).error;
      if (typeof message === 'string' && message) return message;
    }
    return `Request failed (${error.status})`;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Asks a model the decision questions about a text. */
export function useDecisionPlayground<TResponse>() {
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<TResponse>('/api/dashboard/playground/decisions', body),
  });
}

/** Embeds the lines of a text. */
export function useEmbeddingPlayground<TResponse>() {
  return useMutation({
    mutationFn: (body: { model: string; input: string[] }) =>
      apiPost<TResponse>('/api/dashboard/playground/embeddings', body),
  });
}

/** Generates images from a prompt. */
export function useImagePlayground<TResponse>() {
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<TResponse>('/api/dashboard/playground/images', body),
  });
}
