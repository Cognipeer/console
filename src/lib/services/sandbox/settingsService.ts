/**
 * Sandbox subsystem settings (per tenant): terminal TTL, default storage
 * provider / isolation, idle-reap window.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@/lib/database';
import type { ISandboxSettings } from '@/lib/database/provider.interface';

export const DEFAULT_TERMINAL_TTL_SECONDS = 3600;
export const DEFAULT_IDLE_REAP_SECONDS = 1800;

async function withTenantDb(tenantDbName: string) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export async function getSandboxSettings(tenantDbName: string): Promise<ISandboxSettings | null> {
  const db = await withTenantDb(tenantDbName);
  return db.getSandboxSettings();
}

/** Returns existing settings or creates a default row for the tenant. */
export async function ensureSandboxSettings(
  tenantDbName: string,
  tenantId: string,
): Promise<ISandboxSettings> {
  const db = await withTenantDb(tenantDbName);
  const existing = await db.getSandboxSettings();
  if (existing) return existing;
  return db.upsertSandboxSettings({
    id: randomUUID(),
    tenantId,
    fleetTokenHash: null,
    terminalSessionTtlSeconds: DEFAULT_TERMINAL_TTL_SECONDS,
    defaultStorageProvider: 'azure-blob',
    defaultIsolation: 'runc',
    idleReapSeconds: DEFAULT_IDLE_REAP_SECONDS,
  });
}

export async function updateSandboxSettings(
  tenantDbName: string,
  tenantId: string,
  patch: Partial<ISandboxSettings>,
): Promise<ISandboxSettings> {
  const db = await withTenantDb(tenantDbName);
  return db.upsertSandboxSettings({ ...patch, tenantId });
}
