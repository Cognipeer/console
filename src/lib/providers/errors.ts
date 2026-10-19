export const PROVIDER_SETTINGS_INVALID = 'provider_settings_invalid';

/**
 * Thrown by a provider contract's `validateSettings` when the credentials or settings it was handed cannot work
 * (an endpoint without a scheme, a certificate that does not parse, an option the deployment does not allow).
 *
 * `field` names the form field the problem is in; `message` is shown to the person who typed it, so it says what to
 * change and never echoes a credential value. Maps to HTTP 400 `{ error, code, field }` at every provider
 * create / update / "Test connection" entry point (`sendProviderConfigError`).
 *
 * A setting the driver refuses is refused again by the next attempt, so the error declares itself not retryable
 * (`withResilience` and the file circuit breaker both read `retryable`).
 */
export class ProviderSettingsError extends Error {
  readonly code = PROVIDER_SETTINGS_INVALID;
  readonly field: string;
  readonly retryable = false;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ProviderSettingsError';
    this.field = field;
  }
}
