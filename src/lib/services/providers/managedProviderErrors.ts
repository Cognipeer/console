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

/**
 * A platform-provided record (one visible in every project of the tenant, written only by the deployment) was the
 * target of a change made through a tenant API: update, delete, project assignment, replica or status change, test.
 * HTTP 403.
 */
export class PlatformRecordReadOnlyError extends Error {
  readonly status = 403;

  readonly code = 'platform_record_read_only';

  constructor(message = 'This item is provided by the platform and cannot be changed.') {
    super(message);
    this.name = 'PlatformRecordReadOnlyError';
  }
}
