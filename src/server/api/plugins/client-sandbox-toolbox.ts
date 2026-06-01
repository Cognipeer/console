/**
 * Sandbox Toolbox routes — file-system, git and async session/log-streaming
 * operations against a running sandbox (Daytona-style), built on the exec path.
 *
 * The route set is defined once in `registerSandboxToolboxRoutes` and mounted
 * twice:
 *   • client (API token) at /api/client/v1/sandbox/sandboxes/:id/...
 *   • admin  (cookie)     at /api/sandbox/instances/:id/...   (so the Playground
 *                             can exercise the same operations)
 *
 * Sub-paths (POST unless noted):
 *   File system:  fs/list | fs/info | fs/read | fs/write | fs/mkdir | fs/delete |
 *                 fs/move | fs/permissions | fs/find | fs/replace
 *   Git:          git/clone | git/status | git/branches | git/branch |
 *                 git/branch/delete | git/checkout | git/add | git/commit |
 *                 git/push | git/pull | git/log
 *   Sessions:     POST sessions | GET sessions | DELETE sessions/:sid |
 *                 POST sessions/:sid/exec |
 *                 GET sessions/:sid/commands/:cmdId/logs[?follow=true] (SSE)
 *
 * Requests/responses are intentionally minimal (AI-agent friendly).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getApiTokenContextForRequest, safeReadJsonBody, withClientApiRequestContext } from '../fastify-utils';
import type { FsContext } from '@/lib/services/sandbox/fileService';
import * as fs from '@/lib/services/sandbox/fileService';
import * as git from '@/lib/services/sandbox/gitService';
import * as sessions from '@/lib/services/sandbox/sessionService';

const logger = createLogger('api:sandbox-toolbox');

type AnyHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

interface ToolboxMount {
  prefix: string;
  /** Apply auth/context and run the inner handler. */
  wrap: (handler: AnyHandler) => AnyHandler;
  /** Resolve the sandbox context for a request (instanceId from :id). */
  resolveCtx: (request: FastifyRequest) => Promise<FsContext>;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${name}-required`);
  return v;
};

/** Register the full toolbox route set under a mount (auth-agnostic). */
export function registerSandboxToolboxRoutes(app: FastifyInstance, mount: ToolboxMount): void {
  const { prefix, wrap, resolveCtx } = mount;

  // Wrap a toolbox handler: map null -> 404, thrown -> 400, success -> 200.
  const op = (
    handler: (ctx: FsContext, body: Record<string, unknown>, request: FastifyRequest) => Promise<unknown>,
  ): AnyHandler =>
    wrap(async (request, reply) => {
      const ctx = await resolveCtx(request);
      const body = (safeReadJsonBody(request) ?? {}) as Record<string, unknown>;
      try {
        const result = await handler(ctx, body, request);
        if (result === null) return reply.code(404).send({ error: 'not-found-or-not-ready' });
        return reply.code(200).send(result);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : 'operation-failed' });
      }
    });

  // ── File system ───────────────────────────────────────────────────────
  app.post(`${prefix}/fs/list`, op((c, b) => fs.listFiles(c, str(b.path, 'path'))));
  app.post(`${prefix}/fs/info`, op((c, b) => fs.getFileInfo(c, str(b.path, 'path'))));
  app.post(`${prefix}/fs/read`, op((c, b) => fs.readFile(c, str(b.path, 'path'), b.encoding === 'base64' ? 'base64' : 'utf8')));
  app.post(`${prefix}/fs/write`, op((c, b) =>
    fs.writeFile(c, str(b.path, 'path'), str(b.content, 'content'), b.encoding === 'base64' ? 'base64' : 'utf8'),
  ));
  app.post(`${prefix}/fs/mkdir`, op((c, b) => fs.createFolder(c, str(b.path, 'path'), typeof b.mode === 'string' ? b.mode : undefined)));
  app.post(`${prefix}/fs/delete`, op((c, b) => fs.deleteFile(c, str(b.path, 'path'), b.recursive === true)));
  app.post(`${prefix}/fs/move`, op((c, b) => fs.moveFile(c, str(b.source, 'source'), str(b.destination, 'destination'))));
  app.post(`${prefix}/fs/permissions`, op((c, b) =>
    fs.setPermissions(
      c,
      str(b.path, 'path'),
      typeof b.mode === 'string' ? b.mode : undefined,
      typeof b.owner === 'string' ? b.owner : undefined,
      typeof b.group === 'string' ? b.group : undefined,
    ),
  ));
  app.post(`${prefix}/fs/find`, op((c, b) => fs.findInFiles(c, str(b.path, 'path'), str(b.pattern, 'pattern'))));
  app.post(`${prefix}/fs/replace`, op((c, b) =>
    fs.replaceInFiles(c, Array.isArray(b.files) ? (b.files as string[]) : [], str(b.pattern, 'pattern'), str(b.newValue, 'newValue')),
  ));

  // ── Git ───────────────────────────────────────────────────────────────
  app.post(`${prefix}/git/clone`, op((c, b) =>
    git.cloneRepo(c, {
      url: str(b.url, 'url'),
      path: str(b.path, 'path'),
      branch: typeof b.branch === 'string' ? b.branch : undefined,
      username: typeof b.username === 'string' ? b.username : undefined,
      password: typeof b.password === 'string' ? b.password : undefined,
    }),
  ));
  app.post(`${prefix}/git/status`, op((c, b) => git.status(c, str(b.path, 'path'))));
  app.post(`${prefix}/git/branches`, op((c, b) => git.listBranches(c, str(b.path, 'path'))));
  app.post(`${prefix}/git/branch`, op((c, b) => git.createBranch(c, str(b.path, 'path'), str(b.name, 'name'))));
  app.post(`${prefix}/git/branch/delete`, op((c, b) => git.deleteBranch(c, str(b.path, 'path'), str(b.name, 'name'))));
  app.post(`${prefix}/git/checkout`, op((c, b) => git.checkout(c, str(b.path, 'path'), str(b.branch, 'branch'))));
  app.post(`${prefix}/git/add`, op((c, b) => git.add(c, str(b.path, 'path'), Array.isArray(b.files) ? (b.files as string[]) : [])));
  app.post(`${prefix}/git/commit`, op((c, b) =>
    git.commit(c, {
      path: str(b.path, 'path'),
      message: str(b.message, 'message'),
      author: str(b.author, 'author'),
      email: str(b.email, 'email'),
      allowEmpty: b.allowEmpty === true,
    }),
  ));
  app.post(`${prefix}/git/push`, op((c, b) =>
    git.push(c, {
      path: str(b.path, 'path'),
      username: typeof b.username === 'string' ? b.username : undefined,
      password: typeof b.password === 'string' ? b.password : undefined,
    }),
  ));
  app.post(`${prefix}/git/pull`, op((c, b) =>
    git.pull(c, {
      path: str(b.path, 'path'),
      username: typeof b.username === 'string' ? b.username : undefined,
      password: typeof b.password === 'string' ? b.password : undefined,
    }),
  ));
  app.post(`${prefix}/git/log`, op((c, b) => git.log(c, str(b.path, 'path'), typeof b.limit === 'number' ? b.limit : 30)));

  // ── Sessions / log streaming ──────────────────────────────────────────
  app.post(`${prefix}/sessions`, op((c, b) => sessions.createSession(c, typeof b.sessionId === 'string' ? b.sessionId : undefined)));
  app.get(`${prefix}/sessions`, op((c) => sessions.listSessions(c)));
  app.delete(`${prefix}/sessions/:sid`, op((c, _b, request) =>
    sessions.deleteSession(c, (request.params as { sid: string }).sid),
  ));
  app.post(`${prefix}/sessions/:sid/exec`, op((c, b, request) =>
    sessions.execSessionCommand(
      c,
      (request.params as { sid: string }).sid,
      str(b.command, 'command'),
      typeof b.cwd === 'string' ? b.cwd : undefined,
    ),
  ));

  // Snapshot OR follow (SSE) the logs of a session command.
  app.get(
    `${prefix}/sessions/:sid/commands/:cmdId/logs`,
    wrap(async (request, reply) => {
      const ctx = await resolveCtx(request);
      const { sid, cmdId } = request.params as { sid: string; cmdId: string };
      const follow = (request.query as { follow?: string } | undefined)?.follow === 'true';

      if (!follow) {
        try {
          const logs = await sessions.getSessionCommandLogs(ctx, sid, cmdId);
          if (logs === null) return reply.code(404).send({ error: 'not-found-or-not-ready' });
          return reply.code(200).send(logs);
        } catch (error) {
          return reply.code(400).send({ error: error instanceof Error ? error.message : 'logs-failed' });
        }
      }

      // SSE follow: poll the log files and emit only new bytes until exit.
      reply.hijack();
      const raw = reply.raw;
      raw.statusCode = 200;
      raw.setHeader('content-type', 'text/event-stream');
      raw.setHeader('cache-control', 'no-cache');
      raw.setHeader('connection', 'keep-alive');
      const send = (event: string, data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let closed = false;
      request.raw.on('close', () => { closed = true; });
      let outLen = 0;
      let errLen = 0;
      try {
        for (;;) {
          if (closed) break;
          const logs = await sessions.getSessionCommandLogs(ctx, sid, cmdId);
          if (logs === null) { send('error', { error: 'not-found-or-not-ready' }); break; }
          if (logs.stdout.length > outLen) { send('stdout', { data: logs.stdout.slice(outLen) }); outLen = logs.stdout.length; }
          if (logs.stderr.length > errLen) { send('stderr', { data: logs.stderr.slice(errLen) }); errLen = logs.stderr.length; }
          if (!logs.running) { send('exit', { exitCode: logs.exitCode }); break; }
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (error) {
        if (!closed) send('error', { error: error instanceof Error ? error.message : 'stream-failed' });
      } finally {
        if (!raw.writableEnded) raw.end();
      }
    }),
  );
}

/** Client (API-token) mount. */
export const clientSandboxToolboxApiPlugin: FastifyPluginAsync = async (app) => {
  registerSandboxToolboxRoutes(app, {
    prefix: '/client/v1/sandbox/sandboxes/:id',
    wrap: (handler) => withClientApiRequestContext(handler),
    resolveCtx: async (request) => {
      const apiCtx = await getApiTokenContextForRequest(request);
      const { id } = request.params as { id: string };
      return { tenantDbName: apiCtx.tenantDbName, tenantId: apiCtx.tenantId, instanceId: id, by: 'api-token' };
    },
  });
  logger.info('client sandbox toolbox API registered');
};
