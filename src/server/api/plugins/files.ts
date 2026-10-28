import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ProviderDomain } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { isFileTypeFilter } from '@/lib/database/fileTypeFilter';
import { withUploaderNames } from '@/lib/services/users/userDisplayNames';
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
  listFiles,
  updateFileBucket,
  uploadFile,
  composeUploadKeyHint,
} from '@/lib/services/files';
import { ARCHIVE_MAX_FILES, createFilesArchive } from '@/lib/services/files/archive';
import { parseBucketPatch } from '@/lib/services/files/bucketRules';
import { bucketInactiveError, FileServiceError } from '@/lib/services/files/errors';
import { BATCH_MAX_KEYS, deleteFileRecords, findFileRecordsByKeys } from '@/lib/services/files/fileBatch';
import { getFileLimits } from '@/lib/services/files/fileLimits';
import { getFileBucketDetail, listFileBucketItems, listFileProviderItems } from '@/lib/services/files/fileReads';
import { IMPORT_DEFAULT_LIMIT, IMPORT_MAX_LIMIT, importFromStorage } from '@/lib/services/files/importFromStorage';
import { startBucketDeletion } from '@/lib/services/files/jobs/bucketDeletion';
import { bucketHoldsSourcesBody, findModulesKeepingSourcesIn } from '@/lib/services/files/knowledgeSources';
import { queueMarkdownConversion } from '@/lib/services/files/jobs/markdownConversion';
import { parseExtractionBody } from '@/lib/services/files/markdownExtraction';
import { decodedByteLength } from '@/lib/services/files/payloadSize';
import { assertPreviewSize, planPreview } from '@/lib/services/files/preview';
import type { FileRecordView } from '@/lib/services/files/types';
import { uploadBodyLimit } from '@/lib/services/files/uploadLimits';
import { authz } from '@/lib/iam/routeAuthz';
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
  bucketInUseBody,
  findAgentsUsingBucket,
} from '@/lib/services/agents/sessionFilesBucket';
import {
  readJsonBody,
  readJsonObjectBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  serviceLevelForRequest,
  withApiRequestContext,
} from '../fastify-utils';
import { sendProviderConfigError } from '../providerConfigErrors';
import { isUploadMetadata, sendFileError, setFileDownloadHeaders, uploadRouteErrorHandler, type FileErrorOptions } from '../fileHttp';
import {
  SESSION_FORBIDDEN_MESSAGE,
  refuseSessionLinked,
  sendSessionRefusal,
  sessionActorOf,
  type SessionAction,
  type SessionRefusal,
} from './agent-session-access';
import { listVisibleFiles, sessionOfFile, sessionRefusedForUpload } from './session-linked-files';

const logger = createLogger('api:files');

/**
 * Session files name their agent by key; the page of a session is addressed by the
 * agent's `_id`. Each distinct key is looked up once. A lookup that fails, or an
 * agent that is gone, leaves the row without `agentId` — the listing never fails
 * for it.
 */
async function withAgentIds<T extends { purpose?: string; agentKey?: string }>(
  tenantDbName: string,
  projectId: string,
  records: T[],
): Promise<Array<T & { agentId?: string }>> {
  const keys = [...new Set(records.filter((record) => record.purpose === 'conversation' && record.agentKey).map((record) => record.agentKey!))];
  if (keys.length === 0) return records;
  const ids = new Map<string, string>();
  try {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    for (const key of keys) {
      const agent = await db.findAgentByKey(key, projectId);
      if (agent) ids.set(key, String(agent._id));
    }
  } catch (error) {
    logger.warn('Could not resolve the agents of session files', { error: error instanceof Error ? error.message : String(error) });
  }
  return records.map((record) => {
    const agentId = record.purpose === 'conversation' && record.agentKey ? ids.get(record.agentKey) : undefined;
    return agentId ? { ...record, agentId } : record;
  });
}

type FileProviderQuery = {
  driver?: string;
  status?: ProviderStatus;
};

type FileObjectsQuery = {
  cursor?: string;
  download?: string;
  limit?: string;
  prefix?: string;
  preview?: string;
  purpose?: string;
  search?: string;
  type?: string;
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

/** A missing bucket is the handlers' 404; the in-use guard only speaks for one that exists. */
async function bucketExists(tenantDbName: string, tenantId: string, projectId: string, bucketKey: string): Promise<boolean> {
  return getFileBucket(tenantDbName, tenantId, projectId, bucketKey).then(() => true, () => false);
}

/** A failed call: the project-context and permission refusals first, then the file service's own. */
function fail(reply: FastifyReply, error: unknown, action: string, options: FileErrorOptions = {}) {
  return sendProjectContextError(reply, error)
    ?? sendFileError(reply, error, { logger, action, ...options });
}

function normalizeObjectKey(wildcard: string | undefined): string | null {
  if (!wildcard) {
    return null;
  }
  const joined = wildcard.trim();
  return joined.length > 0 ? joined : null;
}

const MAX_OBJECT_KEY_LENGTH = 1024;

function invalidRequest(message: string): FileServiceError {
  return new FileServiceError('invalid_request', 400, message);
}

/** The key a body names a file by: text, at least one character, no longer than a key can be. */
function readObjectKey(value: unknown, field: string): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key === '' || key.length > MAX_OBJECT_KEY_LENGTH) {
    throw invalidRequest(`${field} must be a file key of at most ${MAX_OBJECT_KEY_LENGTH} characters.`);
  }
  return key;
}

/** The `keys` of a batch body: a list of 1 to `max` file keys, each named once. */
function readObjectKeys(body: Record<string, unknown>, max: number): string[] {
  const raw = body.keys;
  if (!Array.isArray(raw) || raw.length === 0) throw invalidRequest('keys must be a list of file keys.');
  if (raw.length > max) throw invalidRequest(`keys can name at most ${max} files.`);
  return [...new Set(raw.map((key) => readObjectKey(key, 'every key')))];
}

/**
 * The JSON object of the body. `readJsonObjectBody` lets a list through, and a list is no object: for a route whose
 * fields are all optional it would pass as "nothing to change".
 */
function readBodyObject(request: FastifyRequest): Record<string, unknown> {
  const body = readJsonObjectBody(request);
  if (Array.isArray(body)) throw new SyntaxError('Request body must be a JSON object');
  return body;
}

/** A body whose fields are all optional: none at all is as good as `{}`; one that is not a JSON object is refused. */
function readOptionalJsonObjectBody(request: FastifyRequest): Record<string, unknown> {
  const { body } = request;
  if (body === undefined || body === null || body === '') return {};
  return readBodyObject(request);
}

type SessionDenial = Exclude<SessionRefusal, { status: 404 }>;

/**
 * The files of these records that a session holds and the caller may not act on (`view`: read, `manage`: change),
 * by key. Each session is asked about once, however many of its files are named.
 */
async function sessionDenials(
  request: FastifyRequest,
  records: readonly FileRecordView[],
  need: SessionAction,
): Promise<Map<string, SessionDenial>> {
  const denied = new Map<string, SessionDenial>();
  if (!records.some((record) => sessionOfFile(record))) return denied;

  const actor = await sessionActorOf(request);
  const asked = new Map<string, Promise<SessionDenial | null>>();
  await Promise.all(records.map(async (record) => {
    const conversationId = sessionOfFile(record);
    if (!conversationId) return;
    let answer = asked.get(conversationId);
    if (!answer) {
      answer = refuseSessionLinked(request, conversationId, need, { actor });
      asked.set(conversationId, answer);
    }
    const denial = await answer;
    if (denial) denied.set(record.key, denial);
  }));
  return denied;
}

/** Files of a session are only the caller's to delete when the session is: see `sessionRefusedForBucketDeletion`. */
const BUCKET_SESSIONS_FORBIDDEN_MESSAGE =
  'This bucket holds files of sessions started by someone else, and you are not allowed to change them, so it cannot be deleted with its files.';

/** Records read per step when a bucket is checked for the sessions it holds. */
const BUCKET_SESSION_SCAN_PAGE = 200;

/**
 * The first refusal among the sessions whose files a bucket holds, for a caller who asks for the bucket to be
 * deleted together with its files. That deletes every file in it, a session's among them, and the background job
 * that does it runs from the queue alone and cannot ask later; so it is asked here, while the request is. `null`:
 * the caller may manage every one of those sessions (or the bucket holds none).
 */
async function sessionRefusedForBucketDeletion(
  request: FastifyRequest,
  tenant: { tenantDbName: string; tenantId: string },
  projectId: string,
  bucketKey: string,
): Promise<SessionDenial | null> {
  // Worked out when the first session turns up: a bucket of plain files asks nothing.
  let actor: Awaited<ReturnType<typeof sessionActorOf>> | undefined;
  const asked = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listFiles(tenant.tenantDbName, tenant.tenantId, projectId, {
      bucketKey,
      purpose: 'conversation',
      limit: BUCKET_SESSION_SCAN_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    const fresh: string[] = [];
    for (const record of page.items) {
      const conversationId = sessionOfFile(record);
      if (conversationId && !asked.has(conversationId)) {
        asked.add(conversationId);
        fresh.push(conversationId);
      }
    }
    if (fresh.length > 0) {
      actor ??= await sessionActorOf(request);
      const asker = actor;
      const answers = await Promise.all(fresh.map((conversationId) => refuseSessionLinked(request, conversationId, 'manage', { actor: asker })));
      const denied = answers.find((answer) => answer !== null);
      if (denied) return denied;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return null;
}

/** What a batch says about a file of a session the caller may not act on. */
function denialMessage(denial: SessionDenial): string {
  return denial.status === 403 ? SESSION_FORBIDDEN_MESSAGE[denial.need] : 'Authorization is temporarily unavailable.';
}

export const filesApiPlugin: FastifyPluginAsync = async (app) => {
  // A file travels base64-encoded in a JSON body, so an upload request is a third larger than the file: the route
  // takes a body up to the configured file limit plus that, and answers a larger one as a file that is too large.
  const uploadRoute = { bodyLimit: uploadBodyLimit(), errorHandler: uploadRouteErrorHandler };

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

      const providers = await listFileProviderItems(
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
      return fail(reply, error, 'list providers');
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
      if (sendProviderConfigError(reply, error)) return reply;
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

  // What the upload dialog shows before a byte is sent. Read-only: no rate-limit counter is touched.
  app.get('/files/limits', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { bucketKey?: string };
      const limits = await getFileLimits({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        userId: session.userId,
        ...(query.bucketKey ? { bucketKey: query.bucketKey } : {}),
      });

      return reply.code(200).send(limits);
    } catch (error) {
      return fail(reply, error, 'read limits');
    }
  }));

  app.get('/files/buckets', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const buckets = await listFileBucketItems(
        session.tenantDbName,
        session.tenantId,
        projectId,
      );

      return reply.code(200).send({ buckets });
    } catch (error) {
      return fail(reply, error, 'list buckets');
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
      return fail(reply, error, 'create bucket', { body: true });
    }
  }));

  app.get('/files/buckets/:bucketKey', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const detail = await getFileBucketDetail(
        session.tenantDbName,
        session.tenantId,
        projectId,
        bucketKey,
      );

      // Which agents keep their session files here is the agents service's to say: a caller who may not read agents
      // is told how many there are (`usedByCount`), not which. Asked only when some do, and quietly: the answer
      // shapes the body, it refuses nothing.
      const namesHidden = detail.usedBy.length > 0
        && (await serviceLevelForRequest(request, 'agents', { projectId })) === 'none';
      const bucket = namesHidden ? { ...detail, usedBy: [] } : detail;

      return reply.code(200).send({ bucket });
    } catch (error) {
      return fail(reply, error, 'read bucket');
    }
  }));

  app.patch('/files/buckets/:bucketKey', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      // A field that breaks the rules of a bucket (bucketRules) is a 400 that names it. The key never changes.
      const updates: Parameters<typeof updateFileBucket>[4] = {
        ...parseBucketPatch(readBodyObject(request)),
        updatedBy: session.userId,
      };

      // Agents keep their session files in the bucket they name: switching it
      // off would make every upload to those sessions fail.
      if (updates.status === 'disabled' && await bucketExists(session.tenantDbName, session.tenantId, projectId, bucketKey)) {
        const inUse = await findAgentsUsingBucket(session.tenantDbName, projectId, bucketKey);
        if (inUse.length > 0) return reply.code(409).send(bucketInUseBody(bucketKey, inUse, 'disable'));
      }

      const bucket = await updateFileBucket(
        session.tenantDbName,
        session.tenantId,
        projectId,
        bucketKey,
        updates,
      );

      return reply.code(200).send({ bucket });
    } catch (error) {
      return fail(reply, error, 'update bucket', { body: true });
    }
  }));

  app.delete('/files/buckets/:bucketKey', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const query = (request.query ?? {}) as { force?: string; deleteFiles?: string };
      const { projectId, session } = await requireProjectContextForRequest(request);

      // Not even with `force`: the agent would keep pointing at a bucket that is gone.
      const exists = await bucketExists(session.tenantDbName, session.tenantId, projectId, bucketKey);
      if (exists) {
        const inUse = await findAgentsUsingBucket(session.tenantDbName, projectId, bucketKey);
        if (inUse.length > 0) return reply.code(409).send(bucketInUseBody(bucketKey, inUse, 'delete'));
      }

      // The files go from the storage provider too: a job does that, and the bucket is gone when it is done. Until
      // then it is switched off and says it is being deleted; if the job fails it says why and can be deleted again.
      if (query.deleteFiles === 'true') {
        // A Knowledge Engine module keeps the originals and the extracted text of its documents in its bucket, and
        // re-indexing reads them back: emptying the bucket would leave a module that cannot rebuild its documents.
        if (exists) {
          const modules = await findModulesKeepingSourcesIn(session.tenantDbName, projectId, bucketKey);
          if (modules.length > 0) return reply.code(409).send(bucketHoldsSourcesBody(bucketKey, modules));
        }
        const refusal = await sessionRefusedForBucketDeletion(request, session, projectId, bucketKey);
        if (refusal) return sendSessionRefusal(reply, request, refusal, { message: BUCKET_SESSIONS_FORBIDDEN_MESSAGE });
        await startBucketDeletion({
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          projectId,
          bucketKey,
          actor: session.userId,
        });
        return reply.code(202).send({ status: 'deleting' });
      }

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
      return fail(reply, error, 'delete bucket');
    }
  }));

  app.get('/files/buckets/:bucketKey/objects', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as FileObjectsQuery;

      // `prefix` (even empty) = list one folder: its files, and its sub-folders in `folders`.
      // The files a session holds are the session's: those of somebody else's session the caller may not view
      // are left out, and the page is filled from the following reads rather than cut short (a caller who may
      // view every session costs one plain read and no lookup).
      const limit = parseLimit(query.limit) ?? 50;
      const visible = await listVisibleFiles(request, {
        cursor: query.cursor || undefined,
        limit,
        read: (cursor, size) => listFiles(session.tenantDbName, session.tenantId, projectId, {
          bucketKey,
          cursor,
          limit: size,
          search: query.search || undefined,
          ...(typeof query.prefix === 'string' ? { prefix: query.prefix } : {}),
          ...(query.purpose === 'conversation' || query.purpose === 'other' ? { purpose: query.purpose } : {}),
          // A kind filter lists like a search: every match under the prefix, flat. An unknown kind is ignored.
          ...(isFileTypeFilter(query.type) ? { type: query.type } : {}),
        }),
      });
      return reply.code(200).send({
        items: await withUploaderNames(
          session.tenantDbName,
          await withAgentIds(session.tenantDbName, projectId, visible.items),
        ),
        ...(visible.folders ? { folders: visible.folders, prefix: visible.prefix } : {}),
        nextCursor: visible.nextCursor,
      });
    } catch (error) {
      return fail(reply, error, 'list objects');
    }
  }));

  app.post('/files/buckets/:bucketKey/objects', uploadRoute, withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonObjectBody(request);
      const licenseType = session.licenseType as LicenseType;

      if (!body.fileName || typeof body.fileName !== 'string') {
        return reply.code(400).send({ error: 'fileName is required' });
      }
      if (!body.data || typeof body.data !== 'string') {
        return reply.code(400).send({ error: 'data is required' });
      }
      // Metadata is a set of named values: a text or a list would be stored as something other than what was sent.
      if (!isUploadMetadata(body.metadata)) {
        return reply.code(400).send({ error: 'metadata must be an object' });
      }
      // `folder` (alias `prefix`) = upload into that folder; `keyHint` is then the file's name in it.
      const destination = composeUploadKeyHint({ folder: body.folder ?? body.prefix, keyHint: body.keyHint });
      if ('error' in destination) return reply.code(400).send({ error: destination.error });
      // Optional OCR settings for the Markdown copy (`ocr`, `images`): checked here, kept on the file's record.
      const extraction = await parseExtractionBody(body, { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId });
      if ('error' in extraction) return reply.code(400).send({ error: extraction.error });

      // The bucket first: the quotas below are those of its provider, and a bucket that is missing or switched
      // off is refused before any of them is spent.
      const bucket = await getFileBucket(session.tenantDbName, session.tenantId, projectId, bucketKey);
      if (bucket.status !== 'active') throw bucketInactiveError();

      // Before any quota is spent: bytes written under the key of a session's file are the session's to allow.
      const sessionRefusal = await sessionRefusedForUpload(request, {
        tenantDbName: session.tenantDbName,
        projectId,
        bucket,
        keyHint: destination.keyHint,
        fileName: body.fileName,
      });
      if (sessionRefusal) return sendSessionRefusal(reply, request, sessionRefusal);

      // What the service will decode from `data`, not what the text claims: the quotas below are asked about it.
      const estimatedFileBytes = decodedByteLength(body.data);
      const quotaContext = {
        domain: 'file' as const,
        licenseType,
        projectId,
        providerKey: bucket.providerKey,
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
        // The Document Store does not wait for the converter: the record says `pending` and a job fills it in.
        markdown: 'queued',
        createdBy: session.userId,
        data: body.data as string,
        fileName: body.fileName as string,
        ...(destination.keyHint ? { keyHint: destination.keyHint } : {}),
        ...(extraction.extraction ? { extraction: extraction.extraction } : {}),
        metadata: (body.metadata ?? undefined) as Record<string, unknown> | undefined,
        providerKey: (body.providerKey as string | undefined) ?? undefined,
      });

      return reply.code(201).send({ record: result.record });
    } catch (error) {
      return fail(reply, error, 'upload', { storage: true, body: true });
    }
  }));

  // Converts one file to Markdown in the background (again, if it was converted before): the answer is the record,
  // `pending`, and a job fills it in. Only the formats the converter can read; a switched-off bucket takes no copy.
  app.post('/files/buckets/:bucketKey/convert', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonObjectBody(request);
      const key = readObjectKey(body.key, 'key');
      // Optional `ocr` / `images`: when the body names either, they replace the settings the file has (none = the plain conversion).
      const extraction = await parseExtractionBody(body, { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId });
      if ('error' in extraction) return reply.code(400).send({ error: extraction.error });

      // Converting a file a session holds changes that session's file: its owner always may, anybody else needs
      // `agent.session_manage_others`.
      const existing = await getFileRecord(session.tenantDbName, session.tenantId, projectId, bucketKey, key);
      const refusal = await refuseSessionLinked(request, sessionOfFile(existing), 'manage');
      if (refusal) return sendSessionRefusal(reply, request, refusal);

      const record = await queueMarkdownConversion({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        bucketKey,
        key,
        actor: session.userId,
        ...(extraction.present ? { extraction: extraction.extraction ?? {} } : {}),
      });
      const [withAgent] = await withAgentIds(session.tenantDbName, projectId, [record]);
      const [named] = await withUploaderNames(session.tenantDbName, [withAgent]);
      return reply.code(202).send({ record: named });
    } catch (error) {
      return fail(reply, error, 'convert object', { body: true });
    }
  }));

  // Deletes the files it names, as many as it can: what could not be deleted is reported with why. A file of a
  // session the caller may not manage is left alone and reported like any other that could not be deleted.
  app.post('/files/buckets/:bucketKey/objects/batch-delete', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const keys = readObjectKeys(readJsonObjectBody(request), BATCH_MAX_KEYS);

      const { found, missing, duplicates } = await findFileRecordsByKeys(session.tenantDbName, session.tenantId, projectId, bucketKey, keys);
      // Every record of a key counts: the one that stands for it may not be the one that says it is a session's.
      const denials = await sessionDenials(request, [...found, ...duplicates], 'manage');
      const refused = new Map<string, string>([
        ...missing.map((key): [string, string] => [key, 'File not found']),
        ...found.flatMap((record): Array<[string, string]> => {
          const denial = denials.get(record.key);
          return denial ? [[record.key, denialMessage(denial)]] : [];
        }),
      ]);

      const result = await deleteFileRecords(
        session.tenantDbName,
        session.tenantId,
        projectId,
        bucketKey,
        found.filter((record) => !refused.has(record.key)),
        session.userId,
      );

      const failures = new Map<string, string>([...refused, ...result.failed.map(({ key, error }): [string, string] => [key, error])]);
      return reply.code(200).send({
        deleted: result.deleted,
        failed: keys.filter((key) => failures.has(key)).map((key) => ({ key, error: failures.get(key)! })),
      });
    } catch (error) {
      return fail(reply, error, 'delete objects', { storage: true, body: true });
    }
  }));

  // Only reads, so the permission is `files` read (a POST would be a write by default) and a success is no
  // administrative event. The ZIP is streamed: the response starts before the last file is read.
  app.post(
    '/files/buckets/:bucketKey/objects/archive',
    { config: { ...authz.service('files', 'read'), skipAuditOnSuccess: true } },
    withApiRequestContext(async (request, reply) => {
      try {
        const { bucketKey } = request.params as { bucketKey: string };
        const { projectId, session } = await requireProjectContextForRequest(request);
        const keys = readObjectKeys(readJsonObjectBody(request), ARCHIVE_MAX_FILES);

        const { found, missing, duplicates } = await findFileRecordsByKeys(session.tenantDbName, session.tenantId, projectId, bucketKey, keys);
        if (missing.length > 0) {
          throw new FileServiceError('file_not_found', 404, 'File not found', { details: { keys: missing } });
        }
        // A file a session holds is read as the session it belongs to: one the caller may not view is no part of an
        // archive. Every record of a key counts: the one that stands for it may not be the one that says so.
        const denials = await sessionDenials(request, [...found, ...duplicates], 'view');
        const denied = found.find((record) => denials.has(record.key));
        if (denied) return sendSessionRefusal(reply, request, denials.get(denied.key)!);

        const archive = await createFilesArchive(session.tenantDbName, session.tenantId, projectId, bucketKey, found);
        reply.code(200).type('application/zip');
        setFileDownloadHeaders(reply, archive.fileName, 'attachment');
        return reply.send(archive.stream);
      } catch (error) {
        return fail(reply, error, 'archive objects', { storage: true, body: true });
      }
    }),
  );

  // Registers the objects already in the bucket's folder of the provider as files, a page per call. Adds records
  // only: nothing in the provider is changed.
  app.post('/files/buckets/:bucketKey/import', withApiRequestContext(async (request, reply) => {
    try {
      const { bucketKey } = request.params as { bucketKey: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readOptionalJsonObjectBody(request);

      if (body.cursor !== undefined && (typeof body.cursor !== 'string' || body.cursor.length === 0 || body.cursor.length > 2048)) {
        throw invalidRequest('cursor must be the nextCursor of the previous page.');
      }
      if (body.limit !== undefined && (!Number.isInteger(body.limit) || (body.limit as number) < 1 || (body.limit as number) > IMPORT_MAX_LIMIT)) {
        throw invalidRequest(`limit must be a whole number from 1 to ${IMPORT_MAX_LIMIT}.`);
      }

      const result = await importFromStorage({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        bucketKey,
        importedBy: session.userId,
        limit: (body.limit as number | undefined) ?? IMPORT_DEFAULT_LIMIT,
        ...(typeof body.cursor === 'string' ? { cursor: body.cursor } : {}),
      });
      return reply.code(200).send(result);
    } catch (error) {
      return fail(reply, error, 'import objects', { storage: true, body: true });
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

      // A file a session holds (`purpose: 'conversation'`) is read as the session it belongs to: its owner
      // always may, anybody else needs `agent.session_view_others`. This holds for every way of reading it:
      // the record, the download and the preview.
      const wanted = await getFileRecord(session.tenantDbName, session.tenantId, projectId, bucketKey, key);
      const refusal = await refuseSessionLinked(request, sessionOfFile(wanted), 'view');
      if (refusal) return sendSessionRefusal(reply, request, refusal);

      const variant = query.download === 'markdown' || query.variant === 'markdown'
        ? 'markdown'
        : 'original';

      // Inline, for the browser to show: a few safe types only, small ones, served so that nothing in them runs.
      if (query.preview === '1' || query.preview === 'true') {
        const plan = planPreview({
          contentType: wanted.contentType,
          size: variant === 'markdown' ? wanted.markdownSize : wanted.size,
          variant,
        });
        const result = await downloadFile(
          session.tenantDbName,
          session.tenantId,
          projectId,
          bucketKey,
          key,
          { variant },
        );
        const buffer = Buffer.from(result.data as Uint8Array);
        assertPreviewSize(buffer.length);

        reply.code(200).type(plan.contentType);
        reply.header('Content-Length', String(buffer.length));
        setFileDownloadHeaders(reply, result.fileName, 'inline');
        reply.header('Content-Security-Policy', 'sandbox');
        return reply.send(buffer);
      }

      if (query.download) {
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
        reply.header('Content-Length', String(buffer.length));
        setFileDownloadHeaders(reply, result.fileName, 'attachment');
        return reply.send(buffer);
      }

      const [withAgent] = await withAgentIds(session.tenantDbName, projectId, [wanted]);
      const [named] = await withUploaderNames(session.tenantDbName, [withAgent]);
      return reply.code(200).send({ record: named });
    } catch (error) {
      return fail(reply, error, 'read object', { storage: true });
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
      // Deleting a file a session holds is acting on the session: its owner always may, anybody else needs
      // `agent.session_manage_others`.
      const existing = await getFileRecord(session.tenantDbName, session.tenantId, projectId, bucketKey, key);
      const refusal = await refuseSessionLinked(request, sessionOfFile(existing), 'manage');
      if (refusal) return sendSessionRefusal(reply, request, refusal);
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
      return fail(reply, error, 'delete object', { storage: true });
    }
  }));
};
