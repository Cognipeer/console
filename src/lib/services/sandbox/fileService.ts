/**
 * Sandbox file-system operations (Daytona-style), implemented on top of the
 * existing synchronous exec path — no new agent command kinds. Structured
 * results come from small python3 helpers run inside the container (the default
 * base image ships python3); plain shell is used where it is simpler.
 *
 * Responses are intentionally minimal (AI-agent friendly).
 */

import { execInSandbox } from './execService';

export interface FsContext {
  tenantDbName: string;
  tenantId: string;
  instanceId: string;
  by: string;
}

/** Result sentinel: null => sandbox missing/not running (endpoint -> 404). */
export type FsOutcome<T> = T | null;

/** Single-quote a value for safe interpolation into a /bin/sh command. */
function sq(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Run a python3 script in the container; the script is passed via env (base64)
 *  to avoid all shell-quoting issues. Extra env vars carry arguments/data. */
async function runPython(
  ctx: FsContext,
  script: string,
  env: Record<string, string> = {},
  timeoutSec = 60,
) {
  return execInSandbox({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    instanceId: ctx.instanceId,
    command: 'printf %s "$__SBPY" | base64 -d | python3 -',
    env: { ...env, __SBPY: b64(script) },
    timeoutSec,
    by: ctx.by,
  });
}

async function runShell(ctx: FsContext, command: string, timeoutSec = 60) {
  return execInSandbox({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    instanceId: ctx.instanceId,
    command,
    timeoutSec,
    by: ctx.by,
  });
}

/** Parse the JSON a python helper printed on stdout; throw on a helper error. */
function parseJson<T>(stdout: string, stderr: string): T {
  const text = stdout.trim();
  if (!text) {
    if (/python3: not found|No such file.*python3/i.test(stderr)) {
      throw new Error('python3 is not available in this sandbox image');
    }
    throw new Error(stderr.trim() || 'empty response');
  }
  return JSON.parse(text) as T;
}

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modTime: string;
}

export async function listFiles(ctx: FsContext, path: string): Promise<FsOutcome<{ files: FileEntry[] }>> {
  const script = `
import os, json, sys
p = os.environ['__P']
if not os.path.isdir(p):
    print(json.dumps({"error": "not-a-directory"})); sys.exit(0)
out = []
for e in sorted(os.scandir(p), key=lambda x: x.name):
    try:
        st = e.stat()
        out.append({"name": e.name, "isDir": e.is_dir(), "size": st.st_size,
                    "modTime": __import__('datetime').datetime.utcfromtimestamp(st.st_mtime).isoformat() + "Z"})
    except OSError:
        pass
print(json.dumps({"files": out}))
`;
  const res = await runPython(ctx, script, { __P: path });
  if (!res) return null;
  const data = parseJson<{ files?: FileEntry[]; error?: string }>(res.stdout, res.stderr);
  if (data.error) throw new Error(data.error);
  return { files: data.files ?? [] };
}

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  mode: string;
  permissions: string;
  modTime: string;
}

export async function getFileInfo(ctx: FsContext, path: string): Promise<FsOutcome<FileInfo>> {
  const script = `
import os, json, sys, stat, datetime
p = os.environ['__P']
if not os.path.exists(p):
    print(json.dumps({"error": "not-found"})); sys.exit(0)
st = os.stat(p)
print(json.dumps({
    "name": os.path.basename(p.rstrip('/')) or p,
    "path": p,
    "size": st.st_size,
    "isDir": os.path.isdir(p),
    "mode": oct(st.st_mode & 0o777)[2:].zfill(3),
    "permissions": stat.filemode(st.st_mode),
    "modTime": datetime.datetime.utcfromtimestamp(st.st_mtime).isoformat() + "Z",
}))
`;
  const res = await runPython(ctx, script, { __P: path });
  if (!res) return null;
  const data = parseJson<FileInfo & { error?: string }>(res.stdout, res.stderr);
  if (data.error) throw new Error(data.error);
  return data;
}

export interface ReadFileResult {
  content: string;
  encoding: 'utf8' | 'base64';
  size: number;
}

const READ_LIMIT_BYTES = 10 * 1024 * 1024;

export async function readFile(
  ctx: FsContext,
  path: string,
  encoding: 'utf8' | 'base64' = 'utf8',
): Promise<FsOutcome<ReadFileResult>> {
  const script = `
import os, json, sys, base64
p = os.environ['__P']; want = os.environ.get('__ENC', 'utf8')
if not os.path.exists(p):
    print(json.dumps({"error": "not-found"})); sys.exit(0)
if os.path.isdir(p):
    print(json.dumps({"error": "is-a-directory"})); sys.exit(0)
sz = os.path.getsize(p)
if sz > ${READ_LIMIT_BYTES}:
    print(json.dumps({"error": "too-large", "size": sz})); sys.exit(0)
data = open(p, 'rb').read()
if want == 'base64':
    print(json.dumps({"content": base64.b64encode(data).decode(), "encoding": "base64", "size": sz})); sys.exit(0)
try:
    print(json.dumps({"content": data.decode('utf-8'), "encoding": "utf8", "size": sz}))
except UnicodeDecodeError:
    print(json.dumps({"content": base64.b64encode(data).decode(), "encoding": "base64", "size": sz}))
`;
  const res = await runPython(ctx, script, { __P: path, __ENC: encoding });
  if (!res) return null;
  const data = parseJson<ReadFileResult & { error?: string }>(res.stdout, res.stderr);
  if (data.error) {
    if (data.error === 'too-large') throw new Error(`file exceeds ${READ_LIMIT_BYTES} byte read limit`);
    throw new Error(data.error);
  }
  return data;
}

/** base64 chunk size (multiple of 4 so chunks decode independently). */
const WRITE_CHUNK = 60_000;

export async function writeFile(
  ctx: FsContext,
  path: string,
  content: string,
  encoding: 'utf8' | 'base64' = 'utf8',
): Promise<FsOutcome<{ bytesWritten: number }>> {
  // Normalise to base64 and stream in chunks via append redirects — avoids the
  // kernel per-arg limit (MAX_ARG_STRLEN) so files of any size can be written.
  const data = encoding === 'base64' ? content : Buffer.from(content, 'utf8').toString('base64');
  const decoded = Buffer.from(data, 'base64');
  const chunks = data.length === 0 ? [''] : (data.match(new RegExp(`.{1,${WRITE_CHUNK}}`, 'g')) ?? []);
  const dir = path.replace(/\/[^/]*$/, '');
  for (let i = 0; i < chunks.length; i++) {
    const redirect = i === 0 ? '>' : '>>';
    const prep = i === 0 && dir && dir !== path ? `mkdir -p ${sq(dir)} && ` : '';
    const cmd = `${prep}printf %s ${sq(chunks[i])} | base64 -d ${redirect} ${sq(path)}`;
    const res = await runShell(ctx, cmd);
    if (!res) return null;
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'write failed');
  }
  return { bytesWritten: decoded.length };
}

export async function createFolder(
  ctx: FsContext,
  path: string,
  mode?: string,
): Promise<FsOutcome<{ ok: true }>> {
  const cmd = `mkdir -p ${sq(path)}${mode ? ` && chmod ${sq(mode)} ${sq(path)}` : ''}`;
  const res = await runShell(ctx, cmd);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'mkdir failed');
  return { ok: true };
}

export async function deleteFile(
  ctx: FsContext,
  path: string,
  recursive = false,
): Promise<FsOutcome<{ ok: true }>> {
  const res = await runShell(ctx, `rm -${recursive ? 'rf' : 'f'} ${sq(path)}`);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'delete failed');
  return { ok: true };
}

export async function moveFile(
  ctx: FsContext,
  source: string,
  destination: string,
): Promise<FsOutcome<{ ok: true }>> {
  const dir = destination.replace(/\/[^/]*$/, '');
  const prep = dir && dir !== destination ? `mkdir -p ${sq(dir)} && ` : '';
  const res = await runShell(ctx, `${prep}mv ${sq(source)} ${sq(destination)}`);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'move failed');
  return { ok: true };
}

export async function setPermissions(
  ctx: FsContext,
  path: string,
  mode?: string,
  owner?: string,
  group?: string,
): Promise<FsOutcome<{ ok: true }>> {
  const parts: string[] = [];
  if (mode) parts.push(`chmod ${sq(mode)} ${sq(path)}`);
  if (owner || group) parts.push(`chown ${sq(`${owner ?? ''}${group ? `:${group}` : ''}`)} ${sq(path)}`);
  if (parts.length === 0) return { ok: true };
  const res = await runShell(ctx, parts.join(' && '));
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'set-permissions failed');
  return { ok: true };
}

export interface FindMatch {
  file: string;
  line: number;
  content: string;
}

export async function findInFiles(
  ctx: FsContext,
  path: string,
  pattern: string,
): Promise<FsOutcome<{ matches: FindMatch[] }>> {
  // grep -rnI: recursive, line numbers, skip binaries. -F: fixed string.
  const res = await runShell(ctx, `grep -rnIF -- ${sq(pattern)} ${sq(path)} 2>/dev/null | head -n 1000 || true`);
  if (!res) return null;
  const matches: FindMatch[] = [];
  for (const raw of res.stdout.split('\n')) {
    if (!raw) continue;
    const m = raw.match(/^(.*?):(\d+):(.*)$/);
    if (m) matches.push({ file: m[1], line: Number(m[2]), content: m[3] });
  }
  return { matches };
}

export interface ReplaceResult {
  file: string;
  success: boolean;
  error?: string;
}

export async function replaceInFiles(
  ctx: FsContext,
  files: string[],
  pattern: string,
  newValue: string,
): Promise<FsOutcome<{ results: ReplaceResult[] }>> {
  const script = `
import os, json, base64
files = json.loads(os.environ['__FILES'])
pat = base64.b64decode(os.environ['__PAT']).decode('utf-8')
rep = base64.b64decode(os.environ['__REP']).decode('utf-8')
out = []
for f in files:
    try:
        with open(f, 'r', encoding='utf-8') as fh: data = fh.read()
        with open(f, 'w', encoding='utf-8') as fh: fh.write(data.replace(pat, rep))
        out.append({"file": f, "success": True})
    except Exception as e:
        out.append({"file": f, "success": False, "error": str(e)})
print(json.dumps({"results": out}))
`;
  const res = await runPython(ctx, script, {
    __FILES: JSON.stringify(files),
    __PAT: b64(pattern),
    __REP: b64(newValue),
  });
  if (!res) return null;
  return parseJson<{ results: ReplaceResult[] }>(res.stdout, res.stderr);
}
