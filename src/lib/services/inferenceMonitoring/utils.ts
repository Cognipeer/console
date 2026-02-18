import type { IInferenceServer } from '@/lib/database';

/**
 * Remove sensitive fields (apiKey) from server objects before sending to client.
 */
export function sanitizeServer(
  server: IInferenceServer,
): Omit<IInferenceServer, 'apiKey'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { apiKey, ...safe } = server;
  return safe;
}

/**
 * Normalize and validate an inference server base URL.
 * Accepts values without scheme (e.g. localhost:8000) by defaulting to http://.
 */
export function normalizeBaseUrl(url: string): string | null {
  try {
    const trimmed = String(url).trim();
    if (!trimmed) return null;

    const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed);
    const parsed = new URL(hasScheme ? trimmed : `http://${trimmed}`);

    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const hostname = parsed.hostname.toLowerCase();

    // Block wildcard/listen and link-local addresses.
    if (
      hostname === '0.0.0.0' ||
      hostname === '[::]' ||
      hostname.startsWith('169.254.')
    ) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export function isValidBaseUrl(url: string): boolean {
  return normalizeBaseUrl(url) !== null;
}
