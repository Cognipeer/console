import { isApiError } from '@/lib/api/client';

/** A refusal (401, 403, 404, 409...) will not change by asking again. */
export function isClientError(error: unknown): boolean {
  return isApiError(error) && error.status >= 400 && error.status < 500;
}

/** `retry` for queries: client errors are final; a lost connection or a 5xx gets one more try. */
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (isClientError(error)) return false;
  return failureCount < 1;
}
