/**
 * Turns the token API's JSON errors (`{ error, code?, details? }`) into a
 * message in the UI language. Unknown codes fall back to the server's own text,
 * which is always English and always present.
 */

export type Translate = (key: string, values?: Record<string, string | number | undefined | null>) => string;

const KNOWN_CODES = new Set([
  'token_expiry_required',
  'token_expiry_too_long',
  'token_expiry_invalid',
  'invalid_ip_ranges',
  'invalid_label',
  'invalid_body',
  'policy_unavailable',
  'ip_ranges_exceed_minter',
]);

interface ErrorBody {
  error?: unknown;
  code?: unknown;
  details?: unknown;
}

/** The response body as an object; `{}` when it is empty, not JSON or not an object. */
export async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function readErrorBody(response: Response): Promise<ErrorBody> {
  return readJsonObject(response);
}

export function tokenErrorMessage(body: ErrorBody, t: Translate, fallback: string): string {
  const code = typeof body.code === 'string' ? body.code : '';
  const details = body.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : {};
  if (KNOWN_CODES.has(code)) {
    if (code === 'invalid_ip_ranges' && Array.isArray(body.details)) {
      const first = (body.details as Array<{ index?: number; value?: string }>)[0];
      return t('errors.invalid_ip_ranges', {
        value: first?.value ?? '',
        position: typeof first?.index === 'number' ? first.index + 1 : '',
      });
    }
    return t(`errors.${code}`, {
      days: typeof details.maxLifetimeDays === 'number' ? details.maxLifetimeDays : '',
    });
  }
  return typeof body.error === 'string' && body.error ? body.error : fallback;
}
