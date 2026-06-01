/**
 * Local (managed) runner control.
 *
 * For single-host / self-hosted setups where Docker runs on the same machine as
 * the console, the console can start/stop the runner agent itself — no manual
 * shell step. "Start" rotates the runner's registration token and spawns the
 * Docker-CLI agent as a child process pointed back at this console; "Stop" kills
 * it and marks the runner offline.
 *
 * Process handles live in-memory (per console process). This is intentionally a
 * dev/self-hosted convenience; multi-host fleets run the agent out-of-band.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { rotateRunnerToken } from './runnerService';

const log = createLogger('sandbox:local-runner');

/** Agent entrypoint. Defaults to the bundled Docker-CLI test agent. */
const AGENT_SCRIPT = process.env.SANDBOX_AGENT_SCRIPT || 'scripts/sb-test-agent.mjs';

const PROCS = new Map<string, ChildProcess>();

export function isRunnerManaged(runnerId: string): boolean {
  const p = PROCS.get(runnerId);
  return Boolean(p && !p.killed);
}

export function listManagedRunnerIds(): string[] {
  return [...PROCS.entries()].filter(([, p]) => !p.killed).map(([id]) => id);
}

export async function startLocalRunner(args: {
  tenantDbName: string;
  tenantSlug: string;
  runnerId: string;
  consoleUrl: string;
}): Promise<void> {
  if (isRunnerManaged(args.runnerId)) return;

  // Fresh registration token; the agent exchanges it for an agent token.
  const rotated = await rotateRunnerToken(args.tenantDbName, args.runnerId);
  if (!rotated) throw new Error('runner-not-found');

  // Capture agent output to a log file for diagnostics (managed runners).
  const logPath = path.join(os.tmpdir(), `cognipeer-sandbox-agent-${args.runnerId}.log`);
  let outFd: number;
  try {
    outFd = openSync(logPath, 'a');
  } catch {
    outFd = 1;
  }
  const child = spawn('node', [AGENT_SCRIPT], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONSOLE_URL: args.consoleUrl,
      TENANT_SLUG: args.tenantSlug,
      REGISTRATION_TOKEN: rotated.registrationToken,
    },
    stdio: ['ignore', outFd, outFd],
  });
  PROCS.set(args.runnerId, child);
  child.on('exit', (code) => {
    PROCS.delete(args.runnerId);
    log.info('local runner process exited', { runnerId: args.runnerId, code });
  });

  // Persist a "managed" marker so the console can re-spawn this agent after a
  // restart (the in-memory PROCS map does not survive a process restart).
  try {
    const db = await getDatabase();
    await db.switchToTenant(args.tenantDbName);
    const runner = await db.getSandboxRunner(args.runnerId);
    await db.updateSandboxRunner(args.runnerId, {
      labels: { ...(runner?.labels ?? {}), managed: 'true' },
    });
  } catch (error) {
    log.warn('failed to persist managed marker', { runnerId: args.runnerId, error: String(error) });
  }

  log.info('local runner started', { runnerId: args.runnerId, pid: child.pid, script: AGENT_SCRIPT });
}

export async function stopLocalRunner(tenantDbName: string, runnerId: string): Promise<void> {
  const p = PROCS.get(runnerId);
  if (p && !p.killed) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  PROCS.delete(runnerId);
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const runner = await db.getSandboxRunner(runnerId);
  const labels = { ...(runner?.labels ?? {}) };
  delete (labels as Record<string, string>).managed;
  await db.updateSandboxRunner(runnerId, { status: 'offline', labels });
  log.info('local runner stopped', { runnerId });
}
