import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync } from 'fastify';
import type { ProviderDomain } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { providerRegistry } from '@/lib/providers';
import type { ProviderStatus } from '@/lib/services/providers/providerService';
import {
  createFileBucket,
  createFileProvider,
  deleteFile,
  deleteFileBucket,
  downloadFile,
  getFileBucket,
  getFileRecord,
  listFileBuckets,
  listFileProviders,
  listFiles,
  uploadFile,
} from '@/lib/services/files';
import {
  isDateInDashboardRange,
  parseDashboardDateFilterFromSearchParams,
} from '@/lib/utils/dashboardDateFilter';
import {
  checkPerRequestLimits,
  checkRateLimit,
  checkResourceQuota,
} from '@/lib/quota/quotaGuard';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:files');

type FileProviderQuery = {
  driver?: string;
  status?: ProviderStatus;
};

type FileObjectsQuery = {
  cursor?: string;
  download?: string;
  limit?: string;
  search?: string;
  variant?: string;
};

function parseLimit(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.min(parsed, 200);
}

function estimateBase64Bytes(input: unknown): number | undefined {
  if (typeof input !== 'string') return undefined;
  const base64 = input.includes('base64,') ? input.split('base64,').pop() ?? '' : input;
  if (!base64) return 0;

  const normalized = base64.replace(/\s/g, '');
  const paddingMatch = normalized.match(/=+$/);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  const bytes = Math.floor((normalized.length * 3) / 4) - padding;
  return bytes > 0 ? bytes : 0;
}

function normalizeObjectKey(wildcard: string | undefined): string | null {
  if (!wildcard) {
    return null;
  }
  const joined = wildcard.trim();
  return joined.length > 0 ? joined : null;
}

export const filesApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/files/providers/drivers', withApiRequestContext(async (request, reply) => {
    try {
      const query = (request.query ?? {}) as { domain?: ProviderDomain };
      const drivers = providerRegistry.listDescriptors(query.domain ?? 'file');
      return reply.code(200).send({ drivers });
    } catch (error) {
      logger.error('List file provider drivers error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/files/providers', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as FileProviderQuery;

      const providers = await listFileProviders(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          driver: query.driver,
          status: query.status,
        },
      );

      return reply.code(200).send({ providers });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/files/providers', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const requiredFields = ['key', 'driver', 'label', 'credentials'];

      for (const field of requiredFields) {
        if (body[field] === undefined || body[field] === null || body[field] === '') {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }

      const provider = await createFileProvider(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          capabilitiesOverride: body.capabilitiesOverride as string[] | undefined,
          createdBy: session.userId,
          credentials: body.credentials as Record<string, unknown>,
          description: body.description as string | undefined,
          driver: body.driver as string,
          key: body.key as string,
          label: body.label as string,
          metadata: body.metadata as Record<string, unknown> | undefined,
          settings: body.settings as Record<string, unknown> | undefined,
          status: body.status as ProviderStatus | undefined,
        },
      );

      return reply.code(201).send({ provider });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/files/dashboard', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const buckets = await listFileBuckets(
        session.tenantDbName,
        session.tenantId,
        projectId,
      );

      const filter = parseDashboardDateFilterFromSearchParams(
        new URLSearchParams(request.query as Record<string, string>),
      );

      const scopedBuckets = buckets.filter((bucket) =>
        isDateInDashboardRange(bucket.createdAt, filter),
      );
      const activeBuckets = scopedBuckets.filter((item) => item.status === 'active').length;
      const disabledBuckets = scopedBuckets.filter((item) => item.status === 'disabled').length;

      const providerMap = new Map<string, { active: number; count: number }>();
      for (const bucket of scopedBuckets) {
        const current = providerMap.get(bucket.providerKey) ?? { active: 0, count: 0 };
        providerMap.set(bucket.providerKey, {
          active: current.active + (bucket.status === 'active' ? 1 : 0),
          count: current.count + 1,
        });
      }

      const providerBreakdown = Array.from(providerMap.entries()).map(([providerKey, summary]) => ({
        active: summary.active,
        count: summary.count,
        providerKey,
      }));

      const recentBuckets = [...scopedBuckets]
        .sort((a, b) => {
          const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return tb - ta;
        })
        .slice(0, 6)
        .map((bucket) => ({
          createdAt: bucket.createdAt,
          key: bucket.key,
          name: bucket.name,
          providerKey: bucket.providerKey,
          status: bucket.status,
        }));

      return reply.code(200).send({
        overview: {
          activeBuckets,
          disabledBuckets,
          totalBuckets: scopedBuckets.length,
        },
        providerBreakdown,
        recentBuckets,
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/files/buckets', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const buckets = await listFileBuckets(
        session.tenantDbName,
        session.tenantId,
        projectId,
      );

      return reply.code(200).send({ buckets });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/files/buckets', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const licenseType = session.licenseType as LicenseType;
      const requiredFields = ['key', 'name', 'providerKey'];

      for (const field of requiredFields) {
        const value = body[field];
        if (!value || (typeof value === 'string' && value.trim() === '')) {
          return reply.code(400).send({ error: `${field} is required` });
        }
      }

      const existingBuckets = await listFileBuckets(
        session.tenantDbName,
        session.tenantId,
        projectId,
      );

      const quotaCheck = await checkResourceQuota(
        {
          domain: 'file',
          licenseType,
          projectId,
          providerKey: body.providerKey as string,
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          userId: session.userId,
        },
        'fileBuckets',
        existingBuckets.length,
      );

      if (!quotaCheck.allowed) {
        return reply.code(429).send({
          error: quotaCheck.reason || 'File bucket quota exceeded',
        });
      }

      const bucket = await createFileBucket(
        session.tenantDbName,
        session.tenantId,
        projectId,
        {
          createdBy: session.userId,
          description: body.description as string | undefined,
          key: body.key as string,
          metadata: body.metadata as Record<string, unknown> | undefined,
          name: body.name as string,
          prefix: body.prefix as string | undefined,
          providerKey: body.providerKey as string,
          status: body.status as 'active' | 'disabled' | undefined,
        },
      );

      return reply.code(201).send({ bucket });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/files/buckets/:bucketKey', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const bucket = await getFileBucket(
        session.tenantDbName,
        session.tenantId,
        projectId,
        bucketKey,
      );

      return reply.code(200).send({ bucket });
    } catch (error) {
      if (error instanceof Error && error.message === 'File bucket not found.') {
        return reply.code(404).send({ error: 'Bucket not found' });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.delete('/files/buckets/:bucketKey', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const query = (request.query ?? {}) as { force?: string };
      const { projectId, session } = await requireProjectContextForRequest(request);

      const deleted = await deleteFileBucket(
        session.tenantDbName,
        session.tenantId,
        projectId,
        bucketKey,
        { force: query.force === 'true' },
      );

      if (!deleted) {
        return reply.code(404).send({ error: 'Bucket not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'Bucket contains files. Remove files or use force delete.'
      ) {
        return reply.code(409).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/files/buckets/:bucketKey/objects', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as FileObjectsQuery;

      const scoped = await listFiles(session.tenantDbName, session.tenantId, projectId, {
        bucketKey,
        cursor: query.cursor || undefined,
        limit: parseLimit(query.limit) ?? 50,
        search: query.search || undefined,
      });

      return reply.code(200).send({
        items: scoped.items,
        nextCursor: scoped.nextCursor,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'File bucket not found.') {
        return reply.code(404).send({ error: 'Bucket not found' });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.post('/files/buckets/:bucketKey/objects', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const licenseType = session.licenseType as LicenseType;

      if (!body.fileName || typeof body.fileName !== 'string') {
        return reply.code(400).send({ error: 'fileName is required' });
      }
      if (!body.data || typeof body.data !== 'string') {
        return reply.code(400).send({ error: 'data is required' });
      }

      const estimatedFileBytes = estimateBase64Bytes(body.data) ?? 0;
      const quotaContext = {
        domain: 'file' as const,
        licenseType,
        projectId,
        providerKey: (body.providerKey as string | undefined) ?? undefined,
        resourceKey: bucketKey,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        userId: session.userId,
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
        return reply.code(429).send({
          error: rateLimitResult.reason || 'Rate limit exceeded',
        });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);
      const currentFilesTotal = await db.countFileRecords({ projectId });
      const resourceCheck = await checkResourceQuota(
        quotaContext,
        'filesTotal',
        currentFilesTotal,
      );

      if (!resourceCheck.allowed) {
        return reply.code(429).send({
          error: resourceCheck.reason || 'File quota exceeded',
        });
      }

      const storageLimit = quotaResult.effectiveLimits.quotas?.maxStorageBytes;
      if (storageLimit !== undefined && storageLimit !== -1) {
        const currentBytes = await db.sumFileRecordBytes({ projectId });
        const projected = currentBytes + estimatedFileBytes;
        if (projected > storageLimit) {
          return reply.code(429).send({
            error: `storageBytes limit exceeded (${projected}/${storageLimit})`,
          });
        }
      }

      const result = await uploadFile(session.tenantDbName, session.tenantId, projectId, {
        bucketKey,
        contentType: body.contentType as string | undefined,
        convertToMarkdown: body.convertToMarkdown !== false,
        createdBy: session.userId,
        data: body.data as string,
        fileName: body.fileName as string,
        keyHint: body.keyHint as string | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
        providerKey: (body.providerKey as string | undefined) ?? undefined,
      });

      return reply.code(201).send({ record: result.record });
    } catch (error) {
      if (
        error instanceof Error
        && (
          error.message === 'File bucket not found.'
          || error.message === 'File bucket is not active.'
        )
      ) {
        return reply.code(404).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/files/buckets/:bucketKey/objects/*', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const wildcard = (request.params as Record<string, string>)['*'];
      const key = normalizeObjectKey(wildcard);

      if (!key) {
        return reply.code(400).send({ error: 'Object key is required' });
      }

      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as FileObjectsQuery;

      if (query.download) {
        const variant = query.download === 'markdown' || query.variant === 'markdown'
          ? 'markdown'
          : 'original';
        const result = await downloadFile(
          session.tenantDbName,
          session.tenantId,
          projectId,
          bucketKey,
          key,
          { variant },
        );

        const buffer = Buffer.from(result.data as Uint8Array);
        reply.code(200).type(result.contentType ?? 'application/octet-stream');
        if (typeof result.size === 'number') {
          reply.header('Content-Length', String(result.size));
        }
        reply.header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(result.fileName)}"`,
        );
        return reply.send(buffer);
      }

      const record = await getFileRecord(
        session.tenantDbName,
        session.tenantId,
        projectId,
        bucketKey,
        key,
      );

      return reply.code(200).send({ record });
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'Markdown conversion not available for this file.'
      ) {
        return reply.code(409).send({ error: error.message });
      }
      if (
        error instanceof Error
        && (
          error.message === 'File record not found.'
          || error.message === 'File bucket not found.'
        )
      ) {
        return reply.code(404).send({ error: 'File not found' });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.delete('/files/buckets/:bucketKey/objects/*', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const wildcard = (request.params as Record<string, string>)['*'];
      const key = normalizeObjectKey(wildcard);

      if (!key) {
        return reply.code(400).send({ error: 'Object key is required' });
      }

      const { projectId, session } = await requireProjectContextForRequest(request);
      const deleted = await deleteFile(
        session.tenantDbName,
        session.tenantId,
        projectId,
        bucketKey,
        key,
        session.userId,
      );

      if (!deleted) {
        return reply.code(404).send({ error: 'File not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message === 'File record not found.') {
        return reply.code(404).send({ error: 'File not found' });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));
};
