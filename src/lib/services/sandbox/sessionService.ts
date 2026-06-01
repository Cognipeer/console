/**
 * Async command sessions with log streaming (Daytona-style), on top of exec.
 *
 * A "session" is just a directory in the container under /tmp that groups
 * background commands. Each command runs detached, redirecting stdout/stderr to
 * files plus an exit-code file, so logs can be fetched as a snapshot or streamed
 * (the HTTP layer polls these files to produce an SSE follow stream).
 */

import { randomUUID } from 'node:crypto';
import { execInSandbox } from './execService';
import type { FsContext, FsOutcome } from './fileService';

const BASE = '/tmp/cognipeer-sessions';

function sq(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function run(ctx: FsContext, command: string, timeoutSec = 60) {
  return execInSandbox({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    instanceId: ctx.instanceId,
    command,
    timeoutSec,
    by: ctx.by,
  });
}

/** Validate ids we interpolate into paths (uuid-ish / safe token). */
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('invalid id');
  return id;
}

export async function createSession(
  ctx: FsContext,
  sessionId?: string,
): Promise<FsOutcome<{ sessionId: string }>> {
  const sid = safeId(sessionId ?? randomUUID());
  const res = await run(ctx, `mkdir -p ${sq(`${BASE}/${sid}`)}`);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'create-session failed');
  return { sessionId: sid };
}

export async function listSessions(ctx: FsContext): Promise<FsOutcome<{ sessions: string[] }>> {
  const res = await run(ctx, `ls -1 ${sq(BASE)} 2>/dev/null || true`);
  if (!res) return null;
  return { sessions: res.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
}

export async function deleteSession(ctx: FsContext, sessionId: string): Promise<FsOutcome<{ ok: true }>> {
  const sid = safeId(sessionId);
  const res = await run(ctx, `rm -rf ${sq(`${BASE}/${sid}`)}`);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'delete-session failed');
  return { ok: true };
}

export async function execSessionCommand(
  ctx: FsContext,
  sessionId: string,
  command: string,
  cwd = '/workspace',
): Promise<FsOutcome<{ commandId: string }>> {
  const sid = safeId(sessionId);
  const commandId = randomUUID();
  const cdir = `${BASE}/${sid}/${commandId}`;
  // Launch detached: the inner `sh -c "$2"` runs the user command; we record its
  // exit code. Args are passed positionally to avoid quoting the command twice.
  const launcher =
    `cd "$1" 2>/dev/null; sh -c "$2" >"$3/out" 2>"$3/err"; echo $? >"$3/exit"`;
  const cmd =
    `mkdir -p ${sq(cdir)} && ` +
    `nohup sh -c ${sq(launcher)} _ ${sq(cwd)} ${sq(command)} ${sq(cdir)} ` +
    `</dev/null >/dev/null 2>&1 & echo started`;
  const res = await run(ctx, cmd);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'session exec failed');
  return { commandId };
}

export interface SessionCommandLogs {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  running: boolean;
}

export async function getSessionCommandLogs(
  ctx: FsContext,
  sessionId: string,
  commandId: string,
): Promise<FsOutcome<SessionCommandLogs>> {
  const sid = safeId(sessionId);
  const cid = safeId(commandId);
  const cdir = `${BASE}/${sid}/${cid}`;
  const script = `
import os, json
cdir = os.environ['__CDIR']
def read(name):
    try:
        with open(os.path.join(cdir, name), 'r', errors='replace') as fh: return fh.read()
    except OSError: return ''
exit_s = read('exit').strip()
print(json.dumps({
    "stdout": read('out'),
    "stderr": read('err'),
    "exitCode": int(exit_s) if exit_s != '' else None,
    "running": exit_s == '',
}))
`;
  const res = await execInSandbox({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    instanceId: ctx.instanceId,
    command: 'printf %s "$__SBPY" | base64 -d | python3 -',
    env: { __SBPY: Buffer.from(script, 'utf8').toString('base64'), __CDIR: cdir },
    timeoutSec: 30,
    by: ctx.by,
  });
  if (!res) return null;
  const text = res.stdout.trim();
  if (!text) throw new Error(res.stderr.trim() || 'logs unavailable');
  return JSON.parse(text) as SessionCommandLogs;
}
