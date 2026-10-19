import type { FastifyReply } from 'fastify';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';

/** A provider configuration the console refuses: an endpoint the outbound guard does not allow, or a setting the driver cannot work with. */
export function isProviderConfigError(error: unknown): error is ProviderEndpointError | ProviderSettingsError {
  return error instanceof ProviderEndpointError || error instanceof ProviderSettingsError;
}

/**
 * The one HTTP mapping of a provider configuration the console refuses, shared by every route that creates, updates
 * or tests a provider (dashboard and client API alike): an endpoint the outbound guard does not allow
 * (`ProviderEndpointError`) and a setting the driver cannot work with (`ProviderSettingsError`) are the caller's to fix,
 * so both answer 400 `{ error, code, field }` - `field` names the form field, `code` tells the two apart.
 *
 * Returns true when it answered; any other error is left to the route.
 */
export function sendProviderConfigError(reply: FastifyReply, error: unknown): boolean {
  if (isProviderConfigError(error)) {
    void reply.code(400).send({ error: error.message, code: error.code, field: error.field });
    return true;
  }
  return false;
}
