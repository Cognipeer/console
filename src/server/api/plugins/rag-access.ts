/**
 * Knowledge Engine access control (dashboard): folders, document placement,
 * permissions, the "why can (not) X read this" view, and the identity
 * directories that map external users and groups to console people.
 *
 * Folder and placement routes are Knowledge Engine `write`; with access control
 * on, changing folders and moving documents is for managers (Knowledge Engine
 * admins) only, and a writer lists the folders they can see. Permission and
 * directory routes are `admin` (directories are workspace-wide, so their
 * handlers also ask for the admin level outside any project).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { authz } from '@/lib/iam/routeAuthz';
import {
  createRagIdentityLinkFor,
  createRagModuleFolder,
  deleteRagIdentityDomainByKey,
  deleteRagIdentityLinkById,
  deleteRagModuleFolder,
  explainRagAccess,
  getRagNodeAcl,
  listRagIdentityDirectoryUsers,
  listRagIdentityDomains,
  listRagIdentityLinksFor,
  listRagModuleFolders,
  moveRagDocuments,
  parseRagAclNode,
  putRagIdentityDomain,
  setRagNodeAclFromConsole,
  updateRagModuleFolder,
  type RagAccessContext,
} from '@/lib/services/rag/ragAccessService';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  serviceActionAllowedForRequest,
  withApiRequestContext,
} from '../fastify-utils';
import { ragAccessForRequest, sendRagAccessError } from '../ragAccessRequest';

const logger = createLogger('api:rag-access');

const READ = { config: authz.service('rag', 'read') } as const;
const WRITE = { config: authz.service('rag', 'write') } as const;
const ADMIN = { config: authz.service('rag', 'admin') } as const;

function fail(reply: FastifyReply, error: unknown, what: string) {
  const known = sendRagAccessError(reply, error);
  if (known) return known;
  logger.error(`${what} error`, { error });
  return sendProjectContextError(reply, error)
    ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
}

async function contextFor(request: FastifyRequest): Promise<RagAccessContext & { tenantDbName: string; tenantId: string }> {
  const { projectId, session } = await requireProjectContextForRequest(request);
  return { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, actor: session.userId };
}

/** Directories and links are shared by every project: their admin is the workspace's. */
async function requireWorkspaceRagAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (await serviceActionAllowedForRequest(request, 'rag', 'admin', { workspace: true })) return true;
  reply.code(403).send({
    error: 'Identity directories are managed by Knowledge Engine admins of the workspace',
    code: 'access_denied',
  });
  return false;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export const ragAccessApiPlugin: FastifyPluginAsync = async (app) => {
  // ── folders ──────────────────────────────────────────────────────────

  app.get('/rag/modules/:key/folders', READ, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      const { key } = request.params as { key: string };
      const access = await ragAccessForRequest(request, { ...ctx, ragModuleKey: key });
      if (!access.module) return reply.code(404).send({ error: 'Knowledge Engine module not found' });
      const folders = await listRagModuleFolders(ctx, key, access.scope);
      return reply.code(200).send({ folders });
    } catch (error) {
      return fail(reply, error, 'List Knowledge Engine folders');
    }
  }));

  app.post('/rag/modules/:key/folders', WRITE, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const access = await ragAccessForRequest(request, { ...ctx, ragModuleKey: key });
      if (!access.module) return reply.code(404).send({ error: 'Knowledge Engine module not found' });
      const folder = await createRagModuleFolder(ctx, {
        ragModuleKey: key,
        name: body.name as string,
        parentId: typeof body.parentId === 'string' ? body.parentId : null,
        scope: access.scope,
      });
      return reply.code(201).send({ folder });
    } catch (error) {
      return fail(reply, error, 'Create Knowledge Engine folder');
    }
  }));

  app.patch('/rag/modules/:key/folders/:folderId', WRITE, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      const { key, folderId } = request.params as { key: string; folderId: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const access = await ragAccessForRequest(request, { ...ctx, ragModuleKey: key });
      if (!access.module) return reply.code(404).send({ error: 'Knowledge Engine module not found' });
      if (body.parentId !== undefined && body.parentId !== null && typeof body.parentId !== 'string') {
        return reply.code(400).send({ error: 'parentId must be a folder id or null' });
      }
      const folder = await updateRagModuleFolder(ctx, {
        ragModuleKey: key,
        folderId,
        ...(body.name !== undefined ? { name: body.name as string } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId as string | null } : {}),
        scope: access.scope,
      });
      return reply.code(200).send({ folder });
    } catch (error) {
      return fail(reply, error, 'Update Knowledge Engine folder');
    }
  }));

  app.delete('/rag/modules/:key/folders/:folderId', WRITE, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      const { key, folderId } = request.params as { key: string; folderId: string };
      const access = await ragAccessForRequest(request, { ...ctx, ragModuleKey: key });
      if (!access.module) return reply.code(404).send({ error: 'Knowledge Engine module not found' });
      await deleteRagModuleFolder(ctx, { ragModuleKey: key, folderId, scope: access.scope });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return fail(reply, error, 'Delete Knowledge Engine folder');
    }
  }));

  // ── document placement ───────────────────────────────────────────────

  app.post('/rag/modules/:key/documents/move', WRITE, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      if (!Array.isArray(body.documentIds) || body.documentIds.some((id) => typeof id !== 'string')) {
        return reply.code(400).send({ error: 'documentIds must be an array of document ids' });
      }
      if (body.folderId !== null && typeof body.folderId !== 'string') {
        return reply.code(400).send({ error: 'folderId must be a folder id or null' });
      }
      const access = await ragAccessForRequest(request, { ...ctx, ragModuleKey: key });
      if (!access.module) return reply.code(404).send({ error: 'Knowledge Engine module not found' });
      const result = await moveRagDocuments(ctx, {
        ragModuleKey: key,
        documentIds: body.documentIds as string[],
        folderId: body.folderId as string | null,
        scope: access.scope,
      });
      return reply.code(200).send(result);
    } catch (error) {
      return fail(reply, error, 'Move Knowledge Engine documents');
    }
  }));

  app.patch('/rag/modules/:key/documents/:documentId', WRITE, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      const { key, documentId } = request.params as { key: string; documentId: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.folderId === undefined) return reply.code(400).send({ error: 'folderId is required (a folder id or null)' });
      if (body.folderId !== null && typeof body.folderId !== 'string') {
        return reply.code(400).send({ error: 'folderId must be a folder id or null' });
      }
      const access = await ragAccessForRequest(request, { ...ctx, ragModuleKey: key });
      if (!access.module) return reply.code(404).send({ error: 'Knowledge Engine module not found' });
      const result = await moveRagDocuments(ctx, {
        ragModuleKey: key,
        documentIds: [documentId],
        folderId: body.folderId as string | null,
        scope: access.scope,
      });
      return reply.code(200).send(result);
    } catch (error) {
      return fail(reply, error, 'Move Knowledge Engine document');
    }
  }));

  // ── permissions ──────────────────────────────────────────────────────

  app.get('/rag/modules/:key/acl', ADMIN, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      const { key } = request.params as { key: string };
      const query = (request.query ?? {}) as { node?: string };
      const acl = await getRagNodeAcl(ctx, { ragModuleKey: key, node: parseRagAclNode(query.node, key) });
      return reply.code(200).send({ acl });
    } catch (error) {
      return fail(reply, error, 'Get Knowledge Engine permissions');
    }
  }));

  app.put('/rag/modules/:key/acl', ADMIN, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.mode !== 'own' && body.mode !== 'inherit') {
        return reply.code(400).send({ error: 'mode must be "own" or "inherit"' });
      }
      const acl = await setRagNodeAclFromConsole(ctx, {
        ragModuleKey: key,
        node: parseRagAclNode(body.node, key),
        mode: body.mode,
        entries: body.entries,
      });
      return reply.code(200).send({ acl });
    } catch (error) {
      return fail(reply, error, 'Set Knowledge Engine permissions');
    }
  }));

  app.get('/rag/modules/:key/access/explain', ADMIN, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      const { key } = request.params as { key: string };
      const query = (request.query ?? {}) as { userId?: string; documentId?: string };
      const userId = asOptionalString(query.userId);
      if (!userId) return reply.code(400).send({ error: 'userId is required' });
      // Who the person is (e-mail, groups, every key, the directory matches) spans the workspace, like the directories
      // do: only its Knowledge Engine admins see it. An admin of this project alone gets the decision.
      const identity = await serviceActionAllowedForRequest(request, 'rag', 'admin', { workspace: true });
      const explanation = await explainRagAccess(ctx, {
        ragModuleKey: key,
        userId,
        identity,
        ...(asOptionalString(query.documentId) ? { documentId: asOptionalString(query.documentId) } : {}),
      });
      return reply.code(200).send({ explanation });
    } catch (error) {
      return fail(reply, error, 'Explain Knowledge Engine access');
    }
  }));

  // ── identity directories (workspace-wide) ─────────────────────────────

  app.get('/rag/identity/domains', ADMIN, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      if (!(await requireWorkspaceRagAdmin(request, reply))) return reply;
      const domains = await listRagIdentityDomains(ctx);
      return reply.code(200).send({ domains });
    } catch (error) {
      return fail(reply, error, 'List identity directories');
    }
  }));

  app.put('/rag/identity/domains/:domainKey', ADMIN, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      if (!(await requireWorkspaceRagAdmin(request, reply))) return reply;
      const { domainKey } = request.params as { domainKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.matchGroupsByExternalId !== undefined && typeof body.matchGroupsByExternalId !== 'boolean') {
        return reply.code(400).send({ error: 'matchGroupsByExternalId must be a boolean' });
      }
      const domain = await putRagIdentityDomain(ctx, {
        key: domainKey,
        label: typeof body.label === 'string' ? body.label : undefined,
        userMatch: body.userMatch,
        ...(typeof body.matchGroupsByExternalId === 'boolean' ? { matchGroupsByExternalId: body.matchGroupsByExternalId } : {}),
      });
      return reply.code(200).send({ domain });
    } catch (error) {
      return fail(reply, error, 'Save identity directory');
    }
  }));

  app.delete('/rag/identity/domains/:domainKey', ADMIN, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      if (!(await requireWorkspaceRagAdmin(request, reply))) return reply;
      const { domainKey } = request.params as { domainKey: string };
      await deleteRagIdentityDomainByKey(ctx, domainKey);
      return reply.code(200).send({ success: true });
    } catch (error) {
      return fail(reply, error, 'Delete identity directory');
    }
  }));

  app.get('/rag/identity/domains/:domainKey/users', ADMIN, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      if (!(await requireWorkspaceRagAdmin(request, reply))) return reply;
      const { domainKey } = request.params as { domainKey: string };
      const query = (request.query ?? {}) as { search?: string; limit?: string; offset?: string };
      const limit = Number.parseInt(query.limit ?? '', 10);
      const offset = Number.parseInt(query.offset ?? '', 10);
      const page = await listRagIdentityDirectoryUsers(ctx, domainKey, {
        search: query.search,
        ...(Number.isFinite(limit) ? { limit } : {}),
        ...(Number.isFinite(offset) ? { offset } : {}),
      });
      return reply.code(200).send(page);
    } catch (error) {
      return fail(reply, error, 'List identity directory users');
    }
  }));

  app.get('/rag/identity/links', ADMIN, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      if (!(await requireWorkspaceRagAdmin(request, reply))) return reply;
      const query = (request.query ?? {}) as { domain?: string; consoleKind?: string; consoleId?: string };
      const consoleKind = query.consoleKind === 'user' || query.consoleKind === 'group' ? query.consoleKind : undefined;
      const links = await listRagIdentityLinksFor(ctx, {
        ...(asOptionalString(query.domain) ? { domain: asOptionalString(query.domain) } : {}),
        ...(consoleKind ? { consoleKind } : {}),
        ...(consoleKind && asOptionalString(query.consoleId) ? { consoleId: asOptionalString(query.consoleId) } : {}),
      });
      return reply.code(200).send({ links });
    } catch (error) {
      return fail(reply, error, 'List identity links');
    }
  }));

  app.post('/rag/identity/links', ADMIN, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      if (!(await requireWorkspaceRagAdmin(request, reply))) return reply;
      const body = readJsonBody<Record<string, unknown>>(request);
      const link = await createRagIdentityLinkFor(ctx, {
        domain: String(body.domain ?? ''),
        externalKind: body.externalKind as 'user' | 'group',
        externalId: String(body.externalId ?? ''),
        consoleKind: body.consoleKind as 'user' | 'group',
        consoleId: String(body.consoleId ?? ''),
      });
      return reply.code(201).send({ link });
    } catch (error) {
      return fail(reply, error, 'Create identity link');
    }
  }));

  app.delete('/rag/identity/links/:linkId', ADMIN, withApiRequestContext(async (request, reply) => {
    try {
      const ctx = await contextFor(request);
      if (!(await requireWorkspaceRagAdmin(request, reply))) return reply;
      const { linkId } = request.params as { linkId: string };
      await deleteRagIdentityLinkById(ctx, linkId);
      return reply.code(200).send({ success: true });
    } catch (error) {
      return fail(reply, error, 'Delete identity link');
    }
  }));
};
