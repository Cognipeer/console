/**
 * BrowserProfileService — CRUD on parent IBrowser entities.
 */

import slugify from 'slugify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type { IBrowser } from '@/lib/database';
import type { BrowserView, CreateBrowserInput, UpdateBrowserInput } from './types';
import { matchesProjectScope } from './internals';

const logger = createLogger('browser:profile-service');

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function serializeBrowser(record: IBrowser): BrowserView {
  const { _id, ...rest } = record;
  return { ...rest, id: typeof _id === 'string' ? _id : _id?.toString() ?? '' };
}

function canAccessBrowser(ctx: BrowserCtx, record: IBrowser | null | undefined): record is IBrowser {
  return Boolean(
    record
    && record.tenantId === ctx.tenantId
    && matchesProjectScope(record.projectId, ctx.projectId),
  );
}

interface BrowserCtx {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}

const KEY_OPTIONS = { lower: true, strict: true, trim: true };

async function generateUniqueBrowserKey(
  db: DatabaseProvider,
  tenantId: string,
  desired: string | undefined,
  projectId?: string,
): Promise<string> {
  const base = slugify(desired && desired.trim().length ? desired : 'browser', KEY_OPTIONS) || 'browser';
  let candidate = base;
  let attempt = 0;
  while (attempt < 50) {
    const existing = await db.findBrowserByKey(tenantId, candidate, projectId);
    if (!existing) return candidate;
    attempt += 1;
    candidate = `${base}-${attempt + 1}`;
  }
  throw new Error('Could not generate unique browser key');
}

export async function createBrowser(
  ctx: BrowserCtx,
  input: CreateBrowserInput,
): Promise<BrowserView> {
  const db = await withTenantDb(ctx.tenantDbName);
  const key = await generateUniqueBrowserKey(db, ctx.tenantId, input.key ?? input.name, ctx.projectId);
  const created = await db.createBrowser({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    key,
    name: input.name,
    description: input.description,
    status: input.status ?? 'active',
    artifactBucketKey: input.artifactBucketKey,
    defaultSessionConfig: input.defaultSessionConfig,
    defaultModelKey: input.defaultModelKey,
    defaultRunOptions: input.defaultRunOptions,
    metadata: input.metadata,
    createdBy: input.createdBy,
  });
  logger.info('Browser created', { browserId: created._id, key });
  return serializeBrowser(created);
}

export async function listBrowsers(
  ctx: BrowserCtx,
  filters?: { status?: string; search?: string },
): Promise<BrowserView[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const records = await db.listBrowsers(ctx.tenantId, {
    projectId: ctx.projectId,
    status: filters?.status,
    search: filters?.search,
  });
  return records.map(serializeBrowser);
}

export async function getBrowser(
  ctx: BrowserCtx,
  idOrKey: string,
): Promise<BrowserView | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record =
    (await db.findBrowserById(idOrKey).catch(() => null)) ??
    (await db.findBrowserByKey(ctx.tenantId, idOrKey, ctx.projectId));
  if (!canAccessBrowser(ctx, record)) return null;
  return serializeBrowser(record);
}

export async function updateBrowser(
  ctx: BrowserCtx,
  idOrKey: string,
  input: UpdateBrowserInput,
): Promise<BrowserView | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const existing =
    (await db.findBrowserById(idOrKey).catch(() => null)) ??
    (await db.findBrowserByKey(ctx.tenantId, idOrKey, ctx.projectId));
  if (!canAccessBrowser(ctx, existing)) return null;
  const updated = await db.updateBrowser(String(existing._id ?? ''), {
    name: input.name,
    description: input.description,
    status: input.status,
    artifactBucketKey: input.artifactBucketKey,
    defaultSessionConfig: input.defaultSessionConfig,
    defaultModelKey: input.defaultModelKey,
    defaultRunOptions: input.defaultRunOptions,
    metadata: input.metadata,
    updatedBy: input.updatedBy,
  });
  return updated ? serializeBrowser(updated) : null;
}

export async function deleteBrowser(
  ctx: BrowserCtx,
  idOrKey: string,
): Promise<boolean> {
  const db = await withTenantDb(ctx.tenantDbName);
  const existing =
    (await db.findBrowserById(idOrKey).catch(() => null)) ??
    (await db.findBrowserByKey(ctx.tenantId, idOrKey, ctx.projectId));
  if (!canAccessBrowser(ctx, existing)) return false;
  // Block delete if children exist
  const sessions = await db.listBrowserSessions(ctx.tenantId, {
    projectId: ctx.projectId,
    browserId: String(existing._id ?? ''),
    limit: 1,
  });
  if (sessions.length > 0) {
    throw new Error('Cannot delete browser with existing sessions. Delete or archive sessions first.');
  }
  return db.deleteBrowser(String(existing._id ?? ''));
}

export async function resolveBrowser(
  ctx: BrowserCtx,
  idOrKey: string,
): Promise<IBrowser | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record =
    (await db.findBrowserById(idOrKey).catch(() => null)) ??
    (await db.findBrowserByKey(ctx.tenantId, idOrKey, ctx.projectId));
  if (!canAccessBrowser(ctx, record)) return null;
  return record;
}
