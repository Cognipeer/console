import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
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
import { isOwnerOrAdmin } from '@/lib/services/users/peoplePolicy';
import { clientGone } from '../clientGone';
import { parseExtractionBody } from '@/lib/services/files/markdownExtraction';
import { decodedByteLength } from '@/lib/services/files/payloadSize';
import { uploadBodyLimit } from '@/lib/services/files/uploadLimits';
import { toHeaderSafeJson } from '@/lib/utils/headerSafeJson';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  readJsonObjectBody,
  withClientApiRequestContext,
} from '../fastify-utils';
import { sendProviderConfigError } from '../providerConfigErrors';
import { isUploadMetadata, sendFileError, setFileDownloadHeaders, uploadRouteErrorHandler, type FileErrorOptions } from '../fileHttp';
import { ragFileGuard, withoutHiddenFiles } from '../ragOwnedResources';
import { refuseSessionLinked, sendClientListUnavailable, sendClientSessionRefusal, type SessionActor } from './agent-session-access';
import { listVisibleFiles, sessionOfFile, sessionRefusedForUpload } from './session-linked-files';

/** The caller of a client route, as the session checks name them: the token's owner, in the token's project. */
const actorOf = (ctx: { tenantDbName: string; projectId: string; tokenRecord: { userId?: string } }): SessionActor => ({
  tenantDbName: ctx.tenantDbName,
  projectId: ctx.projectId,
  userId: String(ctx.tokenRecord.userId ?? ''),
});

const logger = createLogger('api:client-files');

/**
 * The objects of a knowledge base with access control are read through the knowledge base: an API token never
 * administers one, so for a client those objects are not there. See `ragOwnedResources`.
 */
const kbFilesOf = (request: FastifyRequest, ctx: { tenantDbName: string; tenantId: string; projectId: string }) =>
  ragFileGuard(request, { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId });

/** The most the `X-File-Metadata` header carries: clients read at most 16 KB of response headers, all of them together. */
const FILE_METADATA_HEADER_MAX_CHARS = 8 * 1024;

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
        // The files permission is enough to create a provider here, but naming a directory of this server (the base
        // directory of the local disk driver) is for owners and admins, the role of the person the call acts for.
        allowHostPaths: isOwnerOrAdmin(ctx.user?.role),
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
      // may view every session costs one plain read and no lookup). The objects of a knowledge base with access
      // control are left out the same way.
      const limit = query.limit ? Number.parseInt(query.limit, 10) : 50;
      const visible = await listVisibleFiles(request, {
        cursor: query.cursor || undefined,
        limit: Number.isInteger(limit) && limit > 0 ? limit : 50,
        actor: actorOf(ctx),
        read: withoutHiddenFiles(kbFilesOf(request, ctx), (cursor, size) => listFiles(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
          bucketKey,
          cursor,
          limit: size,
          search: query.search,
          ...(typeof query.prefix === 'string' ? { prefix: query.prefix } : {}),
          ...(query.purpose === 'conversation' || query.purpose === 'other' ? { purpose: query.purpose } : {}),
        })),
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
      // An empty string is content too: an empty file (a placeholder, a marker) is stored as it is. (The Document
      // Store's own upload asks for a file to have bytes; this API is called by programs that may not.)
      if (typeof body.data !== 'string') {
        return reply.code(400).send({ error: 'data is required (base64 or data URL)' });
      }
      // Metadata is a set of named values: a text or a list would be stored as something other than what was sent.
      if (!isUploadMetadata(body.metadata)) {
        return reply.code(400).send({ error: 'metadata must be an object' });
      }
      // The same destination rules as the Document Store: no "." / ".." segments, no control characters.
      const destination = composeUploadKeyHint({ keyHint: body.keyHint });
      if ('error' in destination) return reply.code(400).send({ error: destination.error });
      // Optional OCR settings for the Markdown copy (`ocr`, `images`; used with `convertToMarkdown: true`).
      const extraction = await parseExtractionBody(body, { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId });
      if ('error' in extraction) return reply.code(400).send({ error: extraction.error });

      // The bucket first: the quotas below are those of its provider, and a bucket that is missing or switched
      // off is refused before any of them is spent.
      const bucket = await getFileBucket(ctx.tenantDbName, ctx.tenantId, ctx.projectId, bucketKey);
      if (bucket.status !== 'active') throw bucketInactiveError();

      // Before any quota is spent: bytes written under the key of a session's file are the session's to allow. The
      // token acts as its owner, who is held to the sessions they may change like anybody else.
      const sessionRefusal = await sessionRefusedForUpload(request, {
        tenantDbName: ctx.tenantDbName,
        projectId: ctx.projectId,
        bucket,
        keyHint: destination.keyHint,
        fileName: body.fileName,
        actor: actorOf(ctx),
      });
      if (sessionRefusal) return sendClientSessionRefusal(reply, request, sessionRefusal);

      const tokenId = ctx.tokenRecord._id?.toString() ?? ctx.token;
      // What the service will decode from `data`, not what the text claims: the quotas below are asked about it.
      const estimatedFileBytes = decodedByteLength(body.data);
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
        storageBytes: estimatedFileBytes,
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
        const projected = currentBytes + estimatedFileBytes;
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
        ...(extraction.extraction ? { extraction: extraction.extraction } : {}),
        // A client that goes away stops the OCR run it was waiting for.
        ...(extraction.extraction?.ocr ? { signal: clientGone(reply) } : {}),
        metadata: (body.metadata ?? undefined) as Record<string, unknown> | undefined,
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
      // A file of a knowledge base with access control is not there for a client: it is read through the knowledge base.
      await kbFilesOf(request, ctx).assertVisible(file);
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

      // A file a session holds is read as the session it belongs to, and a file of a knowledge base with access
      // control is not there for a client.
      const wanted = await getFileRecord(ctx.tenantDbName, ctx.tenantId, ctx.projectId, bucketKey, objectKey);
      await kbFilesOf(request, ctx).assertVisible(wanted);
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

      // The file's own metadata, as it was stored with the record: the same on every driver. (A store keeps its own
      // spelling of it on the object - S3 lower-cases and re-encodes the names and adds a checksum.)
      const metadata = wanted.metadata;
      if (metadata && Object.keys(metadata).length > 0) {
        try {
          // A header value is ASCII: metadata in any language travels as \uXXXX escapes, which JSON.parse reads back.
          const serialized = toHeaderSafeJson(metadata);
          if (serialized.length <= FILE_METADATA_HEADER_MAX_CHARS) {
            reply.header('X-File-Metadata', serialized);
          } else {
            // A header much larger than this is refused by the client that reads the response; the record has the metadata.
            logger.warn('File metadata is too large for a header and was left out of the download', { size: serialized.length });
          }
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
