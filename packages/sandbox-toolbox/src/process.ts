/**
 * Process + code execution for the toolbox daemon.
 *
 *  - exec:     run a shell command, capture stdout/stderr, bounded by timeout.
 *  - codeRun:  write a snippet to a temp file and run it with the right
 *              interpreter (stateless).
 *  - sessions: long-running background shells; commands run async, logs are
 *              buffered and polled.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SANDBOX_ROOT, resolveInRoot } from './paths';
import type { CodeLanguage, ExecResponse } from '@cognipeer/sandbox-protocol';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
}

export async function exec(command: string, opts: ExecOptions = {}): Promise<ExecResponse> {
  const started = Date.now();
  const cwd = opts.cwd ? resolveInRoot(opts.cwd) : SANDBOX_ROOT;
  return new Promise<ExecResponse>((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    const timeoutMs = (opts.timeoutSec ?? 120) * 1000;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, durationMs: Date.now() - started });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err), durationMs: Date.now() - started });
    });
  });
}

const INTERPRETER: Record<CodeLanguage, { ext: string; cmd: (file: string) => string }> = {
  python: { ext: 'py', cmd: (f) => `python3 ${f}` },
  javascript: { ext: 'js', cmd: (f) => `node ${f}` },
  typescript: { ext: 'ts', cmd: (f) => `npx --yes tsx ${f}` },
  bash: { ext: 'sh', cmd: (f) => `bash ${f}` },
};

export async function codeRun(
  code: string,
  language: CodeLanguage = 'python',
  opts: ExecOptions = {},
): Promise<ExecResponse> {
  const spec = INTERPRETER[language] ?? INTERPRETER.python;
  const file = path.join(os.tmpdir(), `sbx-${randomUUID()}.${spec.ext}`);
  await fs.writeFile(file, code, 'utf8');
  try {
    return await exec(spec.cmd(file), opts);
  } finally {
    await fs.rm(file, { force: true });
  }
}

/* ----------------------------- Sessions ----------------------------- */

interface SessionCommand {
  id: string;
  command: string;
  exitCode: number | null;
  log: string;
}
interface Session {
  sessionId: string;
  commands: Map<string, SessionCommand>;
}

const SESSIONS = new Map<string, Session>();

export function createSession(sessionId: string): void {
  if (!SESSIONS.has(sessionId)) SESSIONS.set(sessionId, { sessionId, commands: new Map() });
}

export function deleteSession(sessionId: string): void {
  SESSIONS.delete(sessionId);
}

export function getSession(sessionId: string): { sessionId: string; commands: SessionCommand[] } | null {
  const s = SESSIONS.get(sessionId);
  if (!s) return null;
  return { sessionId, commands: [...s.commands.values()] };
}

export function listSessions(): string[] {
  return [...SESSIONS.keys()];
}

export async function execInSession(
  sessionId: string,
  command: string,
  runAsync: boolean,
): Promise<{ commandId: string; exitCode?: number }> {
  const session = SESSIONS.get(sessionId);
  if (!session) throw new Error('session-not-found');
  const id = randomUUID();
  const record: SessionCommand = { id, command, exitCode: null, log: '' };
  session.commands.set(id, record);

  const child = spawn('/bin/sh', ['-c', command], {
    cwd: SANDBOX_ROOT,
    env: { ...process.env },
  });
  child.stdout.on('data', (d) => (record.log += d.toString()));
  child.stderr.on('data', (d) => (record.log += d.toString()));
  const done = new Promise<number>((resolve) => {
    child.on('close', (code) => {
      record.exitCode = code ?? -1;
      resolve(record.exitCode);
    });
    child.on('error', () => {
      record.exitCode = -1;
      resolve(-1);
    });
  });

  if (runAsync) return { commandId: id };
  const exitCode = await done;
  return { commandId: id, exitCode };
}

export function getSessionCommandLog(sessionId: string, commandId: string): string | null {
  const session = SESSIONS.get(sessionId);
  if (!session) return null;
  return session.commands.get(commandId)?.log ?? null;
}
