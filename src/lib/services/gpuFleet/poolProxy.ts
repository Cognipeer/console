/**
 * Pool proxy core. Selects a member, forwards the request, streams response.
 *
 * Phase 1 lives inside the console process. The `proxyChatCompletion` /
 * `proxyEmbeddings` etc. wrappers exist to keep the API plugin tiny — they
 * resolve the pool, pick a member, and call `proxyToMember` which does the
 * actual streaming.
 *
 * Why undici over global fetch: streaming pass-through with predictable
 * back-pressure semantics. The vLLM SSE chunks must hit the browser as they
 * arrive, not buffered.
 */

import { Readable } from 'node:stream';
import { request as undiciRequest, type Dispatcher } from 'undici';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, type ILlmDeployment, type ILlmPool } from '@/lib/database';
import { selectPoolMember, type SelectableMember } from './poolService';

const log = createLogger('gpu-fleet:pool-proxy');

export class NoHealthyMembersError extends Error {
  constructor(public readonly poolKey: string) {
    super(`Pool '${poolKey}' has no healthy members`);
    this.name = 'NoHealthyMembersError';
  }
}

interface PoolContext {
  pool: ILlmPool;
  members: SelectableMember[];
}

async function resolvePool(
  tenantDbName: string,
  tenantId: string,
  poolKey: string,
): Promise<PoolContext | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const pool = await db.findLlmPoolByKey(tenantId, poolKey);
  if (!pool || pool.status !== 'active') return null;

  const candidates: SelectableMember[] = [];
  for (const deploymentId of pool.deploymentIds) {
    const deployment = await db.findLlmDeploymentById(deploymentId);
    if (!deployment) continue;
    if (deployment.actualState !== 'healthy') continue;
    const host = await db.findGpuHostById(deployment.hostId);
    if (!host || !host.serviceAddress) continue;
    candidates.push({ deployment, hostAddress: host.serviceAddress });
  }
  return { pool, members: candidates };
}

export interface ProxyRequest {
  tenantDbName: string;
  tenantId: string;
  poolKey: string;
  /** Path beyond /v1, e.g. "chat/completions". */
  upstreamPath: string;
  method: Dispatcher.HttpMethod;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | string | null;
}

export interface ProxyResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Readable;
  member: ILlmDeployment;
}

export async function proxyToPool(req: ProxyRequest): Promise<ProxyResponse> {
  const ctx = await resolvePool(req.tenantDbName, req.tenantId, req.poolKey);
  if (!ctx) throw new NoHealthyMembersError(req.poolKey);
  const chosen = await selectPoolMember(ctx.pool, ctx.members);
  if (!chosen) throw new NoHealthyMembersError(req.poolKey);
  return proxyToMember(chosen, req);
}

async function proxyToMember(
  member: SelectableMember,
  req: ProxyRequest,
): Promise<ProxyResponse> {
  const upstream = `http://${member.hostAddress}:${member.deployment.port}/v1/${req.upstreamPath.replace(/^\//, '')}`;
  log.debug('forwarding to upstream', {
    deploymentId: member.deployment.id,
    upstream,
    method: req.method,
  });
  // Strip hop-by-hop headers + anything tenant-scoped from the inbound request;
  // the upstream container shouldn't see our auth cookies.
  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (DROP_HEADERS.has(lower)) continue;
    forwardHeaders[key] = Array.isArray(value) ? value.join(',') : value;
  }
  forwardHeaders['accept'] = forwardHeaders['accept'] ?? 'application/json';

  const response = await undiciRequest(upstream, {
    method: req.method,
    headers: forwardHeaders,
    body: req.body ?? undefined,
    // Big timeouts for streaming chat completions — vLLM can stream for
    // minutes on long-context generations.
    headersTimeout: 30_000,
    bodyTimeout: 0,
  });

  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(response.headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return {
    statusCode: response.statusCode,
    headers,
    // `undici.request()` already returns a Node Readable (its `BodyReadable`
    // class extends stream.Readable). DON'T wrap it with `Readable.fromWeb` —
    // that helper expects a WHATWG ReadableStream and throws
    // ERR_INVALID_ARG_TYPE on a Node stream. The previous code did this
    // because the type was confused with `undici.fetch()`'s response.body,
    // which IS a WHATWG stream. Two different APIs in the same package.
    body: response.body as unknown as Readable,
    member: member.deployment,
  };
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

const DROP_HEADERS = new Set([
  'cookie',
  'host',
  'x-tenant-id',
  'x-tenant-db-name',
  'x-tenant-slug',
  'x-user-id',
  'x-user-email',
  'x-user-role',
  'x-license-type',
  'x-features',
  'x-request-id',
]);
