/**
 * BrowserSessionService
 *
 * Bridges the in-memory `BrowserManager` with persistence, file artifacts,
 * and tenant context. All routes / agent tools should call this module
 * (never the manager directly) so events are persisted and artifacts are
 * routed through the configured file bucket.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import { uploadFile } from '@/lib/services/files';
import { browserManager } from './browserManager';
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserArtifactRef,
  BrowserExtractInput,
  BrowserExtractResult,
  BrowserPdfInput,
  BrowserScreenshotInput,
  BrowserSessionEventView,
  BrowserSessionView,
  CreateBrowserSessionInput,
} from './types';
import type {
  BrowserActionType,
  IBrowserSession,
  IBrowserSessionEvent,
} from '@/lib/database';

const logger = createLogger('browser:session-service');

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function serializeSession(record: IBrowserSession): BrowserSessionView {
  const { _id, ...rest } = record;
  return { ...rest, id: typeof _id === 'string' ? _id : _id?.toString() ?? '' };
}

function serializeEvent(record: IBrowserSessionEvent): BrowserSessionEventView {
  const { _id, ...rest } = record;
  return { ...rest, id: typeof _id === 'string' ? _id : _id?.toString() ?? '' };
}

interface SessionContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}

export async function createBrowserSession(
  ctx: SessionContext,
  input: CreateBrowserSessionInput,
): Promise<BrowserSessionView> {
  const cfg = getConfig().browser;
  const sessionKey = `bs_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const db = await withTenantDb(ctx.tenantDbName);
  // Resolve parent Browser to inherit defaults
  const browser = await db.findBrowserById(input.browserId);
  if (!browser || browser.tenantId !== ctx.tenantId) {
    throw new Error(`Browser not found: ${input.browserId}`);
  }
  if (browser.status !== 'active') {
    throw new Error(`Browser ${browser.key} is not active`);
  }
  const config = { ...(browser.defaultSessionConfig ?? {}), ...(input.config ?? {}) };
  const artifactBucketKey = input.artifactBucketKey ?? browser.artifactBucketKey ?? cfg.defaultArtifactBucketKey;

  const created = await db.createBrowserSession({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    browserId: input.browserId,
    sessionKey,
    name: input.name,
    agentId: input.agentId,
    agentKey: input.agentKey,
    status: 'pending',
    config,
    artifactBucketKey,
    eventCount: 0,
    metadata: input.metadata,
    createdBy: input.createdBy,
  });

  const sessionId = created._id ? String(created._id) : '';

  try {
    await browserManager.openSession({
      tenantId: ctx.tenantId,
      sessionKey,
      config,
      onClose: async (reason) => {
        try {
          await persistEvent(ctx, sessionId, sessionKey, 'close', {
            status: 'success',
            data: { reason },
          });
          await db.updateBrowserSession(sessionId, {
            status: reason === 'shutdown' ? 'closed' : reason === 'idle-timeout' || reason === 'max-lifetime' ? 'expired' : 'closed',
            endedAt: new Date(),
          });
        } catch (err) {
          logger.warn('Failed to persist close metadata', {
            sessionId,
            error: err instanceof Error ? err.message : err,
          });
        }
      },
    });

    await db.updateBrowserSession(sessionId, {
      status: 'idle',
      startedAt: new Date(),
      lastActivityAt: new Date(),
    });

    await persistEvent(ctx, sessionId, sessionKey, 'create', {
      status: 'success',
      data: { sessionKey, agentKey: input.agentKey },
    });

    const refreshed = await db.findBrowserSessionById(sessionId);
    return serializeSession(refreshed ?? created);
  } catch (err) {
    await db.updateBrowserSession(sessionId, {
      status: 'errored',
      errorMessage: err instanceof Error ? err.message : String(err),
      endedAt: new Date(),
    });
    throw err;
  }
}

export async function listBrowserSessions(
  ctx: SessionContext,
  filters?: { status?: string; agentId?: string; browserId?: string; search?: string; limit?: number },
): Promise<BrowserSessionView[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const records = await db.listBrowserSessions(ctx.tenantId, {
    projectId: ctx.projectId,
    ...filters,
  });
  return records.map(serializeSession);
}

export async function getBrowserSession(
  ctx: SessionContext,
  sessionId: string,
): Promise<BrowserSessionView | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record = await db.findBrowserSessionById(sessionId);
  if (!record || record.tenantId !== ctx.tenantId) return null;
  return serializeSession(record);
}

async function loadSessionForKey(
  ctx: SessionContext,
  sessionKey: string,
): Promise<{ id: string; record: IBrowserSession }> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record = await db.findBrowserSessionByKey(ctx.tenantId, sessionKey, ctx.projectId);
  if (!record) throw new Error(`Browser session not found: ${sessionKey}`);
  return { id: String(record._id), record };
}

async function persistEvent(
  ctx: SessionContext,
  sessionId: string,
  sessionKey: string,
  type: BrowserActionType,
  payload: {
    status?: 'success' | 'error';
    url?: string;
    selector?: string;
    ref?: string;
    durationMs?: number;
    artifact?: BrowserArtifactRef;
    data?: Record<string, unknown>;
    errorMessage?: string;
  },
): Promise<BrowserSessionEventView> {
  const db = await withTenantDb(ctx.tenantDbName);
  const sequence = (await db.countBrowserSessionEvents(sessionId)) + 1;
  const event = await db.createBrowserSessionEvent({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    sessionId,
    sequence,
    type,
    status: payload.status,
    url: payload.url,
    selector: payload.selector,
    ref: payload.ref,
    durationMs: payload.durationMs,
    artifact: payload.artifact
      ? {
          bucketKey: payload.artifact.bucketKey,
          fileId: payload.artifact.fileId,
          objectKey: payload.artifact.objectKey,
          contentType: payload.artifact.contentType,
        }
      : undefined,
    data: payload.data,
    errorMessage: payload.errorMessage,
  });
  // Update parent session counters / activity (best-effort).
  await db
    .updateBrowserSession(sessionId, {
      eventCount: sequence,
      lastActivityAt: new Date(),
      currentUrl: payload.url,
    })
    .catch(() => undefined);
  return serializeEvent(event);
}

export async function runBrowserAction(
  ctx: SessionContext,
  sessionKey: string,
  action: BrowserAction,
): Promise<BrowserActionResult> {
  const { id } = await loadSessionForKey(ctx, sessionKey);
  const start = Date.now();
  const result = await browserManager.runAction(sessionKey, action);
  const durationMs = Date.now() - start;

  await persistEvent(ctx, id, sessionKey, action.type as BrowserActionType, {
    status: result.ok ? 'success' : 'error',
    url: result.url,
    selector: 'selector' in action ? action.selector : undefined,
    ref: 'ref' in action ? action.ref : undefined,
    durationMs,
    data: redactAction(action),
    errorMessage: result.errorMessage,
  });

  return result;
}

export async function extractFromBrowser(
  ctx: SessionContext,
  sessionKey: string,
  input: BrowserExtractInput,
): Promise<BrowserExtractResult> {
  const { id } = await loadSessionForKey(ctx, sessionKey);
  const start = Date.now();
  const result = await browserManager.extract(sessionKey, input);
  const durationMs = Date.now() - start;
  await persistEvent(ctx, id, sessionKey, 'extract', {
    status: result.ok ? 'success' : 'error',
    selector: input.selector,
    ref: input.ref,
    durationMs,
    data: { mode: input.mode ?? 'text', count: result.values.length },
    errorMessage: result.errorMessage,
  });
  return result;
}

export async function captureSnapshot(
  ctx: SessionContext,
  sessionKey: string,
): Promise<{ ariaSnapshot: string; url: string }> {
  const { id } = await loadSessionForKey(ctx, sessionKey);
  const start = Date.now();
  const snapshot = await browserManager.captureAriaSnapshot(sessionKey);
  const url = browserManager.getLiveStatus(sessionKey)?.url ?? '';
  await persistEvent(ctx, id, sessionKey, 'snapshot', {
    status: 'success',
    url,
    durationMs: Date.now() - start,
    data: { length: snapshot.length },
  });
  return { ariaSnapshot: snapshot, url };
}

/**
 * Capture a screenshot WITHOUT persisting it to a file bucket.
 * Useful for live UI polling – the UI converts the buffer to a data URL.
 */
export async function captureLiveScreenshot(
  sessionKey: string,
  input?: BrowserScreenshotInput,
): Promise<{ buffer: Buffer; contentType: string }> {
  return browserManager.screenshot(sessionKey, input);
}

export async function captureScreenshot(
  ctx: SessionContext,
  sessionKey: string,
  input: BrowserScreenshotInput & { createdBy: string; bucketKeyOverride?: string } = { createdBy: 'system' },
): Promise<{ artifact: BrowserArtifactRef; eventId: string }> {
  const { id, record } = await loadSessionForKey(ctx, sessionKey);
  const bucketKey =
    input.bucketKeyOverride ?? record.artifactBucketKey ?? getConfig().browser.defaultArtifactBucketKey;
  if (!bucketKey) {
    throw new Error('No artifact bucket configured for this session.');
  }

  const { buffer, contentType } = await browserManager.screenshot(sessionKey, input);
  const ext = contentType === 'image/jpeg' ? 'jpg' : 'png';
  const fileName = `${sessionKey}-${Date.now()}.${ext}`;
  const upload = await uploadFile(ctx.tenantDbName, ctx.tenantId, ctx.projectId ?? '', {
    bucketKey,
    fileName,
    contentType,
    data: buffer,
    convertToMarkdown: false,
    createdBy: input.createdBy,
    metadata: { sessionKey, kind: 'screenshot' },
  });

  const artifact: BrowserArtifactRef = {
    bucketKey,
    fileId: upload.record.id,
    objectKey: upload.record.key,
    contentType,
    url: `/api/client/v1/files/buckets/${bucketKey}/objects/${encodeURIComponent(upload.record.key)}/download`,
  };

  // Persist event + update lastScreenshot pointer on the session record.
  const event = await persistEvent(ctx, id, sessionKey, 'screenshot', {
    status: 'success',
    url: browserManager.getLiveStatus(sessionKey)?.url,
    artifact,
    data: { fullPage: input.fullPage ?? false, type: input.type ?? 'png' },
  });

  const db = await withTenantDb(ctx.tenantDbName);
  await db
    .updateBrowserSession(id, {
      lastScreenshot: {
        bucketKey,
        fileId: upload.record.id,
        objectKey: upload.record.key,
        capturedAt: new Date(),
      },
    })
    .catch(() => undefined);

  return { artifact, eventId: event.id };
}

export async function exportSessionPdf(
  ctx: SessionContext,
  sessionKey: string,
  input: BrowserPdfInput & { createdBy: string; bucketKeyOverride?: string } = { createdBy: 'system' },
): Promise<{ artifact: BrowserArtifactRef; eventId: string }> {
  const { id, record } = await loadSessionForKey(ctx, sessionKey);
  const bucketKey =
    input.bucketKeyOverride ?? record.artifactBucketKey ?? getConfig().browser.defaultArtifactBucketKey;
  if (!bucketKey) {
    throw new Error('No artifact bucket configured for this session.');
  }

  const { buffer, contentType } = await browserManager.pdf(sessionKey, input);
  const fileName = `${sessionKey}-${Date.now()}.pdf`;
  const upload = await uploadFile(ctx.tenantDbName, ctx.tenantId, ctx.projectId ?? '', {
    bucketKey,
    fileName,
    contentType,
    data: buffer,
    convertToMarkdown: false,
    createdBy: input.createdBy,
    metadata: { sessionKey, kind: 'pdf' },
  });

  const artifact: BrowserArtifactRef = {
    bucketKey,
    fileId: upload.record.id,
    objectKey: upload.record.key,
    contentType,
    url: `/api/client/v1/files/buckets/${bucketKey}/objects/${encodeURIComponent(upload.record.key)}/download`,
  };

  const event = await persistEvent(ctx, id, sessionKey, 'pdf', {
    status: 'success',
    artifact,
    url: browserManager.getLiveStatus(sessionKey)?.url,
    data: { ...input, createdBy: undefined, bucketKeyOverride: undefined } as Record<string, unknown>,
  });
  return { artifact, eventId: event.id };
}

export async function closeBrowserSession(
  ctx: SessionContext,
  sessionKey: string,
): Promise<{ closed: boolean }> {
  let id: string | null = null;
  try {
    const found = await loadSessionForKey(ctx, sessionKey);
    id = found.id;
  } catch {
    // Session not in DB – just close in manager (best-effort).
  }

  const closed = await browserManager.closeSession(sessionKey, 'manual');

  if (id) {
    const db = await withTenantDb(ctx.tenantDbName);
    await db
      .updateBrowserSession(id, {
        status: 'closed',
        endedAt: new Date(),
      })
      .catch(() => undefined);
  }
  return { closed };
}

export async function listBrowserSessionEvents(
  ctx: SessionContext,
  sessionId: string,
  options?: { limit?: number; skip?: number },
): Promise<BrowserSessionEventView[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const session = await db.findBrowserSessionById(sessionId);
  if (!session || session.tenantId !== ctx.tenantId) return [];
  const events = await db.listBrowserSessionEvents(sessionId, options);
  return events.map(serializeEvent);
}

export async function deleteBrowserSession(
  ctx: SessionContext,
  sessionId: string,
): Promise<boolean> {
  const db = await withTenantDb(ctx.tenantDbName);
  const session = await db.findBrowserSessionById(sessionId);
  if (!session || session.tenantId !== ctx.tenantId) return false;
  // Best-effort: ensure manager-side session is closed first
  await browserManager.closeSession(session.sessionKey, 'deleted').catch(() => undefined);
  return db.deleteBrowserSession(sessionId);
}

function redactAction(action: BrowserAction): Record<string, unknown> {
  // Redact any obviously-sensitive fields before persisting (e.g., long text).
  const clone: Record<string, unknown> = { ...(action as object) };
  if ('text' in clone && typeof clone.text === 'string' && clone.text.length > 200) {
    clone.text = `${clone.text.slice(0, 200)}…`;
  }
  return clone;
}

