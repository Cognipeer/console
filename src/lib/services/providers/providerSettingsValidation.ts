import { getConfig } from '@/lib/core/config';
import { providerRegistry } from '@/lib/providers';
import type { ProviderEndpointScope } from './providerEndpointGuard';

/** A driver's save-time check (`ProviderContract.validateSettings`), bound to its contract. */
export type ProviderSettingsValidator = (
  credentials: Record<string, unknown>,
  settings: Record<string, unknown> | undefined,
) => Promise<void>;

/** What the caller of a save-time check is allowed to do (see `ProviderContract.validateSettings`). */
export interface ProviderSettingsCaller {
  /** The caller administers providers and may name directories of this server. */
  allowHostPaths?: boolean;
}

function contractOf(driver: string) {
  try {
    return providerRegistry.getContract(driver);
  } catch {
    return undefined;
  }
}

/**
 * The `validateSettings` hook of a driver, or `undefined` when it has none. A driver the registry does not know (a
 * removed plug-in, a test double) has no hook either: its runtime reports that when it is used. `scope` names the
 * organization the provider belongs to; a driver that vets its endpoints reads the private networks opened for it.
 * `caller` says what the person saving is allowed to set; it is passed on only when it grants something.
 */
export function settingsValidatorOf(
  driver: string | undefined,
  scope: ProviderEndpointScope,
  caller?: ProviderSettingsCaller,
): ProviderSettingsValidator | undefined {
  const contract = driver ? contractOf(driver) : undefined;
  if (typeof contract?.validateSettings !== 'function') return undefined;
  return async (credentials, settings) => {
    await contract.validateSettings?.({
      credentials,
      settings: settings ?? {},
      isOnPrem: getConfig().deployment.isOnPrem,
      ...(scope.tenantId !== undefined ? { tenantId: scope.tenantId } : {}),
      ...(caller?.allowHostPaths === true ? { allowHostPaths: true } : {}),
    });
  };
}

/**
 * Runs the driver's own check on credentials and settings that are about to be stored or tested. Throws
 * `ProviderSettingsError` (HTTP 400 for the caller) when the driver cannot work with them; a driver without a check
 * accepts anything here.
 */
export async function validateProviderSettings(
  driver: string | undefined,
  credentials: Record<string, unknown>,
  settings: Record<string, unknown> | undefined,
  scope: ProviderEndpointScope,
  caller?: ProviderSettingsCaller,
): Promise<void> {
  await settingsValidatorOf(driver, scope, caller)?.(credentials, settings);
}
