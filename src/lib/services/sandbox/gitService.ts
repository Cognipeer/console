/**
 * Sandbox git operations (Daytona-style), implemented on top of the existing
 * exec path. Each operation shells out to `git` inside the container and parses
 * its output into a minimal structured response.
 */

import { execInSandbox } from './execService';
import type { FsContext, FsOutcome } from './fileService';

function sq(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function git(ctx: FsContext, command: string, timeoutSec = 120) {
  return execInSandbox({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    instanceId: ctx.instanceId,
    command,
    timeoutSec,
    by: ctx.by,
  });
}

/** Inject basic-auth credentials into an https clone/remote URL. */
function withCredentials(url: string, username?: string, password?: string): string {
  if (!username && !password) return url;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      if (username) u.username = encodeURIComponent(username);
      if (password) u.password = encodeURIComponent(password);
      return u.toString();
    }
  } catch {
    /* not a URL we can rewrite */
  }
  return url;
}

export async function cloneRepo(
  ctx: FsContext,
  args: { url: string; path: string; branch?: string; username?: string; password?: string },
): Promise<FsOutcome<{ ok: true; path: string }>> {
  const url = withCredentials(args.url, args.username, args.password);
  const branch = args.branch ? `-b ${sq(args.branch)} ` : '';
  const res = await git(ctx, `git clone ${branch}${sq(url)} ${sq(args.path)} 2>&1`, 600);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stdout.trim() || res.stderr.trim() || 'clone failed');
  return { ok: true, path: args.path };
}

export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  files: Array<{ path: string; status: string }>;
}

export async function status(ctx: FsContext, path: string): Promise<FsOutcome<GitStatus>> {
  const res = await git(ctx, `git -C ${sq(path)} status --porcelain=v1 -b`);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'status failed');
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: Array<{ path: string; status: string }> = [];
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('##')) {
      const head = line.slice(3).trim();
      branch = head.split('...')[0].split(' ')[0] || null;
      const a = head.match(/ahead (\d+)/);
      const b = head.match(/behind (\d+)/);
      if (a) ahead = Number(a[1]);
      if (b) behind = Number(b[1]);
    } else {
      files.push({ status: line.slice(0, 2).trim(), path: line.slice(3) });
    }
  }
  return { branch, ahead, behind, files };
}

export async function listBranches(ctx: FsContext, path: string): Promise<FsOutcome<{ branches: string[] }>> {
  const res = await git(ctx, `git -C ${sq(path)} branch --format=%(refname:short)`);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'branches failed');
  return { branches: res.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
}

export async function createBranch(ctx: FsContext, path: string, name: string): Promise<FsOutcome<{ ok: true }>> {
  const res = await git(ctx, `git -C ${sq(path)} branch ${sq(name)}`);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'create-branch failed');
  return { ok: true };
}

export async function deleteBranch(ctx: FsContext, path: string, name: string): Promise<FsOutcome<{ ok: true }>> {
  const res = await git(ctx, `git -C ${sq(path)} branch -D ${sq(name)}`);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'delete-branch failed');
  return { ok: true };
}

export async function checkout(ctx: FsContext, path: string, branch: string): Promise<FsOutcome<{ ok: true }>> {
  const res = await git(ctx, `git -C ${sq(path)} checkout ${sq(branch)} 2>&1`);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stdout.trim() || 'checkout failed');
  return { ok: true };
}

export async function add(ctx: FsContext, path: string, files: string[]): Promise<FsOutcome<{ ok: true }>> {
  const spec = files.length ? files.map(sq).join(' ') : '-A';
  const res = await git(ctx, `git -C ${sq(path)} add -- ${spec}`);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'add failed');
  return { ok: true };
}

export async function commit(
  ctx: FsContext,
  args: { path: string; message: string; author: string; email: string; allowEmpty?: boolean },
): Promise<FsOutcome<{ hash: string }>> {
  const empty = args.allowEmpty ? '--allow-empty ' : '';
  const res = await git(
    ctx,
    `git -C ${sq(args.path)} -c user.name=${sq(args.author)} -c user.email=${sq(args.email)} ` +
      `commit ${empty}-m ${sq(args.message)} 2>&1 && git -C ${sq(args.path)} rev-parse HEAD`,
  );
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stdout.trim() || 'commit failed');
  const hash = res.stdout.trim().split('\n').pop() ?? '';
  return { hash };
}

export async function push(
  ctx: FsContext,
  args: { path: string; username?: string; password?: string },
): Promise<FsOutcome<{ ok: true }>> {
  const res = await runRemote(ctx, args, 'push');
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stdout.trim() || res.stderr.trim() || 'push failed');
  return { ok: true };
}

export async function pull(
  ctx: FsContext,
  args: { path: string; username?: string; password?: string },
): Promise<FsOutcome<{ ok: true }>> {
  const res = await runRemote(ctx, args, 'pull');
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stdout.trim() || res.stderr.trim() || 'pull failed');
  return { ok: true };
}

/** push/pull with optional credentials temporarily injected into the remote URL. */
async function runRemote(
  ctx: FsContext,
  args: { path: string; username?: string; password?: string },
  op: 'push' | 'pull',
) {
  const p = sq(args.path);
  if (!args.username && !args.password) {
    return git(ctx, `git -C ${p} ${op} 2>&1`, 300);
  }
  // Read origin, run with an authenticated URL, then restore origin — so the
  // credentials never persist in the repo config. The URL is rewritten inside
  // the container (we don't know origin on the host).
  const py =
    `python3 -c 'import os,urllib.parse as u; url=u.urlparse(os.environ["__ORIG"]); ` +
    `host=url.netloc.split("@")[-1]; ` +
    `cred=os.environ.get("__USER","")+((":"+os.environ["__PASS"]) if os.environ.get("__PASS") else ""); ` +
    `nl=(cred+"@"+host) if cred else host; ` +
    `print(u.urlunparse(url._replace(netloc=nl)) if url.scheme in ("http","https") else "")'`;
  const composed =
    `ORIG=$(git -C ${p} remote get-url origin 2>/dev/null); export __ORIG="$ORIG"; ` +
    `AUTH=$(${py} 2>/dev/null); ` +
    `if [ -n "$AUTH" ]; then git -C ${p} remote set-url origin "$AUTH"; fi; ` +
    `git -C ${p} ${op} 2>&1; RC=$?; ` +
    `if [ -n "$ORIG" ]; then git -C ${p} remote set-url origin "$ORIG"; fi; exit $RC`;
  return execInSandbox({
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    instanceId: ctx.instanceId,
    command: composed,
    env: { __USER: args.username ?? '', __PASS: args.password ?? '' },
    timeoutSec: 300,
    by: ctx.by,
  });
}

export interface GitLogEntry {
  hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export async function log(ctx: FsContext, path: string, limit = 30): Promise<FsOutcome<{ commits: GitLogEntry[] }>> {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  // Unit separator (\x1f) between fields, record separator (\x1e) between rows.
  const res = await git(ctx, `git -C ${sq(path)} log -n ${n} --pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e`);
  if (!res) return null;
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'log failed');
  const commits: GitLogEntry[] = [];
  for (const row of res.stdout.split('\x1e')) {
    const r = row.replace(/^\n/, '');
    if (!r.trim()) continue;
    const [hash, author, email, date, message] = r.split('\x1f');
    if (hash) commits.push({ hash, author, email, date, message: message ?? '' });
  }
  return { commits };
}
