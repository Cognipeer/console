import crypto from 'crypto';
import slugify from 'slugify';
import {
  getDatabase,
  type DatabaseProvider,
  type IConfigItem,
  type IConfigGroup,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import type {
  CreateConfigGroupRequest,
  UpdateConfigGroupRequest,
  CreateConfigItemRequest,
  UpdateConfigItemRequest,
  ConfigItemView,
  ConfigGroupView,
  ResolveConfigRequest,
  ResolvedConfigMap,
} from './types';

const logger = createLogger('config');

// ── Encryption helpers ───────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getEncryptionKey(): Buffer {
  const cfg = getConfig();
  const secret = cfg.auth.providerEncryptionSecret || cfg.auth.jwtSecret;
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted value format');
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const encrypted = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

const MASK = '••••••••';

// ── Helpers ──────────────────────────────────────────────────────────────

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };

function generateGroupKey(name: string): string {
  const slug = slugify(name, SLUG_OPTIONS);
  return slug.length > 0 ? `cfg-grp-${slug}` : `cfg-grp-${Date.now()}`;
}

function generateItemKey(name: string): string {
  const slug = slugify(name, SLUG_OPTIONS);
  return slug.length > 0 ? `cfg-${slug}` : `cfg-${Date.now()}`;
}

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function maskSecretValue(item: IConfigItem): ConfigItemView {
  return {
    ...item,
    value: item.isSecret ? MASK : item.value,
  };
}

// ── Config Group operations ──────────────────────────────────────────────

export async function createConfigGroup(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  request: CreateConfigGroupRequest,
): Promise<IConfigGroup> {
  const db = await withTenantDb(tenantDbName);

  const key = request.key || generateGroupKey(request.name);

  const existing = await db.findConfigGroupByKey(key, projectId);
  if (existing) {
    throw new Error(`Config group with key "${key}" already exists.`);
  }

  const group = await db.createConfigGroup({
    tenantId,
    projectId,
    key,
    name: request.name,
    description: request.description,
    tags: request.tags,
    metadata: request.metadata,
    createdBy: request.createdBy,
  });

  logger.info('Config group created', { key, projectId });
  return group;
}

export async function updateConfigGroup(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  groupId: string,
  request: UpdateConfigGroupRequest,
): Promise<IConfigGroup> {
  const db = await withTenantDb(tenantDbName);

  const existing = await db.findConfigGroupById(groupId);
  if (!existing) throw new Error('Config group not found.');
  if (existing.projectId && existing.projectId !== projectId) {
    throw new Error('Config group does not belong to this project.');
  }

  const updateData: Record<string, unknown> = {
    updatedBy: request.updatedBy,
  };

  if (request.name !== undefined) updateData.name = request.name;
  if (request.description !== undefined) updateData.description = request.description;
  if (request.tags !== undefined) updateData.tags = request.tags;
  if (request.metadata !== undefined) updateData.metadata = request.metadata;

  const updated = await db.updateConfigGroup(groupId, updateData);
  if (!updated) throw new Error('Failed to update config group.');

  logger.info('Config group updated', { key: existing.key });
  return updated;
}

export async function deleteConfigGroup(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  groupId: string,
  performedBy: string,
): Promise<void> {
  const db = await withTenantDb(tenantDbName);

  const existing = await db.findConfigGroupById(groupId);
  if (!existing) throw new Error('Config group not found.');
  if (existing.projectId && existing.projectId !== projectId) {
    throw new Error('Config group does not belong to this project.');
  }

  // Cascade delete: remove all items under this group
  await db.deleteConfigItemsByGroupId(groupId);

  const deleted = await db.deleteConfigGroup(groupId);
  if (!deleted) throw new Error('Failed to delete config group.');

  // Audit log for group deletion
  await db.createConfigAuditLog({
    tenantId,
    projectId,
    configKey: existing.key,
    action: 'delete',
    version: 0,
    performedBy,
  });

  logger.info('Config group deleted (with items)', { key: existing.key });
}

export async function getConfigGroup(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  groupId: string,
): Promise<IConfigGroup | null> {
  const db = await withTenantDb(tenantDbName);
  const group = await db.findConfigGroupById(groupId);
  if (!group) return null;
  if (group.projectId && group.projectId !== projectId) return null;
  return group;
}

export async function getConfigGroupByKey(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  key: string,
): Promise<IConfigGroup | null> {
  const db = await withTenantDb(tenantDbName);
  return db.findConfigGroupByKey(key, projectId);
}

export async function listConfigGroups(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  filters?: {
    tags?: string[];
    search?: string;
  },
): Promise<IConfigGroup[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listConfigGroups({ projectId, ...filters });
}

export async function countConfigGroups(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
): Promise<number> {
  const db = await withTenantDb(tenantDbName);
  return db.countConfigGroups(projectId);
}

/**
 * Returns a group with its items (values masked for secrets).
 */
export async function getConfigGroupWithItems(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  groupId: string,
): Promise<ConfigGroupView | null> {
  const db = await withTenantDb(tenantDbName);

  const group = await db.findConfigGroupById(groupId);
  if (!group) return null;
  if (group.projectId && group.projectId !== projectId) return null;

  const items = await db.listConfigItems({ projectId, groupId });
  return {
    ...group,
    items: items.map(maskSecretValue),
  };
}

// ── Config Item operations ───────────────────────────────────────────────

export async function createConfigItem(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  groupId: string,
  request: CreateConfigItemRequest,
): Promise<ConfigItemView> {
  const db = await withTenantDb(tenantDbName);

  // Validate group exists
  const group = await db.findConfigGroupById(groupId);
  if (!group) throw new Error('Config group not found.');
  if (group.projectId && group.projectId !== projectId) {
    throw new Error('Config group does not belong to this project.');
  }

  const key = request.key || generateItemKey(request.name);

  // Check uniqueness within group
  const existing = await db.findConfigItemByKey(key, projectId);
  if (existing && existing.groupId === groupId) {
    throw new Error(`Config item with key "${key}" already exists in this group.`);
  }

  const storedValue = request.isSecret ? encrypt(request.value) : request.value;

  const item = await db.createConfigItem({
    tenantId,
    projectId,
    groupId,
    key,
    name: request.name,
    description: request.description,
    value: storedValue,
    valueType: request.valueType ?? 'string',
    isSecret: request.isSecret ?? false,
    tags: request.tags,
    version: 1,
    metadata: request.metadata,
    createdBy: request.createdBy,
  });

  await db.createConfigAuditLog({
    tenantId,
    projectId,
    configKey: key,
    action: 'create',
    newValue: request.isSecret ? MASK : request.value,
    version: 1,
    performedBy: request.createdBy,
  });

  logger.info('Config item created', { key, groupId, projectId, isSecret: request.isSecret });
  return maskSecretValue(item);
}

export async function updateConfigItem(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  itemId: string,
  request: UpdateConfigItemRequest,
): Promise<ConfigItemView> {
  const db = await withTenantDb(tenantDbName);

  const existing = await db.findConfigItemById(itemId);
  if (!existing) throw new Error('Config item not found.');
  if (existing.projectId && existing.projectId !== projectId) {
    throw new Error('Config item does not belong to this project.');
  }

  const updateData: Record<string, unknown> = {
    updatedBy: request.updatedBy,
  };

  if (request.name !== undefined) updateData.name = request.name;
  if (request.description !== undefined) updateData.description = request.description;
  if (request.valueType !== undefined) updateData.valueType = request.valueType;
  if (request.isSecret !== undefined) updateData.isSecret = request.isSecret;
  if (request.tags !== undefined) updateData.tags = request.tags;
  if (request.metadata !== undefined) updateData.metadata = request.metadata;

  if (request.value !== undefined) {
    const isSecret = request.isSecret ?? existing.isSecret;
    updateData.value = isSecret ? encrypt(request.value) : request.value;
    updateData.version = existing.version + 1;
  }

  const updated = await db.updateConfigItem(itemId, updateData);
  if (!updated) throw new Error('Failed to update config item.');

  const previousValue = existing.isSecret ? MASK : existing.value;
  const newValue = request.value !== undefined
    ? (request.isSecret ?? existing.isSecret ? MASK : request.value)
    : undefined;

  await db.createConfigAuditLog({
    tenantId,
    projectId,
    configKey: existing.key,
    action: 'update',
    previousValue,
    newValue,
    version: updated.version,
    performedBy: request.updatedBy,
  });

  logger.info('Config item updated', { key: existing.key, version: updated.version });
  return maskSecretValue(updated);
}

export async function deleteConfigItem(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  itemId: string,
  performedBy: string,
): Promise<void> {
  const db = await withTenantDb(tenantDbName);

  const existing = await db.findConfigItemById(itemId);
  if (!existing) throw new Error('Config item not found.');
  if (existing.projectId && existing.projectId !== projectId) {
    throw new Error('Config item does not belong to this project.');
  }

  const deleted = await db.deleteConfigItem(itemId);
  if (!deleted) throw new Error('Failed to delete config item.');

  await db.createConfigAuditLog({
    tenantId,
    projectId,
    configKey: existing.key,
    action: 'delete',
    previousValue: existing.isSecret ? MASK : existing.value,
    version: existing.version,
    performedBy,
  });

  logger.info('Config item deleted', { key: existing.key });
}

export async function getConfigItem(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  key: string,
): Promise<ConfigItemView | null> {
  const db = await withTenantDb(tenantDbName);
  const item = await db.findConfigItemByKey(key, projectId);
  if (!item) return null;
  return maskSecretValue(item);
}

export async function getConfigItemById(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  itemId: string,
): Promise<ConfigItemView | null> {
  const db = await withTenantDb(tenantDbName);
  const item = await db.findConfigItemById(itemId);
  if (!item) return null;
  if (item.projectId && item.projectId !== projectId) return null;
  return maskSecretValue(item);
}

export async function listConfigItems(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  filters?: {
    groupId?: string;
    isSecret?: boolean;
    tags?: string[];
    search?: string;
  },
): Promise<ConfigItemView[]> {
  const db = await withTenantDb(tenantDbName);
  const items = await db.listConfigItems({
    projectId,
    ...filters,
  });
  return items.map(maskSecretValue);
}

/**
 * Resolve config values by keys — returns actual values (decrypted for secrets).
 * This is the primary runtime API used by agents/services.
 */
export async function resolveConfigValues(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  request: ResolveConfigRequest,
  performedBy: string,
): Promise<ResolvedConfigMap> {
  const db = await withTenantDb(tenantDbName);
  const result: ResolvedConfigMap = {};

  for (const key of request.keys) {
    const item = await db.findConfigItemByKey(key, projectId);
    if (!item) continue;

    let value = item.value;
    if (item.isSecret) {
      try {
        value = decrypt(value);
      } catch (err) {
        logger.error('Failed to decrypt config secret', { key, error: err });
        continue;
      }
    }

    result[key] = {
      value,
      valueType: item.valueType,
      version: item.version,
    };

    if (item.isSecret) {
      await db.createConfigAuditLog({
        tenantId,
        projectId,
        configKey: key,
        action: 'read',
        version: item.version,
        performedBy,
      });
    }
  }

  return result;
}

export async function listConfigAuditLogs(
  tenantDbName: string,
  _tenantId: string,
  configKey: string,
  options?: { limit?: number; skip?: number; from?: Date; to?: Date },
) {
  const db = await withTenantDb(tenantDbName);
  return db.listConfigAuditLogs(configKey, options);
}

export async function countConfigItems(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
): Promise<number> {
  const db = await withTenantDb(tenantDbName);
  return db.countConfigItems(projectId);
}
