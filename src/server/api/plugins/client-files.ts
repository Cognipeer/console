import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync } from 'fastify';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { ProviderStatus } from '@/lib/services/providers/providerService';
import {
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
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

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

export const clientFilesApiPlugin: FastifyPluginAsync = async (app) => {
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
      logger.error('List client file providers error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
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
      logger.error('List client file buckets error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to list buckets',
      });
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
      logger.error('Get client file bucket error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to get bucket',
      });
    }
  }));

  app.get('/client/v1/files/buckets/:bucketKey/objects', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { bucketKey } = request.params as { bucketKey: string };
      const query = (request.query ?? {}) as { cursor?: string; limit?: string; search?: string };
      const result = await listFiles(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        bucketKey,
        cursor: query.cursor,
        limit: query.limit ? Number.parseInt(query.limit, 10) : 50,
        search: query.search,
      });

      return reply.code(200).send({
        count: result.items.length,
        files: result.items,
        nextCursor: result.nextCursor,
      });
    } catch (error) {
      logger.error('List client file objects error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to list files',
      });
    }
  }));

  app.post('/client/v1/files/buckets/:bucketKey/objects', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { bucketKey } = request.params as { bucketKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.fileName !== 'string') {
        return reply.code(400).send({ error: 'fileName is required' });
      }
      if (typeof body.data !== 'string') {
        return reply.code(400).send({ error: 'data is required (base64 or data URL)' });
      }

      const tokenId = ctx.tokenRecord._id?.toString() ?? ctx.token;
      const estimatedFileBytes = estimateBase64Bytes(body.data);
      const quotaContext = {
        domain: 'file' as const,
        licenseType: ctx.tenant.licenseType as LicenseType,
        projectId: ctx.projectId,
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
        keyHint: body.keyHint as string | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
      });

      return reply.code(201).send({
        file: result.record,
        message: 'File uploaded successfully',
      });
    } catch (error) {
      logger.error('Upload client file error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to upload file',
      });
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

      return reply.code(200).send({ file });
    } catch (error) {
      logger.error('Get client file error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to get file',
      });
    }
  }));

  app.delete('/client/v1/files/buckets/:bucketKey/objects/:objectKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { bucketKey, objectKey } = request.params as { bucketKey: string; objectKey: string };
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
      logger.error('Delete client file error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to delete file',
      });
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
        .header('Content-Length', String(result.size ?? result.data.length))
        .header('Content-Disposition', `attachment; filename="${encodeURIComponent(result.fileName)}"`);

      if (result.etag) {
        reply.header('ETag', result.etag);
      }

      if (result.metadata) {
        try {
          reply.header('X-File-Metadata', JSON.stringify(result.metadata));
        } catch (error) {
          logger.warn('Failed to serialize client file metadata', { error });
        }
      }

      return reply.code(200).send(Buffer.from(result.data));
    } catch (error) {
      logger.error('Download client file error', { error });
      const message = error instanceof Error ? error.message : 'Failed to download file';
      if (message.includes('not found') || message.includes('does not exist')) {
        return reply.code(404).send({ error: 'File not found' });
      }
      if (message.includes('markdown not available') || message.includes('conversion')) {
        return reply.code(400).send({ error: message });
      }
      return reply.code(500).send({ error: message });
    }
  }));
};
