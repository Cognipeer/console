import { normalizeInferenceError } from './openaiErrors';

const CONTENT_FILTER_CODES = new Set(['content_filter', 'content_policy_violation']);

const BODY_CODE = /["']code["']\s*:\s*["'](?:content_filter|content_policy_violation)["']/i;

function isContentFilterCode(value: unknown): boolean {
  return typeof value === 'string' && CONTENT_FILTER_CODES.has(value.trim().toLowerCase());
}

/**
 * True when an upstream error is the provider's safety filter refusing the
 * request: HTTP 400 with a `content_filter` code. The code is read where the
 * clients keep it: `code` / `error.code` on SDK errors, the error body an
 * `UpstreamRequestError` carries (`body`) and a ProviderError's `responseBody` / quoted message, and the gateway's own normalization
 * (which also covers a managed provider's sanitized error, tagged with the code
 * by the gateway).
 */
export function isContentFilterError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const carrier = error as { status?: unknown; statusCode?: unknown; code?: unknown; error?: { code?: unknown } | null; body?: unknown };
  const status = carrier.status ?? carrier.statusCode;
  if (status === 400) {
    if (isContentFilterCode(carrier.code) || isContentFilterCode(carrier.error?.code)) return true;
    // The agent-sdk providers' ProviderError keeps the upstream body in `responseBody` and quotes it in `message`.
    const texts = [carrier.body, (carrier as { responseBody?: unknown }).responseBody, (error as Error).message];
    if (texts.some((text) => typeof text === 'string' && BODY_CODE.test(text))) return true;
  }
  // An upstream status other than 400 is an ordinary failure, whatever its code says.
  if (typeof status === 'number' && status !== 400) return false;
  try {
    const normalized = normalizeInferenceError(error);
    return normalized.status === 400 && isContentFilterCode(normalized.error.code);
  } catch {
    return false;
  }
}
