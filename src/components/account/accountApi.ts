/**
 * The few calls of the account page. A JSON content type is sent only with a
 * body (the server rejects a JSON request that has none).
 */

export class AccountApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AccountApiError';
  }
}

export async function requestJson(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const parsed = (await res.json()) as { error?: unknown; code?: unknown };
      if (typeof parsed.error === 'string' && parsed.error) message = parsed.error;
      if (typeof parsed.code === 'string') code = parsed.code;
    } catch {
      /* not JSON: the status line stands */
    }
    throw new AccountApiError(message, res.status, code);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
