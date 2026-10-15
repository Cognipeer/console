/** Helpers for the fetch calls of the alerts screens. */

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
