/**
 * Files attached to an agent session — upload, list, delete — for the dashboard
 * (`/agents/:agentId/sessions/:sessionId/files`) and the client API
 * (`/client/v1/agents/sessions/:conversationId/files`).
 *
 * `GET …/files/:fileId/content` serves a file's bytes (the original, or the markdown
 * it was converted to) for the session views and the client API: `Content-Type` of
 * the file, a sanitised `Content-Disposition` (pictures open in place, everything
 * else downloads; SVG and HTML always download), `Cache-Control: private` and
 * `X-Content-Type-Options: nosniff`. Same session checks as the other file routes.
 *
 * `GET /agents/attachments/buckets` is the Configure → Files bucket picker.
 *
 * An upload is a raw body: `Content-Type: <the file's mime type>` and
 * `?name=<filename>` — no multipart dependency. A JSON body
 * `{ name, content_type, data: <base64> }` (`contentType` too) is accepted for small files; for that
 * reason a file of type `application/json` is uploaded as `application/octet-stream`
 * (the name still decides how it is read).
 *
 * This plugin has its own scope so its catch-all body parser (any mime type is
 * a file) does not reach any other route. The route-level body limit is the
 * ceiling for any agent (`FILE_UPLOAD_MAX_MB`, plus base64's overhead); an
 * agent's own `attachments.maxFileSizeMb` is enforced as soon as the body is in.
 */

import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { IAgentConversation } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { getAgentByKey } from '@/lib/services/agents';
import { apiErrorBody } from '@/lib/services/agents/agentRunService';
import { AgentAttachmentError, classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import { toClientErrorBody } from '@/lib/services/agents/clientWire';
import { parseByteRange } from '@/lib/services/agents/byteRange';
import { listAttachmentBuckets } from '@/lib/services/agents/sessionFilesBucket';
import {
  deleteSessionFile,
  listSessionFiles,
  readSessionFileContent,
  uploadSessionFile,
  type SessionFileContent,
  type SessionFileDisposition,
  type SessionFileVariant,
  type SessionFileView,
} from '@/lib/services/agents/sessionFiles';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
  withClientApiRequestContext,
} from '../fastify-utils';
import { requireScopedAgent, requireScopedSession } from './agents';
import { deleteSeedFile, uploadSeedFile } from '@/lib/services/agents/agentSandboxSeedStorage';
import { loadSessionForPrincipal, sendClientSessionRefusal, type SessionNeed } from './agent-session-access';
import { FILES_READ_REQUIRED_MESSAGE, requestBucketOptions, requestHasFilesRead } from './files-permission';

const logger = createLogger('api:agent-session-files');

/** A JSON upload carries the file base64-encoded: a third larger than the file. */
function uploadBodyLimit(): number {
  const bytes = Math.max(1, getConfig().limits.fileUploadMaxMb) * 1024 * 1024;
  return Math.ceil(bytes * (4 / 3)) + 64 * 1024;
}

interface UploadPayload {
  fileName: string;
  contentType?: string;
  data: Buffer | string;
}

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/**
 * The file from either body shape; a string is the refusal. Raw: the body is
 * the file, `?name=` its name, the content type its type. JSON: base64 `data`.
 */
function readUploadPayload(request: FastifyRequest): UploadPayload | string {
  const header = String(request.headers['content-type'] ?? '');
  const query = (request.query ?? {}) as Record<string, unknown>;

  if (JSON_CONTENT_TYPE.test(header)) {
    let body: Record<string, unknown>;
    try {
      body = readJsonBody<Record<string, unknown>>(request);
    } catch {
      return 'The body is not valid JSON.';
    }
    const name = [body.name, body.file_name, body.fileName, body.filename].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    const contentType = [body.content_type, body.contentType, body.mimeType, body.mime_type].find((v): v is string => typeof v === 'string');
    if (!name) return 'name is required.';
    if (typeof body.data !== 'string' || body.data.length === 0) return 'data is required (base64 or a data URL).';
    return { fileName: name, ...(contentType ? { contentType } : {}), data: body.data };
  }

  const name = typeof query.name === 'string' ? query.name.trim() : '';
  if (!name) return 'The file name is required: send it as ?name=<filename>.';
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) return 'The body is empty: send the file as the raw request body.';
  const contentType = header.split(';')[0]!.trim();
  return { fileName: name, ...(contentType ? { contentType } : {}), data: request.body };
}

/** `?variant=original|markdown&disposition=inline|attachment`; a string is the refusal. */
function readContentQuery(request: FastifyRequest): { variant?: SessionFileVariant; disposition?: SessionFileDisposition } | string {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const out: { variant?: SessionFileVariant; disposition?: SessionFileDisposition } = {};
  if (query.variant !== undefined) {
    if (query.variant !== 'original' && query.variant !== 'markdown') return 'variant must be "original" or "markdown".';
    out.variant = query.variant;
  }
  if (query.disposition !== undefined) {
    if (query.disposition !== 'inline' && query.disposition !== 'attachment') return 'disposition must be "inline" or "attachment".';
    out.disposition = query.disposition;
  }
  return out;
}

/**
 * The bytes with the headers that make serving an uploaded file from our own origin safe.
 * One `Range` is honoured (206, `Content-Range`), so a player or a download manager can
 * seek and resume; every answer says `Accept-Ranges: bytes`.
 */
function sendFileContent(reply: FastifyReply, content: SessionFileContent, rangeHeader?: string | string[]) {
  const range = parseByteRange(rangeHeader, content.size);
  const base = reply
    .header('Content-Type', content.contentType)
    .header('Content-Disposition', content.contentDisposition)
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'private, max-age=60')
    .header('X-Content-Type-Options', 'nosniff');
  if (range.kind === 'unsatisfiable') {
    return base.code(416).header('Content-Range', `bytes */${content.size}`).header('Content-Length', '0').send();
  }
  if (range.kind === 'partial') {
    return base
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${content.size}`)
      .header('Content-Length', String(range.end - range.start + 1))
      .send(content.data.subarray(range.start, range.end + 1));
  }
  return base.code(200).header('Content-Length', String(content.size)).send(content.data);
}

/** The dashboard's view of a file. */
function dashboardFile(file: SessionFileView) {
  return file;
}

/** The client API's view of a file (snake_case, like the rest of `/client/v1`). */
function clientFile(file: SessionFileView, conversationId: string) {
  return {
    id: file.id,
    object: 'agent.session.file',
    session_id: conversationId,
    name: file.name,
    mime_type: file.mimeType,
    size: file.size,
    conversion_status: file.conversionStatus,
    ...(file.conversionError ? { conversion_error: file.conversionError } : {}),
    bucket_key: file.bucketKey,
    path: file.path,
    ...(file.createdAt ? { created_at: new Date(file.createdAt).toISOString() } : {}),
    ...(file.expiresAt ? { expires_at: new Date(file.expiresAt).toISOString() } : {}),
    // The bytes: `?variant=markdown` for the converted text, `?disposition=inline|attachment`.
    content_url: `/api/client/v1/agents/sessions/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(file.id)}/content`,
  };
}

export const agentSessionFilesApiPlugin: FastifyPluginAsync = async (app) => {
  // Any other mime type than the app already parses is a file's bytes. Fastify's
  // own `text/plain` parser decodes to a string, which would mangle a text file's
  // bytes (and a CSV with a BOM): replace it, in this scope only.
  if (app.hasContentTypeParser('text/plain')) app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  const bodyLimit = uploadBodyLimit();

  // ── Dashboard ──

  function sendDashboardError(reply: FastifyReply, error: unknown, logMessage: string, message: string) {
    if (error instanceof AgentAttachmentError) {
      return reply.code(error.status).send({ error: error.message, type: 'attachment_error', code: error.code });
    }
    logger.error(logMessage, { error });
    return sendProjectContextError(reply, error) ?? reply.code(500).send({ error: message });
  }

  // The buckets an agent can keep its session files in, each with whether it can take a file now.
  // Read-only. The route sits under `agents` (whoever edits an agent reaches it), but the list is
  // the project's buckets: a caller without read access to Files is told so, in words the
  // Configure → Files section shows, instead of getting a list they could not open elsewhere.
  app.get('/agents/attachments/buckets', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      // The Document Store is the Files service's: a caller without read access to it is told so (the section
      // shows the sentence); the list itself is cut to the buckets they may look at, each marked with whether
      // they may name it (policy engine, per bucket).
      if (!(await requestHasFilesRead(request))) {
        return reply.code(403).send({ error: FILES_READ_REQUIRED_MESSAGE, type: 'files_read_required', code: 'files_read_required' });
      }
      const all = await listAttachmentBuckets(session.tenantDbName, session.tenantId, projectId);
      const buckets = await requestBucketOptions(request, projectId, all);
      return reply.code(200).send({ buckets });
    } catch (error) {
      return sendDashboardError(reply, error, 'List attachment buckets error', 'Failed to list the buckets');
    }
  }));

  // Sandbox seed files: bytes the agent's sandbox is preloaded with. Whoever may edit the agent may upload;
  // the response is the config entry the editor adds to `sandbox.seedFiles` (saved with the agent).
  app.post('/agents/:agentId/sandbox-seed-files', { bodyLimit }, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const payload = readUploadPayload(request);
      if (typeof payload === 'string') return reply.code(400).send({ error: payload });
      const data = typeof payload.data === 'string' ? Buffer.from(payload.data.replace(/^data:[^,]*;base64,/, ''), 'base64') : payload.data;
      const seedFile = await uploadSeedFile({
        scope: { tenantDbName: scoped.session.tenantDbName, tenantId: scoped.session.tenantId, projectId: scoped.projectId },
        agent: scoped.agent,
        fileName: payload.fileName,
        ...(payload.contentType ? { contentType: payload.contentType } : {}),
        data,
        userId: scoped.session.userId,
      });
      return reply.code(201).send({ seedFile });
    } catch (error) {
      return sendDashboardError(reply, error, 'Upload sandbox seed file error', 'Failed to upload the file');
    }
  }));

  app.delete('/agents/:agentId/sandbox-seed-files', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const query = (request.query ?? {}) as Record<string, unknown>;
      if (typeof query.objectKey !== 'string' || typeof query.bucketKey !== 'string') {
        return reply.code(400).send({ error: 'bucketKey and objectKey are required.' });
      }
      const deleted = await deleteSeedFile({
        scope: { tenantDbName: scoped.session.tenantDbName, tenantId: scoped.session.tenantId, projectId: scoped.projectId },
        agent: scoped.agent,
        bucketKey: query.bucketKey,
        objectKey: query.objectKey,
        userId: scoped.session.userId,
      });
      return reply.code(deleted ? 200 : 404).send(deleted ? { success: true } : { error: 'File not found' });
    } catch (error) {
      return sendDashboardError(reply, error, 'Delete sandbox seed file error', 'Failed to delete the file');
    }
  }));

  app.post('/agents/:agentId/sessions/:sessionId/files', { bodyLimit }, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'manage' });
      if (!scoped) return reply;
      const source = scoped.conversation.metadata?.source;
      if (typeof source === 'string' && source !== 'console') {
        return reply.code(409).send({ error: `This session came in via ${source} and is read-only. Start a new session to test the agent.` });
      }
      const payload = readUploadPayload(request);
      if (typeof payload === 'string') return reply.code(400).send({ error: payload });

      const file = await uploadSessionFile({
        scope: { tenantDbName: scoped.session.tenantDbName, tenantId: scoped.session.tenantId, projectId: scoped.projectId },
        conversation: scoped.conversation,
        agentConfig: scoped.agent.config,
        ...payload,
        actor: { userId: scoped.session.userId, licenseType: scoped.session.licenseType },
      });
      return reply.code(201).send({ file: dashboardFile(file) });
    } catch (error) {
      return sendDashboardError(reply, error, 'Upload session file error', 'Failed to upload the file');
    }
  }));

  app.get('/agents/:agentId/sessions/:sessionId/files', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const files = await listSessionFiles(
        { tenantDbName: scoped.session.tenantDbName, tenantId: scoped.session.tenantId, projectId: scoped.projectId },
        String(scoped.conversation._id),
        { withNames: true },
      );
      return reply.code(200).send({ files: files.map(dashboardFile) });
    } catch (error) {
      return sendDashboardError(reply, error, 'List session files error', 'Failed to list the files');
    }
  }));

  app.get('/agents/:agentId/sessions/:sessionId/files/:fileId/content', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const query = readContentQuery(request);
      if (typeof query === 'string') return reply.code(400).send({ error: query });
      const { fileId } = request.params as { fileId: string };
      const content = await readSessionFileContent(
        { tenantDbName: scoped.session.tenantDbName, tenantId: scoped.session.tenantId, projectId: scoped.projectId },
        String(scoped.conversation._id),
        fileId,
        query,
      );
      if (!content) return reply.code(404).send({ error: 'File not found' });
      return sendFileContent(reply, content, request.headers.range);
    } catch (error) {
      return sendDashboardError(reply, error, 'Read session file error', 'Failed to read the file');
    }
  }));

  app.delete('/agents/:agentId/sessions/:sessionId/files/:fileId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'manage' });
      if (!scoped) return reply;
      const source = scoped.conversation.metadata?.source;
      if (typeof source === 'string' && source !== 'console') {
        return reply.code(409).send({ error: `This session came in via ${source} and is read-only.` });
      }
      const { fileId } = request.params as { fileId: string };
      const deleted = await deleteSessionFile(
        { tenantDbName: scoped.session.tenantDbName, tenantId: scoped.session.tenantId, projectId: scoped.projectId },
        String(scoped.conversation._id),
        fileId,
        scoped.session.userId,
      );
      if (!deleted) return reply.code(404).send({ error: 'File not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendDashboardError(reply, error, 'Delete session file error', 'Failed to delete the file');
    }
  }));

  // ── Client API ──

  /**
   * The conversation `:conversationId` names, in the token's project, and the caller's right to it (the session's
   * owner needs nothing more; anybody else needs `agent.session_view_others` / `agent.session_manage_others`);
   * null (the 404 / 403 / 503 sent) otherwise.
   */
  async function requireClientSession(
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: ApiTokenContext,
    need: SessionNeed,
  ): Promise<IAgentConversation | null> {
    const { conversationId } = request.params as { conversationId: string };
    const loaded = await loadSessionForPrincipal(request, conversationId, {
      need,
      projectId: ctx.projectId,
      actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
    });
    if (!loaded.ok) {
      sendClientSessionRefusal(reply, request, loaded);
      return null;
    }
    return loaded.conversation;
  }

  function sendClientError(reply: FastifyReply, error: unknown, logMessage: string) {
    const classified = classifyAgentRunError(error);
    if (classified.status >= 500) logger.error(logMessage, { error });
    return reply.code(classified.status).send({ error: toClientErrorBody(classified.error) });
  }

  const clientScope = (ctx: ApiTokenContext) => ({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
  });

  app.post('/client/v1/agents/sessions/:conversationId/files', { bodyLimit }, withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireClientSession(request, reply, ctx, 'manage');
      if (!conversation) return reply;
      const payload = readUploadPayload(request);
      if (typeof payload === 'string') {
        return reply.code(400).send(apiErrorBody('invalid_request_error', payload, 'invalid_request'));
      }
      const agent = await getAgentByKey(ctx.tenantDbName, conversation.agentKey, ctx.projectId);
      if (!agent) return reply.code(404).send(apiErrorBody('not_found_error', 'Agent not found', 'agent_not_found'));

      const file = await uploadSessionFile({
        scope: clientScope(ctx),
        conversation,
        agentConfig: agent.config,
        ...payload,
        actor: {
          userId: ctx.tokenRecord.userId,
          licenseType: ctx.tenant.licenseType,
          tokenId: ctx.tokenRecord._id?.toString() ?? ctx.token,
        },
      });
      return reply.code(201).send(clientFile(file, String(conversation._id)));
    } catch (error) {
      return sendClientError(reply, error, 'Client upload session file error');
    }
  }));

  app.get('/client/v1/agents/sessions/:conversationId/files', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireClientSession(request, reply, ctx, 'view');
      if (!conversation) return reply;
      const files = await listSessionFiles(clientScope(ctx), String(conversation._id));
      return reply.code(200).send({ object: 'list', data: files.map((file) => clientFile(file, String(conversation._id))) });
    } catch (error) {
      return sendClientError(reply, error, 'Client list session files error');
    }
  }));

  app.get('/client/v1/agents/sessions/:conversationId/files/:fileId/content', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireClientSession(request, reply, ctx, 'view');
      if (!conversation) return reply;
      const query = readContentQuery(request);
      if (typeof query === 'string') return reply.code(400).send(apiErrorBody('invalid_request_error', query, 'invalid_request'));
      const { fileId } = request.params as { fileId: string };
      const content = await readSessionFileContent(clientScope(ctx), String(conversation._id), fileId, query);
      if (!content) return reply.code(404).send(apiErrorBody('not_found_error', 'File not found', 'file_not_found'));
      return sendFileContent(reply, content, request.headers.range);
    } catch (error) {
      return sendClientError(reply, error, 'Client read session file error');
    }
  }));

  app.delete('/client/v1/agents/sessions/:conversationId/files/:fileId', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireClientSession(request, reply, ctx, 'manage');
      if (!conversation) return reply;
      const { fileId } = request.params as { fileId: string };
      const deleted = await deleteSessionFile(clientScope(ctx), String(conversation._id), fileId, ctx.tokenRecord.userId);
      if (!deleted) return reply.code(404).send(apiErrorBody('not_found_error', 'File not found', 'file_not_found'));
      return reply.code(200).send({ id: fileId, object: 'agent.session.file', deleted: true });
    } catch (error) {
      return sendClientError(reply, error, 'Client delete session file error');
    }
  }));
};
