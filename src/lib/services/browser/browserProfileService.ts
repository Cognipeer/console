/**
 * BrowserProfileService — CRUD on parent IBrowser entities.
 */

import slugify from 'slugify';
import { z } from 'zod';
import { createLogger } from '@/lib/core/logger';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
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

/**
 * DTO for a browser record — WITHOUT the encrypted profile.
 *
 * `storageStateEnc` is a live login. It is decrypted in one place
 * (`readBrowserStorageState`, at session open) and must never travel out
 * through an API response, a log line or a UI payload, so it is dropped here
 * rather than at each call site.
 */
function serializeBrowser(record: IBrowser): BrowserView {
  const { _id, storageStateEnc: _enc, ...rest } = record;
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

// ── Signed-in profile (storageState) ────────────────────────────────────

/**
 * The shape Playwright's `storageState` export has.
 *
 * Validated rather than trusted because this file is uploaded: it is fed
 * straight into `browser.newContext({ storageState })`, and a malformed one
 * fails at session-open time with a Playwright error nobody can act on.
 */
const storageStateSchema = z.object({
  cookies: z.array(z.object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string(),
    expires: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  }).passthrough()).max(500).optional(),
  origins: z.array(z.object({
    origin: z.string(),
    localStorage: z.array(z.object({
      name: z.string(),
      value: z.string(),
    }).passthrough()).max(500).optional(),
  }).passthrough()).max(100).optional(),
}).passthrough();

export interface StorageStateSummary {
  cookieCount: number;
  origins: string[];
  earliestExpiry?: Date;
  uploadedAt: Date;
  uploadedBy?: string;
  sourceFileName?: string;
}

/**
 * Attach a signed-in profile to a browser, encrypted at rest.
 *
 * Whoever holds a `storageState` is logged in as that user until the cookies
 * expire, so the payload is encrypted with the platform key and NEVER read
 * back through the API — `getBrowser` returns only the summary. Sessions get
 * the decrypted value in memory, at open time, and nowhere else.
 */
export async function setBrowserStorageState(
  ctx: BrowserCtx,
  idOrKey: string,
  input: {
    storageState: unknown;
    uploadedBy?: string;
    sourceFileName?: string;
  },
): Promise<StorageStateSummary> {
  const db = await withTenantDb(ctx.tenantDbName);
  const existing = await resolveBrowser(ctx, idOrKey);
  if (!existing) throw new Error(`Browser not found: ${idOrKey}`);

  const parsed = storageStateSchema.safeParse(input.storageState);
  if (!parsed.success) {
    throw new Error(
      'Not a valid Playwright storageState file. Expected an object with `cookies` and/or `origins`.',
    );
  }

  const state = parsed.data;
  const cookies = state.cookies ?? [];
  if (cookies.length === 0 && (state.origins ?? []).length === 0) {
    throw new Error('This storageState carries no cookies and no origin storage — nothing to restore.');
  }

  // Cookie `expires` is Unix SECONDS, and -1 means a session cookie (no
  // expiry). Surfacing the earliest real expiry is what lets the UI say "this
  // profile stops working on the 14th" instead of leaving an operator to
  // discover it from a failed 3am run.
  const expiries = cookies
    .map((cookie) => (typeof cookie.expires === 'number' ? cookie.expires : -1))
    .filter((value) => value > 0);
  const earliestExpiry = expiries.length ? new Date(Math.min(...expiries) * 1000) : undefined;

  const meta: IBrowser['storageStateMeta'] = {
    uploadedAt: new Date(),
    uploadedBy: input.uploadedBy,
    cookieCount: cookies.length,
    origins: Array.from(new Set([
      ...cookies.map((cookie) => cookie.domain),
      ...(state.origins ?? []).map((origin) => origin.origin),
    ])).slice(0, 50),
    earliestExpiry,
    sourceFileName: input.sourceFileName,
  };

  await db.updateBrowser(String(existing._id ?? ''), {
    storageStateEnc: encryptObject(state),
    storageStateMeta: meta,
    updatedBy: input.uploadedBy,
  });

  logger.info('Browser storage state attached', {
    browserId: String(existing._id ?? ''),
    cookieCount: meta.cookieCount,
    origins: meta.origins.length,
  });

  return meta as StorageStateSummary;
}

export async function clearBrowserStorageState(
  ctx: BrowserCtx,
  idOrKey: string,
  updatedBy?: string,
): Promise<boolean> {
  const db = await withTenantDb(ctx.tenantDbName);
  const existing = await resolveBrowser(ctx, idOrKey);
  if (!existing) return false;
  // NULL, not undefined: both providers skip undefined fields when building
  // the update, so `undefined` here silently left the profile in place.
  await db.updateBrowser(String(existing._id ?? ''), {
    storageStateEnc: null,
    storageStateMeta: null,
    updatedBy,
  });
  return true;
}

/**
 * Decrypt a browser's stored profile for a session that is about to open.
 *
 * Returns `undefined` rather than throwing when the ciphertext will not open:
 * the platform key may have been rotated, and a flow that starts logged out
 * and fails on a login page is far easier to diagnose than one that cannot
 * start a session at all.
 */
export function readBrowserStorageState(record: IBrowser): Record<string, unknown> | undefined {
  if (!record.storageStateEnc) return undefined;
  try {
    return decryptObject<Record<string, unknown>>(record.storageStateEnc);
  } catch (err) {
    logger.warn('Stored browser profile could not be decrypted; starting a clean session', {
      browserId: String(record._id ?? ''),
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Strip the encrypted blob before a browser record leaves the service. */
export function redactBrowserSecrets(view: BrowserView): BrowserView {
  const { storageStateEnc: _enc, ...safe } = view;
  return safe as BrowserView;
}
