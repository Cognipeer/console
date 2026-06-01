/**
 * Sandbox toolbox daemon entrypoint.
 *
 * Runs INSIDE each sandbox container and exposes filesystem / process / PTY
 * operations over HTTP + WebSocket. The runner agent proxies console requests
 * here. Confined to the sandbox root (default /workspace).
 *
 * Env:
 *   TOOLBOX_PORT   (default 8787)
 *   TOOLBOX_TOKEN  optional bearer token required on every request
 *   SANDBOX_ROOT   (default /workspace)
 */

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import * as fsops from './fs';
import * as proc from './process';
import { attachPty } from './pty';
import { SANDBOX_ROOT } from './paths';
import type { WebSocket } from 'ws';
import type {
  CodeLanguage,
  CodeRunRequest,
  CreateSessionRequest,
  ExecRequest,
  FsCreateFolderRequest,
  FsDeleteRequest,
  FsFindRequest,
  FsListRequest,
  FsMoveRequest,
  FsReplaceRequest,
  FsSetPermissionsRequest,
  SessionExecRequest,
} from '@cognipeer/sandbox-protocol';

const PORT = Number(process.env.TOOLBOX_PORT || 8787);
const TOKEN = process.env.TOOLBOX_TOKEN || '';

const app = Fastify({ logger: false, bodyLimit: 256 * 1024 * 1024 });

await app.register(websocket);
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
  done(null, body),
);

// Optional bearer auth on all routes except /health.
app.addHook('onRequest', async (request, reply) => {
  if (!TOKEN || request.url.startsWith('/health')) return;
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== TOKEN) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
});

app.get('/health', async () => ({ ok: true, root: SANDBOX_ROOT }));

/* ----------------------------- Filesystem ---------------------------- */
app.post('/fs/list', async (req) => ({ entries: await fsops.listFiles((req.body as FsListRequest).path) }));
app.post('/fs/info', async (req) => ({ entry: await fsops.getInfo((req.body as { path: string }).path) }));
app.post('/fs/folder', async (req) => {
  const b = req.body as FsCreateFolderRequest;
  await fsops.createFolder(b.path, b.mode);
  return { ok: true };
});
app.post('/fs/delete', async (req) => {
  const b = req.body as FsDeleteRequest;
  await fsops.deletePath(b.path, b.recursive);
  return { ok: true };
});
app.post('/fs/move', async (req) => {
  const b = req.body as FsMoveRequest;
  await fsops.movePath(b.source, b.destination);
  return { ok: true };
});
app.post('/fs/permissions', async (req) => {
  const b = req.body as FsSetPermissionsRequest;
  await fsops.setPermissions(b.path, b.mode);
  return { ok: true };
});
app.post('/fs/find', async (req) => {
  const b = req.body as FsFindRequest;
  return { matches: await fsops.findInFiles(b.path, b.pattern) };
});
app.post('/fs/replace', async (req) => {
  const b = req.body as FsReplaceRequest;
  return { replaced: await fsops.replaceInFiles(b.files, b.pattern, b.newValue) };
});
app.get('/fs/download', async (req, reply) => {
  const { path: p } = req.query as { path: string };
  const buf = await fsops.readFileBuffer(p);
  return reply.header('content-type', 'application/octet-stream').send(buf);
});
app.post('/fs/upload', async (req, reply) => {
  const { path: p } = req.query as { path: string };
  const body = req.body as Buffer;
  await fsops.writeFileBuffer(p, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  return reply.send({ ok: true });
});

/* ------------------------------- Process ----------------------------- */
app.post('/process/exec', async (req) => {
  const b = req.body as ExecRequest;
  return proc.exec(b.command, { cwd: b.cwd, env: b.env, timeoutSec: b.timeoutSec });
});
app.post('/process/code-run', async (req) => {
  const b = req.body as CodeRunRequest;
  return proc.codeRun(b.code, (b.language as CodeLanguage) ?? 'python', {
    cwd: b.cwd,
    timeoutSec: b.timeoutSec,
  });
});
app.post('/process/session', async (req) => {
  const b = req.body as CreateSessionRequest;
  proc.createSession(b.sessionId);
  return { ok: true };
});
app.get('/process/sessions', async () => ({ sessions: proc.listSessions() }));
app.get('/process/session/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const session = proc.getSession(id);
  if (!session) return reply.code(404).send({ error: 'session-not-found' });
  return session;
});
app.post('/process/session/:id/exec', async (req, reply) => {
  const { id } = req.params as { id: string };
  const b = req.body as SessionExecRequest;
  try {
    return await proc.execInSession(id, b.command, Boolean(b.runAsync));
  } catch {
    return reply.code(404).send({ error: 'session-not-found' });
  }
});
app.get('/process/session/:id/log', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { commandId } = req.query as { commandId: string };
  const log = proc.getSessionCommandLog(id, commandId);
  if (log === null) return reply.code(404).send({ error: 'not-found' });
  return { log };
});
app.delete('/process/session/:id', async (req) => {
  const { id } = req.params as { id: string };
  proc.deleteSession(id);
  return { ok: true };
});

/* --------------------------------- PTY ------------------------------- */
app.get('/pty', { websocket: true }, (socket: WebSocket, req) => {
  const q = req.query as { cols?: string; rows?: string; cwd?: string; shell?: string };
  attachPty(socket, {
    cols: q.cols ? Number(q.cols) : undefined,
    rows: q.rows ? Number(q.rows) : undefined,
    cwd: q.cwd,
    shell: q.shell,
  });
});

app
  .listen({ host: '0.0.0.0', port: PORT })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`[sandbox-toolbox] listening on :${PORT} root=${SANDBOX_ROOT}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[sandbox-toolbox] failed to start', err);
    process.exit(1);
  });
