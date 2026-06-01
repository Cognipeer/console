/**
 * Sandbox persistent volume CRUD. A volume is object-storage backed (Azure
 * Blob or S3) and surfaced inside sandboxes through a live FUSE mount. This
 * layer manages metadata only; the live IO path is the FUSE mount on the
 * runner.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@/lib/database';
import type { ISandboxVolume } from '@/lib/database/provider.interface';

async function withTenantDb(tenantDbName: string) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export interface CreateVolumeInput {
  name: string;
  provider: 'azure-blob' | 's3' | 'local';
  container: string;
  prefix: string;
  projectId?: string | null;
}

export async function createVolume(
  tenantDbName: string,
  tenantId: string,
  input: CreateVolumeInput,
  createdBy: string,
): Promise<ISandboxVolume> {
  const db = await withTenantDb(tenantDbName);
  const now = new Date();
  return db.createSandboxVolume({
    id: randomUUID(),
    tenantId,
    projectId: input.projectId ?? null,
    name: input.name,
    provider: input.provider,
    container: input.container,
    prefix: input.prefix,
    sizeBytes: null,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
}

export async function listVolumes(tenantDbName: string, projectId?: string): Promise<ISandboxVolume[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listSandboxVolumes(projectId ? { projectId } : undefined);
}

export async function getVolume(tenantDbName: string, id: string): Promise<ISandboxVolume | null> {
  const db = await withTenantDb(tenantDbName);
  return db.getSandboxVolume(id);
}

export async function deleteVolume(tenantDbName: string, id: string): Promise<boolean> {
  const db = await withTenantDb(tenantDbName);
  return db.deleteSandboxVolume(id);
}
