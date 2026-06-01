/**
 * Synchronous exec / code execution against a running sandbox.
 *
 * Dispatches an `exec` / `code-run` command through the queue and awaits the
 * correlated `exec-result` event (see execBridge). Designed for AI-agent
 * callers: pass a command, get the result.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@/lib/database';
import { enqueueCommand } from './commandQueue';
import { awaitExecResult, type ExecResult } from './execBridge';

const DEFAULT_TIMEOUT_SEC = 60;

async function resolveTarget(
  tenantDbName: string,
  instanceId: string,
): Promise<{ runnerId: string | null; state: string | null }> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const instance = await db.getSandboxInstance(instanceId);
  return { runnerId: instance?.runnerId ?? null, state: instance?.actualState ?? null };
}

const notReady = (state: string | null): ExecResult => ({
  exitCode: -1,
  stdout: '',
  stderr: state ? `sandbox is not running (state: ${state})` : 'sandbox not found',
});

export async function execInSandbox(args: {
  tenantDbName: string;
  tenantId: string;
  instanceId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  by: string;
}): Promise<ExecResult | null> {
  const { runnerId, state } = await resolveTarget(args.tenantDbName, args.instanceId);
  if (!runnerId) return null;
  if (state !== 'running') return notReady(state);
  const execId = randomUUID();
  const timeoutSec = args.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const waiter = awaitExecResult(execId, timeoutSec * 1000 + 5000);
  await enqueueCommand({
    tenantDbName: args.tenantDbName,
    tenantId: args.tenantId,
    runnerId,
    instanceId: args.instanceId,
    kind: 'exec',
    payload: { instanceId: args.instanceId, execId, command: args.command, cwd: args.cwd, env: args.env, timeoutSec },
    createdBy: args.by,
  });
  return waiter;
}

export async function codeRunInSandbox(args: {
  tenantDbName: string;
  tenantId: string;
  instanceId: string;
  code: string;
  language?: 'python' | 'javascript' | 'typescript' | 'bash';
  cwd?: string;
  timeoutSec?: number;
  by: string;
}): Promise<ExecResult | null> {
  const { runnerId, state } = await resolveTarget(args.tenantDbName, args.instanceId);
  if (!runnerId) return null;
  if (state !== 'running') return notReady(state);
  const execId = randomUUID();
  const timeoutSec = args.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const waiter = awaitExecResult(execId, timeoutSec * 1000 + 5000);
  await enqueueCommand({
    tenantDbName: args.tenantDbName,
    tenantId: args.tenantId,
    runnerId,
    instanceId: args.instanceId,
    kind: 'code-run',
    payload: { instanceId: args.instanceId, execId, code: args.code, language: args.language ?? 'python', cwd: args.cwd, timeoutSec },
    createdBy: args.by,
  });
  return waiter;
}
