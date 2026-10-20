import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { ProviderStatus } from '@/lib/services/providers/providerService';
import {
  composeUploadKeyHint,
  createFileProvider,
  deleteFile,
  downloadFile,
  getFileBucket,
  getFileRecord,
  listFileBuckets,
  listFileProviders,
  listFiles,
  uploadFile,
} from '@/lib/services/files';
import {
  checkPerRequestLimits,
  checkRateLimit,
  checkResourceQuota,
} from '@/lib/quota/quotaGuard';
import { bucketInactiveError, isFileServiceError } from '@/lib/services/files/errors';
import { uploadBodyLimit } from '@/lib/services/files/uploadLimits';
import { toHeaderSafeJson } from '@/lib/utils/headerSafeJson';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  readJsonObjectBody,
  withClientApiRequestContext,
} from '../fastify-utils';
import { sendProviderConfigError } from '../providerConfigErrors';
import { sendFileError, setFileDownloadHeaders, uploadRouteErrorHandler, type FileErrorOptions } from '../fileHttp';
import { refuseSessionLinked, sendClientListUnavailable, sendClientSessionRefusal, type SessionActor } from './agent-session-access';
import { listVisibleFiles, sessionOfFile } from './session-linked-files';

/** The caller of a client route, as the session checks name them: the token's owner, in the token's project. */
const actorOf = (ctx: { tenantDbName: string; projectId: string; tokenRecord: { userId?: string } }): SessionActor => ({
  tenantDbName: ctx.tenantDbName,
  projectId: ctx.projectId,
  userId: String(ctx.tokenRecord.userId ?? ''),
});

const logger = createLogger('api:client-files');

function estimateBase64Bytes(input: unknown): number | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }

  const base64 = input.includes('base64,') ? input.split('base64,').pop() ?? '' : input;
  if (!base64) {
    return 0;
  }

  const normalized = base64.replace(/\s/g, '');
  const paddingMatch = normalized.match(/=+$/);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  const bytes = Math.floor((normalized.length * 3) / 4) - padding;
  return bytes > 0 ? bytes : 0;
}

/** A failed call, answered the way the Document Store answers it (status, code and a safe message). */
function fail(reply: FastifyReply, error: unknown, action: string, options: FileErrorOptions = {}) {
  return sendFileError(reply, error, { logger, action, ...options });
}

export const clientFilesApiPlugin: FastifyPluginAsync = async (app) => {
  // A file travels base64-encoded in a JSON body, so an upload request is a third larger than the file: the route
  // takes a body up to the configured file limit plus that, and answers a larger one as a file that is too large.
  const uploadRoute = { bodyLimit: uploadBodyLimit(), errorHandler: uploadRouteErrorHandler };

  app.get('/client/v1/files/providers', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { driver?: string; status?: ProviderStatus };
      const providers = await listFileProviders(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        driver: query.driver,
        status: query.status,
      });

      return reply.code(200).send({ providers });
    } catch (error) {
      return fail(reply, error, 'list providers');
    }
  }));

  app.post('/client/v1/files/providers', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      for (const field of ['key', 'driver', 'label', 'credentials']) {
        if (body[field] === undefined || body[field] === null || body[field] === '') {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }

      const provider = await createFileProvider(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        capabilitiesOverride: body.capabilitiesOverride as string[] | undefined,
        createdBy: ctx.tokenRecord.userId,
        credentials: body.credentials as Record<string, unknown>,
        description: body.description as string | undefined,
        driver: body.driver as string,
        key: body.key as string,
        label: body.label as string,
        metadata: body.metadata as Record<string, unknown> | undefined,
        settings: body.settings as Record<string, unknown> | undefined,
        status: body.status as ProviderStatus | undefined,
      });

      return reply.code(201).send({ provider });
    } catch (error) {
      if (sendProviderConfigError(reply, error)) return reply;
      logger.error('Create client file provider error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/files/buckets', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const buckets = await listFileBuckets(ctx.tenantDbName, ctx.tenantId, ctx.projectId);
      return reply.code(200).send({
        buckets,
        count: buckets.length,
      });
    } catch (error) {
      return fail(reply, error, 'list buckets');
    }
  }));

  app.get('/client/v1/files/buckets/:bucketKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { bucketKey } = request.params as { bucketKey: string };
      const bucket = await getFileBucket(ctx.tenantDbName, ctx.tenantId, ctx.projectId, bucketKey);

      if (!bucket) {
        return reply.code(404).send({ error: 'Bucket not found' });
      }

      return reply.code(200).send({ bucket });
    } catch (error) {
      return fail(reply, error, 'read bucket');
    }
  }));

  app.get('/client/v1/files/buckets/:bucketKey/objects', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { bucketKey } = request.params as { bucketKey: string };
      const query = (request.query ?? {}) as { cursor?: string; limit?: string; prefix?: string; purpose?: string; search?: string };
      // `prefix` (even empty) = list one folder: its files, and its sub-folders in `folders`.
      // The files a session holds are the session's: those of somebody else's session the token's owner may not
      // view are left out, and the page is filled from the following reads rather than cut short (a caller who
      // may view every session costs one plain read and no lookup).
      const limit = query.limit ? Number.parseInt(query.limit, 10) : 50;
      const visible = await listVisibleFiles(request, {
        cursor: query.cursor || undefined,
        limit: Number.isInteger(limit) && limit > 0 ? limit : 50,
        actor: actorOf(ctx),
        read: (cursor, size) => listFiles(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
          bucketKey,
          cursor,
          limit: size,
          search: query.search,
          ...(typeof query.prefix === 'string' ? { prefix: query.prefix } : {}),
          ...(query.purpose === 'conversation' || query.purpose === 'other' ? { purpose: query.purpose } : {}),
        }),
      });
      return reply.code(200).send({
        count: visible.items.length,
        files: visible.items,
        ...(visible.folders ? { folders: visible.folders, prefix: visible.prefix } : {}),
        nextCursor: visible.nextCursor,
      });
    } catch (error) {
      const unavailable = sendClientListUnavailable(reply, request, error);
      if (unavailable) return unavailable;
      return fail(reply, error, 'list objects');
    }
  }));

  app.post('/client/v1/files/buckets/:bucketKey/objects', uploadRoute, withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { bucketKey } = request.params as { bucketKey: string };
      const body = readJsonObjectBody(request);

      if (typeof body.fileName !== 'string') {
        return reply.code(400).send({ error: 'fileName is required' });
      }
      if (typeof body.data !== 'string') {
        return reply.code(400).send({ error: 'data is required (base64 or data URL)' });
      }
      // The same destination rules as the Document Store: no "." / ".." segments, no control characters.
      const destination = composeUploadKeyHint({ keyHint: body.keyHint });
      if ('error' in destination) return reply.code(400).send({ error: destination.error });

      // The bucket first: the quotas below are those of its provider, and a bucket that is missing or switched
      // off is refused before any of them is spent.
      const bucket = await getFileBucket(ctx.tenantDbName, ctx.tenantId, ctx.projectId, bucketKey);
      if (bucket.status !== 'active') throw bucketInactiveError();

      const tokenId = ctx.tokenRecord._id?.toString() ?? ctx.token;
      const estimatedFileBytes = estimateBase64Bytes(body.data);
      const quotaContext = {
        domain: 'file' as const,
        licenseType: ctx.tenant.licenseType as LicenseType,
        projectId: ctx.projectId,
        providerKey: bucket.providerKey,
        resourceKey: bucketKey,
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        tokenId,
        userId: ctx.user?._id?.toString(),
      };

      const quotaResult = await checkPerRequestLimits(quotaContext, {
        fileSize: estimatedFileBytes,
        filesPerRequest: 1,
      });
      if (!quotaResult.allowed) {
        return reply.code(429).send({ error: quotaResult.reason || 'Quota exceeded' });
      }

      const rateLimitResult = await checkRateLimit(quotaContext, {
        files: 1,
        requests: 1,
        storageBytes: estimatedFileBytes ?? 0,
      });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({ error: rateLimitResult.reason || 'Rate limit exceeded' });
      }

      const db = await getDatabase();
      await db.switchToTenant(ctx.tenantDbName);
      const currentFilesTotal = await db.countFileRecords({ projectId: ctx.projectId });
      const resourceCheck = await checkResourceQuota(quotaContext, 'filesTotal', currentFilesTotal);
      if (!resourceCheck.allowed) {
        return reply.code(429).send({ error: resourceCheck.reason || 'File quota exceeded' });
      }

      const storageLimit = quotaResult.effectiveLimits.quotas?.maxStorageBytes;
      if (storageLimit !== undefined && storageLimit !== -1) {
        const currentBytes = await db.sumFileRecordBytes({ projectId: ctx.projectId });
        const projected = currentBytes + (estimatedFileBytes ?? 0);
        if (projected > storageLimit) {
          return reply.code(429).send({
            error: `storageBytes limit exceeded (${projected}/${storageLimit})`,
          });
        }
      }

      const result = await uploadFile(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        bucketKey,
        contentType: body.contentType as string | undefined,
        convertToMarkdown: (body.convertToMarkdown as boolean | undefined) ?? false,
        createdBy: ctx.user?._id?.toString() ?? 'api',
        data: body.data,
        fileName: body.fileName,
        keyHint: destination.keyHint,
        metadata: body.metadata as Record<string, unknown> | undefined,
      });

      return reply.code(201).send({
        file: result.record,
        message: 'File uploaded successfully',
      });
    } catch (error) {
      return fail(reply, error, 'upload', { storage: true, body: true });
    }
  }));

  app.get('/client/v1/files/buckets/:bucketKey/objects/:objectKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { bucketKey, objectKey } = request.params as { bucketKey: string; objectKey: string };
      const file = await getFileRecord(ctx.tenantDbName, ctx.tenantId, ctx.projectId, bucketKey, objectKey);

      if (!file) {
        return reply.code(404).send({ error: 'File not found' });
      }
      // A file a session holds is read as the session it belongs to.
      const refusal = await refuseSessionLinked(request, sessionOfFile(file), 'view', { actor: actorOf(ctx) });
      if (refusal) return sendClientSessionRefusal(reply, request, refusal);

      return reply.code(200).send({ file });
    } catch (error) {
      return fail(reply, error, 'read object');
    }
  }));

  app.delete('/client/v1/files/buckets/:bucketKey/objects/:objectKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { bucketKey, objectKey } = request.params as { bucketKey: string; objectKey: string };
      // Deleting a file a session holds is acting on the session. (A store that fails here fails the request:
      // not knowing whether the file belongs to a session is not a reason to let the delete through.)
      const existing = await getFileRecord(ctx.tenantDbName, ctx.tenantId, ctx.projectId, bucketKey, objectKey);
      const refusal = await refuseSessionLinked(request, sessionOfFile(existing), 'manage', { actor: actorOf(ctx) });
      if (refusal) return sendClientSessionRefusal(reply, request, refusal);
      await deleteFile(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        bucketKey,
        objectKey,
        ctx.user?._id?.toString() ?? 'api',
      );

      return reply.code(200).send({
        bucketKey,
        message: 'File deleted successfully',
        objectKey,
      });
    } catch (error) {
      return fail(reply, error, 'delete object', { storage: true });
    }
  }));

  app.get('/client/v1/files/buckets/:bucketKey/objects/:objectKey/download', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { bucketKey, objectKey } = request.params as { bucketKey: string; objectKey: string };
      const query = (request.query ?? {}) as { variant?: 'markdown' | 'original' };
      const variant = query.variant ?? 'original';

      if (variant !== 'original' && variant !== 'markdown') {
        return reply.code(400).send({ error: 'Invalid variant. Must be "original" or "markdown"' });
      }

      // A file a session holds is read as the session it belongs to.
      const wanted = await getFileRecord(ctx.tenantDbName, ctx.tenantId, ctx.projectId, bucketKey, objectKey);
      const refusal = await refuseSessionLinked(request, sessionOfFile(wanted), 'view', { actor: actorOf(ctx) });
      if (refusal) return sendClientSessionRefusal(reply, request, refusal);

      const result = await downloadFile(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        bucketKey,
        objectKey,
        { variant },
      );

      reply
        .header('Content-Type', result.contentType ?? 'application/octet-stream')
        .header('Content-Length', String(result.size ?? result.data.length));
      setFileDownloadHeaders(reply, result.fileName, 'attachment');

      if (result.etag) {
        reply.header('ETag', result.etag);
      }

      if (result.metadata) {
        try {
          // A header value is ASCII: metadata in any language travels as \uXXXX escapes, which JSON.parse reads back.
          reply.header('X-File-Metadata', toHeaderSafeJson(result.metadata));
        } catch (error) {
          logger.warn('Failed to serialize client file metadata', { error });
        }
      }

      return reply.code(200).send(Buffer.from(result.data));
    } catch (error) {
      // The client API has always answered a Markdown copy that does not exist with 400 (the Document Store: 409).
      if (isFileServiceError(error) && error.code === 'markdown_unavailable') {
        return reply.code(400).send({ error: error.message, code: error.code });
      }
      return fail(reply, error, 'download', { storage: true });
    }
  }));
};
