/**
 * Files attached to an agent session — upload, list, delete — for the dashboard
 * (`/agents/:agentId/sessions/:sessionId/files`) and the client API
 * (`/client/v1/agents/sessions/:conversationId/files`).
 *
 * An upload is a raw body: `Content-Type: <the file's mime type>` and
 * `?name=<filename>` — no multipart dependency. A JSON body
 * `{ name, contentType, data: <base64> }` is accepted for small files; for that
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
import { getAgentByKey, getConversationById } from '@/lib/services/agents';
import { apiErrorBody } from '@/lib/services/agents/agentRunService';
import { AgentAttachmentError, classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import {
  deleteSessionFile,
  listSessionFiles,
  uploadSessionFile,
  type SessionFileView,
} from '@/lib/services/agents/sessionFiles';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { readJsonBody, sendProjectContextError, withApiRequestContext, withClientApiRequestContext } from '../fastify-utils';
import { requireScopedSession } from './agents';

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
    const name = [body.name, body.fileName, body.filename].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    const contentType = [body.contentType, body.mimeType, body.mime_type].find((v): v is string => typeof v === 'string');
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
    ...(file.createdAt ? { created_at: new Date(file.createdAt).toISOString() } : {}),
    ...(file.expiresAt ? { expires_at: new Date(file.expiresAt).toISOString() } : {}),
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

  app.post('/agents/:agentId/sessions/:sessionId/files', { bodyLimit }, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply);
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
      const scoped = await requireScopedSession(request, reply);
      if (!scoped) return reply;
      const files = await listSessionFiles(
        { tenantDbName: scoped.session.tenantDbName, tenantId: scoped.session.tenantId, projectId: scoped.projectId },
        String(scoped.conversation._id),
      );
      return reply.code(200).send({ files: files.map(dashboardFile) });
    } catch (error) {
      return sendDashboardError(reply, error, 'List session files error', 'Failed to list the files');
    }
  }));

  app.delete('/agents/:agentId/sessions/:sessionId/files/:fileId', withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply);
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

  /** The conversation `:conversationId` names, in the token's project; null (404 sent) otherwise. */
  async function requireClientSession(
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: ApiTokenContext,
  ): Promise<IAgentConversation | null> {
    const { conversationId } = request.params as { conversationId: string };
    let found: IAgentConversation | null = null;
    try {
      found = await getConversationById(ctx.tenantDbName, conversationId);
    } catch {
      found = null;
    }
    if (!found || found.projectId !== ctx.projectId) {
      void reply.code(404).send(apiErrorBody('not_found_error', 'Session not found', 'session_not_found'));
      return null;
    }
    return found;
  }

  function sendClientError(reply: FastifyReply, error: unknown, logMessage: string) {
    const classified = classifyAgentRunError(error);
    if (classified.status >= 500) logger.error(logMessage, { error });
    return reply.code(classified.status).send({ error: classified.error });
  }

  const clientScope = (ctx: ApiTokenContext) => ({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
  });

  app.post('/client/v1/agents/sessions/:conversationId/files', { bodyLimit }, withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireClientSession(request, reply, ctx);
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
      const conversation = await requireClientSession(request, reply, ctx);
      if (!conversation) return reply;
      const files = await listSessionFiles(clientScope(ctx), String(conversation._id));
      return reply.code(200).send({ object: 'list', data: files.map((file) => clientFile(file, String(conversation._id))) });
    } catch (error) {
      return sendClientError(reply, error, 'Client list session files error');
    }
  }));

  app.delete('/client/v1/agents/sessions/:conversationId/files/:fileId', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const conversation = await requireClientSession(request, reply, ctx);
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
