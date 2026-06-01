/**
 * Sandbox instance orchestration: resolve a template into a concrete spec,
 * place it on a runner, and drive its lifecycle through the command queue.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type {
  ISandboxInstance,
  ISandboxRunner,
  ISandboxTemplate,
  ISandboxVolume,
} from '@/lib/database/provider.interface';
import type {
  SandboxInstanceSpec,
  SandboxIsolation,
  SandboxPreviewPort,
  SandboxRuntimeKind,
  SandboxVolumeMountSpec,
} from '@cognipeer/sandbox-protocol';
import { enqueueCommand } from './commandQueue';
import { createTerminalSession } from './terminalSessionManager';
import { DEFAULT_TERMINAL_TTL_SECONDS } from './settingsService';
import { isRunnerManaged } from './localRunnerManager';

const log = createLogger('sandbox:instance');

/** A runner is only usable if an agent is actually polling it: either the
 *  console manages it locally, or it sent a heartbeat recently. */
const RUNNER_STALE_MS = 90_000;
export function isRunnerLive(runner: ISandboxRunner): boolean {
  if (isRunnerManaged(runner.id)) return true;
  if (runner.status !== 'online') return false;
  return Boolean(runner.lastSeenAt && Date.now() - new Date(runner.lastSeenAt).getTime() < RUNNER_STALE_MS);
}

async function withTenantDb(tenantDbName: string) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

async function pickRunner(tenantDbName: string, runnerId?: string | null): Promise<ISandboxRunner> {
  const db = await withTenantDb(tenantDbName);
  if (runnerId) {
    const runner = await db.getSandboxRunner(runnerId);
    if (!runner) throw new Error(`sandbox runner not found: ${runnerId}`);
    if (!isRunnerLive(runner)) throw new Error(`sandbox runner is not running: ${runner.name}`);
    return runner;
  }
  const runners = await db.listSandboxRunners();
  // Pick a runner that actually has a live agent — a stale 'online' record
  // (e.g. after a crash) would silently swallow commands and leave the sandbox
  // stuck in 'pending'.
  const live = runners.find(isRunnerLive);
  if (!live) throw new Error('no online sandbox runner available');
  return live;
}

function resolveSpec(
  instance: ISandboxInstance,
  template: ISandboxTemplate,
  volume: ISandboxVolume | null,
): SandboxInstanceSpec {
  const volumeMounts = [...(template.volumeMounts as unknown as SandboxVolumeMountSpec[])];
  if (volume) {
    volumeMounts.push({
      mountPath: '/workspace',
      provider: volume.provider,
      container: volume.container,
      prefix: volume.prefix,
    });
  }
  return {
    instanceId: instance.id,
    templateId: template.id,
    image: template.baseImage,
    runtime: template.runtime as SandboxRuntimeKind,
    isolation: instance.isolation as SandboxIsolation,
    resources: template.resources,
    // Per-instance env overrides template env.
    env: { ...template.env, ...instance.env },
    entrypoint: template.entrypoint ?? undefined,
    toolboxPort: template.toolboxPort,
    previewPorts: template.previewPorts as unknown as SandboxPreviewPort[],
    volumeMounts,
    labels: {
      'cognipeer.sandbox.instanceId': instance.id,
      'cognipeer.sandbox.templateId': template.id,
    },
  };
}

export interface CreateInstanceInput {
  templateId: string;
  name: string;
  runnerId?: string | null;
  volumeId?: string | null;
  projectId?: string | null;
  /** Per-instance environment variables (override template env). */
  env?: Record<string, string>;
}

export async function createInstance(
  tenantDbName: string,
  tenantId: string,
  input: CreateInstanceInput,
  createdBy: string,
): Promise<ISandboxInstance> {
  const db = await withTenantDb(tenantDbName);
  const template = await db.getSandboxTemplate(input.templateId);
  if (!template) throw new Error(`sandbox template not found: ${input.templateId}`);
  const runner = await pickRunner(tenantDbName, input.runnerId);
  const volume = input.volumeId ? await db.getSandboxVolume(input.volumeId) : null;

  const now = new Date();
  const instance = await db.createSandboxInstance({
    id: randomUUID(),
    tenantId,
    projectId: input.projectId ?? template.projectId ?? null,
    templateId: template.id,
    runnerId: runner.id,
    name: input.name,
    containerId: null,
    desiredState: 'running',
    actualState: 'pending',
    volumeId: volume?.id ?? null,
    toolboxPort: template.toolboxPort,
    previewPorts: template.previewPorts,
    isolation: template.isolation,
    env: input.env ?? {},
    lastError: null,
    lastActivityAt: now,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });

  const spec = resolveSpec(instance, template, volume);
  await enqueueCommand({
    tenantDbName,
    tenantId,
    runnerId: runner.id,
    instanceId: instance.id,
    kind: 'create-sandbox',
    payload: { spec },
    createdBy,
  });
  log.info('sandbox instance created', { instanceId: instance.id, runnerId: runner.id });
  return instance;
}

/**
 * Re-issue the create command for an instance that should be running. Used by
 * boot reconciliation: after a console/agent restart the agent's create handler
 * is idempotent (reuses an existing container, or recreates a missing one), so
 * this converges the live state back to `running` without user action.
 */
export async function redriveInstance(tenantDbName: string, tenantId: string, instanceId: string): Promise<boolean> {
  const db = await withTenantDb(tenantDbName);
  const instance = await db.getSandboxInstance(instanceId);
  if (!instance || !instance.runnerId) return false;
  const template = await db.getSandboxTemplate(instance.templateId);
  if (!template) return false;
  const volume = instance.volumeId ? await db.getSandboxVolume(instance.volumeId) : null;
  const spec = resolveSpec(instance, template, volume);
  await enqueueCommand({
    tenantDbName,
    tenantId,
    runnerId: instance.runnerId,
    instanceId: instance.id,
    kind: 'create-sandbox',
    payload: { spec },
    createdBy: 'system:reconcile',
  });
  log.info('sandbox instance redriven', { instanceId: instance.id, runnerId: instance.runnerId });
  return true;
}

export async function listInstances(
  tenantDbName: string,
  filters?: { projectId?: string; runnerId?: string },
): Promise<ISandboxInstance[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listSandboxInstances(filters);
}

export async function getInstance(tenantDbName: string, id: string): Promise<ISandboxInstance | null> {
  const db = await withTenantDb(tenantDbName);
  return db.getSandboxInstance(id);
}

async function changeLifecycle(
  tenantDbName: string,
  tenantId: string,
  id: string,
  desiredState: 'running' | 'stopped' | 'deleted',
  kind: 'start-sandbox' | 'stop-sandbox' | 'delete-sandbox',
  createdBy: string,
): Promise<ISandboxInstance | null> {
  const db = await withTenantDb(tenantDbName);
  const instance = await db.getSandboxInstance(id);
  if (!instance || !instance.runnerId) return null;
  await db.updateSandboxInstance(id, { desiredState });
  await enqueueCommand({
    tenantDbName,
    tenantId,
    runnerId: instance.runnerId,
    instanceId: id,
    kind,
    payload: { instanceId: id },
    createdBy,
  });
  return db.getSandboxInstance(id);
}

export async function startInstance(tenantDbName: string, tenantId: string, id: string, by: string) {
  return changeLifecycle(tenantDbName, tenantId, id, 'running', 'start-sandbox', by);
}

export async function stopInstance(tenantDbName: string, tenantId: string, id: string, by: string) {
  return changeLifecycle(tenantDbName, tenantId, id, 'stopped', 'stop-sandbox', by);
}

export async function deleteInstance(tenantDbName: string, tenantId: string, id: string, by: string) {
  return changeLifecycle(tenantDbName, tenantId, id, 'deleted', 'delete-sandbox', by);
}

export interface OpenTerminalInput {
  cwd?: string;
  cols?: number;
  rows?: number;
  shell?: string;
}

export async function openTerminal(args: {
  tenantDbName: string;
  tenantId: string;
  tenantSlug: string;
  instanceId: string;
  openedBy: string;
  input?: OpenTerminalInput;
}): Promise<{ sessionId: string; websocketPath: string; expiresAt: string } | null> {
  const db = await withTenantDb(args.tenantDbName);
  const instance = await db.getSandboxInstance(args.instanceId);
  if (!instance || !instance.runnerId) return null;

  const settings = await db.getSandboxSettings();
  const ttlSeconds = settings?.terminalSessionTtlSeconds ?? DEFAULT_TERMINAL_TTL_SECONDS;

  const session = createTerminalSession({
    tenantId: args.tenantId,
    tenantDbName: args.tenantDbName,
    tenantSlug: args.tenantSlug,
    runnerId: instance.runnerId,
    instanceId: instance.id,
    cwd: args.input?.cwd ?? null,
    shell: args.input?.shell ?? null,
    cols: args.input?.cols,
    rows: args.input?.rows,
    ttlSeconds,
    openedBy: args.openedBy,
  });

  await enqueueCommand({
    tenantDbName: args.tenantDbName,
    tenantId: args.tenantId,
    runnerId: instance.runnerId,
    instanceId: instance.id,
    kind: 'open-terminal-session',
    payload: {
      sessionId: session.sessionId,
      instanceId: instance.id,
      cwd: session.cwd ?? undefined,
      shell: session.shell ?? undefined,
      ttlSeconds,
      cols: session.cols,
      rows: session.rows,
    },
    createdBy: args.openedBy,
  });

  return {
    sessionId: session.sessionId,
    websocketPath: `/api/sandbox/terminal/${session.sessionId}/browser`,
    expiresAt: session.expiresAt.toISOString(),
  };
}
