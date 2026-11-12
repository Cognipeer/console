import { ApiError } from '@/lib/api/client';

/** Helpers for the failed calls of the alerts screens. */

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** The message of a failed response (`message`, then `error`), or the fallback. */
export async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { message?: unknown; error?: unknown } | null;
    if (typeof data?.message === 'string' && data.message) return data.message;
    if (typeof data?.error === 'string' && data.error) return data.error;
  } catch {
    // not JSON: keep the fallback
  }
  return fallback;
}

/**
 * The text for a call that failed through the API client: the server's `message`, then its `error`, else `fallback`
 * (the client's own message is the HTTP status text, which says nothing to a person); a lost connection keeps the
 * browser's message. Same order as `readApiError`.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const payload = error.payload as { message?: unknown; error?: unknown } | null | undefined;
    if (typeof payload?.message === 'string' && payload.message) return payload.message;
    if (typeof payload?.error === 'string' && payload.error) return payload.error;
    return fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
