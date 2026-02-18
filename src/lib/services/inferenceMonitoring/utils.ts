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
 * Validate that a base URL is a proper HTTP/HTTPS URL and not an internal/private address.
 */
export function isValidBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    // Block metadata, loopback, and link-local
    if (
      hostname === 'localhost' ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('169.254.') ||
      hostname === '[::1]'
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
