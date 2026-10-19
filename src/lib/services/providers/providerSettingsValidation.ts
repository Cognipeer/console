import { getConfig } from '@/lib/core/config';
import { providerRegistry } from '@/lib/providers';

/** A driver's save-time check (`ProviderContract.validateSettings`), bound to its contract. */
export type ProviderSettingsValidator = (
  credentials: Record<string, unknown>,
  settings: Record<string, unknown> | undefined,
) => Promise<void>;

function contractOf(driver: string) {
  try {
    return providerRegistry.getContract(driver);
  } catch {
    return undefined;
  }
}

/**
 * The `validateSettings` hook of a driver, or `undefined` when it has none. A driver the registry does not know (a
 * removed plug-in, a test double) has no hook either: its runtime reports that when it is used.
 */
export function settingsValidatorOf(driver: string | undefined): ProviderSettingsValidator | undefined {
  const contract = driver ? contractOf(driver) : undefined;
  if (typeof contract?.validateSettings !== 'function') return undefined;
  return async (credentials, settings) => {
    await contract.validateSettings?.({
      credentials,
      settings: settings ?? {},
      isOnPrem: getConfig().deployment.isOnPrem,
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
): Promise<void> {
  await settingsValidatorOf(driver)?.(credentials, settings);
}
