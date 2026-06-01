/**
 * Sandbox template CRUD. A template is the reusable recipe used to launch
 * sandbox instances.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@/lib/database';
import type { ISandboxTemplate } from '@/lib/database/provider.interface';

async function withTenantDb(tenantDbName: string) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

export interface CreateTemplateInput {
  key: string;
  name: string;
  description?: string | null;
  baseImage: string;
  runtime: string;
  isolation: string;
  resources?: Record<string, unknown>;
  env?: Record<string, string>;
  entrypoint?: string[] | null;
  toolboxPort: number;
  previewPorts?: Array<Record<string, unknown>>;
  volumeMounts?: Array<Record<string, unknown>>;
  enabled?: boolean;
  projectId?: string | null;
}

export async function createTemplate(
  tenantDbName: string,
  tenantId: string,
  input: CreateTemplateInput,
  createdBy: string,
): Promise<ISandboxTemplate> {
  const db = await withTenantDb(tenantDbName);
  const now = new Date();
  return db.createSandboxTemplate({
    id: randomUUID(),
    tenantId,
    projectId: input.projectId ?? null,
    key: input.key,
    name: input.name,
    description: input.description ?? null,
    baseImage: input.baseImage,
    runtime: input.runtime,
    isolation: input.isolation,
    resources: input.resources ?? {},
    env: input.env ?? {},
    entrypoint: input.entrypoint ?? null,
    toolboxPort: input.toolboxPort,
    previewPorts: input.previewPorts ?? [],
    volumeMounts: input.volumeMounts ?? [],
    enabled: input.enabled ?? true,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
}

export async function listTemplates(
  tenantDbName: string,
  projectId?: string,
): Promise<ISandboxTemplate[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listSandboxTemplates(projectId ? { projectId } : undefined);
}

export async function getTemplate(tenantDbName: string, id: string): Promise<ISandboxTemplate | null> {
  const db = await withTenantDb(tenantDbName);
  return db.getSandboxTemplate(id);
}

export async function updateTemplate(
  tenantDbName: string,
  id: string,
  patch: Partial<ISandboxTemplate>,
): Promise<ISandboxTemplate | null> {
  const db = await withTenantDb(tenantDbName);
  return db.updateSandboxTemplate(id, patch);
}

export async function deleteTemplate(tenantDbName: string, id: string): Promise<boolean> {
  const db = await withTenantDb(tenantDbName);
  return db.deleteSandboxTemplate(id);
}
