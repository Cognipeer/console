/**
 * Refusals for managed providers (provider records whose upstream credentials belong to the operator and whose calls are
 * paid with credits). Leaf module: the service layer throws them, the HTTP layer maps them.
 */

/** A managed record is read-only for tenants: no create, update, delete or test. HTTP 403. */
export class ManagedProviderReadOnlyError extends Error {
  readonly status = 403;

  readonly code = 'managed_provider_read_only';

  constructor(message = 'Managed providers are read-only.') {
    super(message);
    this.name = 'ManagedProviderReadOnlyError';
  }
}

/**
 * Thrown instead of opening the credentials of a managed provider for any path that is not the metered gateway.
 * HTTP 400.
 */
export class ManagedProviderError extends Error {
  readonly status = 400;

  readonly code = 'managed_provider_restricted';

  constructor(message = 'This provider is managed: it cannot be used outside the model gateway.') {
    super(message);
    this.name = 'ManagedProviderError';
  }
}
