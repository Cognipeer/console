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
import { routeInstanceCall } from '@/lib/core/cluster';
import type { QueuePayload } from '@/lib/core/queue';
import { getDatabase, runWithTenantScope, type DatabaseProvider } from '@/lib/database';
import { downloadFile, uploadFile } from '@/lib/services/files';
import {
  recordUsageEvent,
  resolveUsageAttribution,
} from '@/lib/services/usage/usageEvents';
import { browserManager } from './browserManager';
import { readBrowserStorageState } from './browserProfileService';
import { browserEntityId } from './entityId';
import { matchesProjectScope, redactTypedText, sanitizePersistedUrl } from './internals';
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
  IBrowserSessionConfig,
  IBrowserSessionEvent,
} from '@/lib/database';

const logger = createLogger('browser:session-service');

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

/**
 * Teach the manager how to turn Files ids into upload payloads.
 *
 * The manager knows Playwright and nothing else, so it cannot reach tenant
 * storage on its own. Uploads deliberately take a Files id rather than a
 * path: a path would let any caller hand the browser a file the server can
 * read, and the document a flow uploads is tenant data that belongs in the
 * tenant's bucket anyway.
 */
browserManager.setUploadResolver(async (ctx, fileIds) => {
  const db = await withTenantDb(ctx.tenantDbName);
  const resolved: Array<{ name: string; mimeType: string; buffer: Buffer }> = [];

  for (const fileId of fileIds) {
    const record = await db.findFileRecordById(fileId);
    if (
      !record
      || record.tenantId !== ctx.tenantId
      || !matchesProjectScope(record.projectId, ctx.projectId)
    ) {
      throw new Error(`File not found: ${fileId}`);
    }
    const download = await downloadFile(
      ctx.tenantDbName,
      ctx.tenantId,
      record.projectId ?? ctx.projectId ?? '',
      record.bucketKey,
      record.key,
    );
    resolved.push({
      name: record.name || record.key,
      mimeType: download.contentType ?? record.contentType ?? 'application/octet-stream',
      buffer: download.data,
    });
  }

  return resolved;
});

function serializeSession(record: IBrowserSession): BrowserSessionView {
  const { _id, ...rest } = record;
  return { ...rest, id: typeof _id === 'string' ? _id : _id?.toString() ?? '' };
}

function serializeEvent(record: IBrowserSessionEvent): BrowserSessionEventView {
  const { _id, ...rest } = record;
  return { ...rest, id: typeof _id === 'string' ? _id : _id?.toString() ?? '' };
}

function canAccessSession(
  ctx: SessionContext,
  record: IBrowserSession | null | undefined,
): record is IBrowserSession {
  return Boolean(
    record
    && record.tenantId === ctx.tenantId
    && matchesProjectScope(record.projectId, ctx.projectId),
  );
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
  if (
    !browser
    || browser.tenantId !== ctx.tenantId
    || !matchesProjectScope(browser.projectId, ctx.projectId)
  ) {
    throw new Error(`Browser not found: ${input.browserId}`);
  }
  if (browser.status !== 'active') {
    throw new Error(`Browser ${browser.key} is not active`);
  }
  // The browser's signed-in profile is the LOWEST-priority source: an
  // explicit `config.storageState` on the request wins, and passing `null`
  // clears it for one session (a flow that must start logged out).
  const storedProfile = readBrowserStorageState(browser);
  const config: IBrowserSessionConfig = {
    ...(storedProfile ? { storageState: storedProfile } : {}),
    ...(browser.defaultSessionConfig ?? {}),
    ...(input.config ?? {}),
  };
  if (input.config && 'storageState' in input.config && !input.config.storageState) {
    delete config.storageState;
  }
  const artifactBucketKey = input.artifactBucketKey ?? browser.artifactBucketKey ?? cfg.defaultArtifactBucketKey;

  // What the session ROW stores is not what the context gets. `storageState`
  // is a live login and `proxy`/`httpCredentials` carry passwords; the row is
  // read by the sessions list, the API and the UI, so the secrets stay in the
  // in-memory `config` and never reach the database.
  const persistedConfig: IBrowserSessionConfig = { ...config };
  delete persistedConfig.storageState;
  delete persistedConfig.httpCredentials;
  if (persistedConfig.proxy) {
    persistedConfig.proxy = { ...persistedConfig.proxy, password: undefined };
  }

  // Attribution is stamped at creation (request ALS in scope); the rollup
  // event is emitted once per session when it ends.
  const attribution = resolveUsageAttribution();
  const created = await db.createBrowserSession({
    userId: attribution.userId,
    apiTokenId: attribution.apiTokenId,
    actorType: attribution.actorType,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    browserId: input.browserId,
    sessionKey,
    name: input.name,
    agentId: input.agentId,
    agentKey: input.agentKey,
    status: 'pending',
    config: persistedConfig,
    artifactBucketKey,
    eventCount: 0,
    metadata: input.metadata,
    createdBy: input.createdBy,
  });

  const sessionId = created._id ? String(created._id) : '';

  try {
    await browserManager.openSession({
      tenantId: ctx.tenantId,
      tenantDbName: ctx.tenantDbName,
      projectId: ctx.projectId,
      sessionKey,
      config,
      onClose: async (reason) => {
        try {
          // The manager invokes this from its reaper timer / shutdown path —
          // outside any request tenant scope — so bind the tenant explicitly
          // (the captured `db` handle would otherwise fall back to whatever
          // tenant a concurrent request last bound).
          await runWithTenantScope(ctx.tenantDbName, async () => {
          await persistEvent(ctx, sessionId, sessionKey, 'close', {
            status: 'success',
            data: { reason },
          });
          await db.updateBrowserSession(sessionId, {
            status: reason === 'shutdown' ? 'closed' : reason === 'idle-timeout' || reason === 'max-lifetime' ? 'expired' : 'closed',
            endedAt: new Date(),
          });
          // Rollup event at session end — onClose fires exactly once for every
          // manager-side close (manual, idle, lifetime, shutdown, deleted).
          // The manager callback runs outside the request ALS, so pass the
          // attribution stamped on the row at creation.
          const row = await db.findBrowserSessionById(sessionId);
          const durationMs = row?.startedAt && row?.endedAt
            ? new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime()
            : undefined;
          recordUsageEvent({
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
            service: 'browser',
            refKey: browser.key,
            status: 'success',
            latencyMs: durationMs,
            attribution: {
              userId: row?.userId ?? attribution.userId,
              apiTokenId: row?.apiTokenId ?? attribution.apiTokenId,
              actorType: row?.actorType ?? attribution.actorType,
            },
          });
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
    // The manager session never opened, so onClose will not fire — this is
    // the session's only rollup event.
    recordUsageEvent({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      service: 'browser',
      refKey: browser.key,
      status: 'error',
      attribution: {
        userId: attribution.userId,
        apiTokenId: attribution.apiTokenId,
        actorType: attribution.actorType,
      },
    });
    throw err;
  }
}

export async function listBrowserSessions(
  ctx: SessionContext,
  filters?: {
    status?: string;
    agentId?: string;
    browserId?: string;
    search?: string;
    createdFrom?: Date;
    createdTo?: Date;
    limit?: number;
  },
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
  if (!canAccessSession(ctx, record)) return null;
  return serializeSession(record);
}

async function loadSessionForKey(
  ctx: SessionContext,
  sessionKey: string,
): Promise<{ id: string; record: IBrowserSession }> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record = await db.findBrowserSessionByKey(ctx.tenantId, sessionKey, ctx.projectId);
  if (!canAccessSession(ctx, record)) throw new Error(`Browser session not found: ${sessionKey}`);
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
  const sanitizedUrl = sanitizePersistedUrl(payload.url);
  const event = await db.createBrowserSessionEvent({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    sessionId,
    sequence,
    type,
    status: payload.status,
    url: sanitizedUrl,
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
      currentUrl: sanitizedUrl,
    })
    .catch(() => undefined);
  return serializeEvent(event);
}

export async function runBrowserAction(
  ctx: SessionContext,
  sessionKey: string,
  action: BrowserAction,
): Promise<BrowserActionResult> {
  // Look up the parent browser id so the router can use the browser's
  // assigned node. We accept a small cost of double-loading the session
  // record (here + inside the local handler) in exchange for keeping
  // routing decisions outside of browserManager.
  const { record } = await loadSessionForKey(ctx, sessionKey);
  return routeInstanceCall(
    {
      entityType: 'browser',
      entityId: browserEntityId(ctx.tenantId, record.browserId),
      jobName: 'runAction',
    },
    { ctx, sessionKey, action } as unknown as QueuePayload,
    () => runBrowserActionLocal(ctx, sessionKey, action),
  );
}

export async function runBrowserActionLocal(
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
    // `resolvedTarget` is the durable half of what the action actually hit,
    // and stamping it here is what makes the event log a RECORDING rather
    // than just an audit trail: `recordBrowserFlow` reads these back into
    // replayable steps. The raw action is redacted as before; the target is
    // a role/name description, never a value.
    data: {
      ...redactAction(action),
      ...(result.resolvedTarget ? { resolvedTarget: result.resolvedTarget } : {}),
      ...(result.targetStrategy ? { targetStrategy: result.targetStrategy } : {}),
    },
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

/**
 * Find visible text and return a DURABLE target for each hit.
 *
 * The cheap alternative to another full snapshot once the caller knows what
 * it is looking for, and the way a discovery turn produces a target that can
 * be written into a flow step.
 */
export async function searchPageText(
  ctx: SessionContext,
  sessionKey: string,
  text: string,
  options: { limit?: number } = {},
): Promise<{ ok: boolean; matches: Array<{ text: string; target: unknown }>; errorMessage?: string }> {
  await loadSessionForKey(ctx, sessionKey);
  return browserManager.findText(sessionKey, text, options);
}

/** Console messages, failed requests and the last dialog the session saw. */
export async function readSessionObservations(
  ctx: SessionContext,
  sessionKey: string,
): Promise<ReturnType<typeof browserManager.getObservations>> {
  await loadSessionForKey(ctx, sessionKey);
  return browserManager.getObservations(sessionKey);
}

/**
 * Export the session's cookies + origin storage.
 *
 * This is the "sign in once" half of unattended automation: drive a login by
 * hand, export here, attach the result to the browser profile, and every run
 * afterwards starts authenticated.
 */
export async function exportSessionStorageState(
  ctx: SessionContext,
  sessionKey: string,
): Promise<Record<string, unknown>> {
  await loadSessionForKey(ctx, sessionKey);
  return browserManager.exportStorageState(sessionKey);
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
  ctx: SessionContext,
  sessionKey: string,
  input?: BrowserScreenshotInput,
): Promise<{ buffer: Buffer; contentType: string }> {
  await loadSessionForKey(ctx, sessionKey);
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
  if (!canAccessSession(ctx, session)) return [];
  const events = await db.listBrowserSessionEvents(sessionId, options);
  return events.map(serializeEvent);
}

export async function deleteBrowserSession(
  ctx: SessionContext,
  sessionId: string,
): Promise<boolean> {
  const db = await withTenantDb(ctx.tenantDbName);
  const session = await db.findBrowserSessionById(sessionId);
  if (!canAccessSession(ctx, session)) return false;
  // Best-effort: ensure manager-side session is closed first
  await browserManager.closeSession(session.sessionKey, 'deleted').catch(() => undefined);
  return db.deleteBrowserSession(sessionId);
}

function redactAction(action: BrowserAction): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...(action as unknown as Record<string, unknown>) };
  if (typeof clone.url === 'string') {
    clone.url = sanitizePersistedUrl(clone.url);
  }
  if ('text' in clone && typeof clone.text === 'string') {
    clone.text = redactTypedText(clone.text);
  }
  return clone;
}
