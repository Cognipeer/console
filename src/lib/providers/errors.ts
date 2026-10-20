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

export const PROVIDER_KEY_EXISTS = 'duplicate_key';

/**
 * Thrown when a provider is created under a key the tenant already has (a provider key is unique inside its tenant).
 * Maps to HTTP 409 `{ error, code }` at every provider create entry point (`sendProviderConfigError`), with the code
 * the Files API gives a bucket key that is taken. Asking again with the same key is refused again, so it is not
 * retryable.
 */
export class ProviderKeyExistsError extends Error {
  readonly code = PROVIDER_KEY_EXISTS;
  readonly retryable = false;

  constructor(key: string) {
    super(`Provider with key "${key}" already exists.`);
    this.name = 'ProviderKeyExistsError';
  }
}
