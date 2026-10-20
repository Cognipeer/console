/**
 * What the bucket list and the "Create bucket" screen know about a file provider: whether it can take a bucket,
 * what its driver is called, and whether the person may open the Providers area. Pure, so both screens (and
 * their tests) apply the same rules.
 */

import { resolveServiceCatalogEntry, serviceGlyph } from '@/lib/services/serviceCatalog';
import type { FileProviderListItem } from '../filesApi';

/** The Providers area, narrowed to file providers (the page reads `domain`; without support it simply lists all). */
export const FILE_PROVIDERS_HREF = '/dashboard/providers?domain=file';

/** A provider as the screens name it: its catalog entry (or, for a driver the catalog does not know, the driver id). */
export interface DriverInfo {
  /** "Amazon S3", "S3-compatible storage", "Azure Blob Storage"... */
  name: string;
  /** One to three characters for the swatch. */
  glyph: string;
  color: string;
}

const UNKNOWN_DRIVER_COLOR = '#64748b';

export function driverInfo(provider: { driver: string; key?: string; label?: string }): DriverInfo {
  const entry = resolveServiceCatalogEntry({
    driver: provider.driver,
    domain: 'file',
    key: provider.key,
    label: provider.label,
  });
  if (entry) return { name: entry.name, glyph: serviceGlyph(entry), color: entry.color };
  return {
    name: provider.driver,
    glyph: provider.driver.replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?',
    color: UNKNOWN_DRIVER_COLOR,
  };
}

/**
 * Whether a bucket can be created on the provider. The server refuses a provider that is not `active`
 * (409 `provider_inactive`); the health of a provider that is switched off, in error or not assigned to the
 * project says `inactive`. A provider whose last test failed, or that was never tested, can still be chosen: the
 * card says so and links to it, the choice stays the person's.
 */
export function isProviderUsable(provider: Pick<FileProviderListItem, 'status' | 'providerHealth'>): boolean {
  return provider.status === 'active' && provider.providerHealth?.state !== 'inactive';
}

export function hasUsableProvider(providers: ReadonlyArray<Pick<FileProviderListItem, 'status' | 'providerHealth'>>): boolean {
  return providers.some(isProviderUsable);
}

/**
 * Files on this server's own disk: the server has no address to show for them (`storageLocationBase` is `null`)
 * and they are not shared between replicas.
 */
export function isLocalDiskProvider(provider: Pick<FileProviderListItem, 'driver' | 'storageLocationBase'>): boolean {
  return provider.driver === 'local-filesystem' || provider.storageLocationBase === null;
}

/**
 * The Providers area is for owners and admins (its layout answers 404 to anybody else), so the links into it are
 * only drawn for them. An unknown role (outside the dashboard shell) counts as allowed: a hint, never the gate.
 */
export function canManageProviders(role: string | null | undefined): boolean {
  return !role || role === 'owner' || role === 'admin';
}
