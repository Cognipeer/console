/**
 * Typed failure of the alerts services. The plugin maps `status` to the HTTP
 * answer (400 validation, 402 enterprise-only mode, 404 not found, 409 conflict, 429 throttled)
 * instead of letting a caller mistake surface as a 500.
 */
export type AlertApiErrorStatus = 400 | 402 | 404 | 409 | 429;

export class AlertApiError extends Error {
  readonly status: AlertApiErrorStatus;
  readonly code: string;
  /** Extra fields merged into the response body (e.g. `requiresEnterprise`). */
  readonly extra?: Record<string, unknown>;

  constructor(status: AlertApiErrorStatus, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'AlertApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function isAlertApiError(error: unknown): error is AlertApiError {
  return error instanceof AlertApiError;
}
