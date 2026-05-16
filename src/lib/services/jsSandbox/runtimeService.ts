import { createHash, randomUUID } from 'node:crypto';
import slugify from 'slugify';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { getDatabase, type DatabaseProvider, type IJsSandboxRuntime, type IJsSandboxRuntimeLimits } from '@/lib/database';
import { jsSandboxExecutorManager } from './executorManager';
import { normalizeSandboxLibraries } from './libraries';
import type {
  CreateJsSandboxRuntimeInput,
  ExecuteJsSandboxInput,
  JsSandboxContext,
  JsSandboxExecutionView,
  JsSandboxRuntimeView,
  UpdateJsSandboxRuntimeInput,
} from './types';

const logger = createLogger('js-sandbox:service');
const KEY_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;
const PREVIEW_LIMIT = 1_000;

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function matchesProjectScope(recordProjectId: string | undefined, activeProjectId: string | undefined): boolean {
  const record = recordProjectId?.trim() || undefined;
  const active = activeProjectId?.trim() || undefined;
  if (!record && !active) return true;
  if (!record || !active) return false;
  return record === active;
}

function canAccessRuntime(ctx: JsSandboxContext, record: IJsSandboxRuntime | null | undefined): record is IJsSandboxRuntime {
  return Boolean(
    record
    && record.tenantId === ctx.tenantId
    && matchesProjectScope(record.projectId, ctx.projectId),
  );
}

function serializeRuntime(record: IJsSandboxRuntime): JsSandboxRuntimeView {
  const { _id, ...rest } = record;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : _id?.toString() ?? '',
  };
}

function serializeExecution(record: import('@/lib/database').IJsSandboxExecution): JsSandboxExecutionView {
  const { _id, ...rest } = record;
  return {
    ...rest,
    id: typeof _id === 'string' ? _id : _id?.toString() ?? '',
  };
}

function getDefaultLimits(): IJsSandboxRuntimeLimits {
  const cfg = getConfig().jsSandbox;
  return {
    defaultTimeoutMs: cfg.defaultTimeoutMs,
    maxTimeoutMs: cfg.maxTimeoutMs,
    memoryLimitMb: cfg.memoryLimitMb,
    maxCodeSizeBytes: cfg.maxCodeSizeBytes,
    maxResultSizeBytes: cfg.maxResultSizeBytes,
    maxLogEntries: cfg.maxLogEntries,
  };
}

function mergeLimits(input?: Partial<IJsSandboxRuntimeLimits>): IJsSandboxRuntimeLimits {
  const defaults = getDefaultLimits();
  const merged = { ...defaults, ...(input ?? {}) };
  return {
    defaultTimeoutMs: Math.min(Math.max(merged.defaultTimeoutMs, 100), merged.maxTimeoutMs),
    maxTimeoutMs: Math.max(merged.maxTimeoutMs, 100),
    memoryLimitMb: Math.min(Math.max(merged.memoryLimitMb, 8), 512),
    maxCodeSizeBytes: Math.min(Math.max(merged.maxCodeSizeBytes, 1_024), 1024 * 1024),
    maxResultSizeBytes: Math.min(Math.max(merged.maxResultSizeBytes, 1_024), 5 * 1024 * 1024),
    maxLogEntries: Math.min(Math.max(merged.maxLogEntries, 0), 1_000),
  };
}

function normalizeKey(value: string | undefined): string {
  const base = slugify(value?.trim().length ? value : 'js-runtime', KEY_OPTIONS);
  return base || 'js-runtime';
}

async function generateUniqueRuntimeKey(
  db: DatabaseProvider,
  tenantId: string,
  desired: string | undefined,
  projectId?: string,
): Promise<string> {
  const base = normalizeKey(desired);
  let attempt = 0;
  let candidate = base;
  while (attempt < MAX_KEY_ATTEMPTS) {
    const existing = await db.findJsSandboxRuntimeByKey(tenantId, candidate, projectId);
    if (!existing) return candidate;
    attempt += 1;
    candidate = `${base}-${attempt + 1}`;
  }
  throw new Error('Could not generate unique JS runtime key');
}

function preview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (!raw) return undefined;
  return raw.length > PREVIEW_LIMIT ? `${raw.slice(0, PREVIEW_LIMIT)}...` : raw;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

async function resolveRuntimeRecord(ctx: JsSandboxContext, idOrKey: string): Promise<IJsSandboxRuntime | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record =
    (await db.findJsSandboxRuntimeById(idOrKey).catch(() => null)) ??
    (await db.findJsSandboxRuntimeByKey(ctx.tenantId, idOrKey, ctx.projectId));
  return canAccessRuntime(ctx, record) ? record : null;
}

export async function createJsSandboxRuntime(
  ctx: JsSandboxContext,
  input: CreateJsSandboxRuntimeInput,
): Promise<JsSandboxRuntimeView> {
  const db = await withTenantDb(ctx.tenantDbName);
  const key = await generateUniqueRuntimeKey(db, ctx.tenantId, input.key ?? input.name, ctx.projectId);
  const created = await db.createJsSandboxRuntime({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    key,
    name: input.name,
    description: input.description,
    status: input.status ?? 'active',
    engine: 'isolated-vm',
    libraries: normalizeSandboxLibraries(input.libraries),
    limits: mergeLimits(input.limits),
    network: {
      enabled: input.network?.enabled ?? false,
      allowList: input.network?.allowList ?? [],
    },
    metadata: input.metadata,
    createdBy: input.createdBy,
  });
  logger.info('JS Sandbox runtime created', { runtimeId: created._id, key });
  return serializeRuntime(created);
}

export async function listJsSandboxRuntimes(
  ctx: JsSandboxContext,
  filters?: { status?: string; search?: string },
): Promise<JsSandboxRuntimeView[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const records = await db.listJsSandboxRuntimes(ctx.tenantId, {
    projectId: ctx.projectId,
    status: filters?.status,
    search: filters?.search,
  });
  return records.map(serializeRuntime);
}

export async function getJsSandboxRuntime(
  ctx: JsSandboxContext,
  idOrKey: string,
): Promise<JsSandboxRuntimeView | null> {
  const record = await resolveRuntimeRecord(ctx, idOrKey);
  return record ? serializeRuntime(record) : null;
}

export async function updateJsSandboxRuntime(
  ctx: JsSandboxContext,
  idOrKey: string,
  input: UpdateJsSandboxRuntimeInput,
): Promise<JsSandboxRuntimeView | null> {
  const existing = await resolveRuntimeRecord(ctx, idOrKey);
  if (!existing) return null;
  const db = await withTenantDb(ctx.tenantDbName);
  const updated = await db.updateJsSandboxRuntime(String(existing._id ?? ''), {
    name: input.name,
    description: input.description,
    status: input.status,
    libraries: input.libraries === undefined ? undefined : normalizeSandboxLibraries(input.libraries),
    limits: input.limits === undefined ? undefined : mergeLimits({ ...existing.limits, ...input.limits }),
    network: input.network === undefined
      ? undefined
      : {
          enabled: input.network.enabled ?? existing.network.enabled,
          allowList: input.network.allowList ?? existing.network.allowList ?? [],
        },
    metadata: input.metadata,
    updatedBy: input.updatedBy,
  });
  return updated ? serializeRuntime(updated) : null;
}

export async function deleteJsSandboxRuntime(
  ctx: JsSandboxContext,
  idOrKey: string,
): Promise<boolean> {
  const existing = await resolveRuntimeRecord(ctx, idOrKey);
  if (!existing) return false;
  const db = await withTenantDb(ctx.tenantDbName);
  return db.deleteJsSandboxRuntime(String(existing._id ?? ''));
}

export async function executeJsSandboxCode(
  ctx: JsSandboxContext,
  input: ExecuteJsSandboxInput,
): Promise<JsSandboxExecutionView> {
  const runtime = await resolveRuntimeRecord(ctx, input.jsRuntimeId);
  if (!runtime) {
    throw new Error('JS runtime not found');
  }
  if (runtime.status !== 'active') {
    throw new Error(`JS runtime ${runtime.key} is not active`);
  }

  const codeSize = Buffer.byteLength(input.code, 'utf8');
  if (codeSize > runtime.limits.maxCodeSizeBytes) {
    throw new Error(`Code size (${codeSize} bytes) exceeds runtime limit (${runtime.limits.maxCodeSizeBytes} bytes)`);
  }

  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? runtime.limits.defaultTimeoutMs, 100),
    runtime.limits.maxTimeoutMs,
  );
  const started = Date.now();
  const workerResult = await jsSandboxExecutorManager.execute(ctx.tenantId, {
    code: input.code,
    input: input.input,
    libraries: runtime.libraries,
    timeoutMs,
    memoryLimitMb: runtime.limits.memoryLimitMb,
    maxResultSizeBytes: runtime.limits.maxResultSizeBytes,
    maxLogEntries: runtime.limits.maxLogEntries,
  });

  const db = await withTenantDb(ctx.tenantDbName);
  const saved = await db.createJsSandboxExecution({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    runtimeId: String(runtime._id ?? ''),
    runtimeKey: runtime.key,
    executionId: `exec_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    status: workerResult.status,
    durationMs: Date.now() - started,
    timeoutMs,
    memoryLimitMb: runtime.limits.memoryLimitMb,
    codeHash: hashCode(input.code),
    codePreview: preview(input.code) ?? '',
    inputPreview: preview(input.input),
    result: workerResult.status === 'success' ? workerResult.result : undefined,
    logs: workerResult.logs,
    errorMessage: workerResult.errorMessage,
    callerType: input.callerType,
    callerTokenId: input.callerTokenId,
  });

  return serializeExecution(saved);
}

export async function listJsSandboxExecutions(
  ctx: JsSandboxContext,
  filters?: {
    runtimeId?: string;
    runtimeKey?: string;
    status?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    skip?: number;
  },
): Promise<{ executions: JsSandboxExecutionView[]; total: number }> {
  const db = await withTenantDb(ctx.tenantDbName);
  const [executions, total] = await Promise.all([
    db.listJsSandboxExecutions(ctx.tenantId, { projectId: ctx.projectId, ...filters }),
    db.countJsSandboxExecutions(ctx.tenantId, { projectId: ctx.projectId, ...filters }),
  ]);
  return {
    executions: executions.map(serializeExecution),
    total,
  };
}

export async function getJsSandboxExecution(
  ctx: JsSandboxContext,
  id: string,
): Promise<JsSandboxExecutionView | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record = await db.findJsSandboxExecutionById(id);
  if (!record || record.tenantId !== ctx.tenantId || !matchesProjectScope(record.projectId, ctx.projectId)) {
    return null;
  }
  return serializeExecution(record);
}
