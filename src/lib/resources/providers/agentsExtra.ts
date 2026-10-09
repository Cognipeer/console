/**
 * Agent building-block resource types: mcp-server, skill, prompt, memory-store,
 * browser, browser-flow.
 *
 * Pattern from ./core.ts: contract list call with NO project filter (every list
 * method below returns the whole tenant in that case on BOTH backends — verified
 * in mongodb/*.mixin.ts and sqlite/*.mixin.ts), then an explicit whitelist map.
 *
 *   listMcpServers():  filter only when projectId !== undefined
 *   listSkills():      filter only when projectId is truthy
 *   listPrompts():     filter only when projectId is truthy
 *   listMemoryStores(): filter only when projectId is truthy
 *   listBrowsers(tenantId) / listBrowserFlows(tenantId): tenantId arg required,
 *                      project clause only when truthy
 *
 * Deliberately NOT surfaced: mcp upstreamAuth/stdioConfig/remoteConfig/
 * openApiSpec/upstreamBaseUrl/metadata/lastError, skill body, prompt template/
 * deployments, memory config, browser storageStateEnc + sessionConfig, flow
 * steps/inputs/outputs.
 */
import { toGuardrailMode } from '@/lib/services/guardrail/hooks/contract';
import { buildAttributes, normalizeProjectId, str, toIso, toneForStatus } from '../mapping';
import { createEdgeCollector } from '../references';
import type { ResourceRecord, ResourceTypeDefinition } from '../types';

type Doc = Record<string, any>;

function base(
  type: string,
  d: Doc,
  name: unknown,
  status: string | null,
  attributes: ResourceRecord['attributes'],
): ResourceRecord {
  return {
    type,
    id: String(d._id ?? d.id),
    key: str(d.key),
    name: str(name) ?? String(d._id ?? d.id),
    description: str(d.description),
    projectId: normalizeProjectId(d.projectId),
    status,
    statusTone: toneForStatus(status),
    createdBy: str(d.createdBy),
    updatedBy: str(d.updatedBy),
    createdAt: toIso(d.createdAt),
    updatedAt: toIso(d.updatedAt),
    tenantId: str(d.tenantId),
    attributes,
  };
}

/** Outgoing references of an MCP server: its guardrail and (composite) member servers, by id. */
export function extractMcpEdges(s: Doc) {
  const edges = createEdgeCollector('mcp-server');
  const guardrail = (s.guardrail ?? null) as Doc | null;
  // Mode 'off'/'disabled' evaluates nothing, so a stale key there is not a broken safety control.
  if (guardrail && toGuardrailMode(guardrail.mode, true) !== 'disabled') {
    edges.add('mcp.guardrail', guardrail.guardrailKey, 'guardrail.guardrailKey');
  }
  // Members live in a JSON blob and are referenced by server id (the one durable reference).
  const members = (s.metadata as Doc | null | undefined)?.composite?.members;
  if (s.sourceType === 'composite' && Array.isArray(members)) {
    const seen = new Set<unknown>();
    members.forEach((m: Doc | null, i: number) => {
      if (!m || typeof m !== 'object' || seen.has(m.serverId)) return;
      seen.add(m.serverId);
      edges.add('mcp.compositeMember', m.serverId, `metadata.composite.members[${i}].serverId`);
    });
  }
  return edges.done();
}

/** Outgoing references of a memory store: embedding model and its vector index (qualified by provider). */
export function extractMemoryStoreEdges(m: Doc) {
  const edges = createEdgeCollector('memory-store');
  edges.add('memory.embeddingModel', m.embeddingModelKey, 'embeddingModelKey');
  edges.add('memory.vectorIndex', m.vectorIndexKey, 'vectorIndexKey', { qualifier: m.vectorProviderKey });
  return edges.done();
}

export function mapMcpServer(s: Doc): ResourceRecord {
  const record = base('mcp-server', s, s.name, str(s.status), buildAttributes({
    sourceType: str(s.sourceType),
    toolCount: Array.isArray(s.tools) ? s.tools.length : undefined,
    totalRequests: typeof s.totalRequests === 'number' ? s.totalRequests : undefined,
  }));
  const edges = extractMcpEdges(s);
  return edges ? { ...record, edges } : record;
}

export function mapSkill(s: Doc): ResourceRecord {
  // Skills have `title` instead of `name`; `header` is the short summary line.
  const r = base('skill', s, s.title ?? s.key, str(s.status), buildAttributes({
    minModelTier: str(s.minModelTier),
  }));
  r.description = str(s.header);
  return r;
}

export function mapPrompt(p: Doc): ResourceRecord {
  return base('prompt', p, p.name, null, buildAttributes({
    currentVersion: typeof p.currentVersion === 'number' ? p.currentVersion : undefined,
  }));
}

export function mapMemoryStore(m: Doc): ResourceRecord {
  const record = base('memory-store', m, m.name, str(m.status), buildAttributes({
    memoryCount: typeof m.memoryCount === 'number' ? m.memoryCount : undefined,
    vectorProviderKey: str(m.vectorProviderKey),
    vectorIndexKey: str(m.vectorIndexKey),
    embeddingModelKey: str(m.embeddingModelKey),
  }));
  const edges = extractMemoryStoreEdges(m);
  return edges ? { ...record, edges } : record;
}

export function mapBrowser(b: Doc): ResourceRecord {
  const meta = (b.storageStateMeta ?? null) as Doc | null;
  return base('browser', b, b.name, str(b.status), buildAttributes({
    defaultModelKey: str(b.defaultModelKey),
    // Only the presence/count of the stored login state — never the blob.
    hasStorageState: meta ? true : undefined,
    cookieCount: meta && typeof meta.cookieCount === 'number' ? meta.cookieCount : undefined,
  }));
}

export function mapBrowserFlow(f: Doc): ResourceRecord {
  const lastRun = (f.lastRun ?? null) as Doc | null;
  return base('browser-flow', f, f.name, str(f.status), buildAttributes({
    browserId: str(f.browserId),
    version: typeof f.version === 'number' ? f.version : undefined,
    stepCount: Array.isArray(f.steps) ? f.steps.length : undefined,
    lastRunStatus: lastRun ? str(lastRun.status) : undefined,
  }));
}

const enc = encodeURIComponent;

export const agentsExtraResourceTypes: ResourceTypeDefinition[] = [
  {
    type: 'mcp-server',
    service: 'mcp',
    category: 'agents',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db }) => (await db.listMcpServers()).map((s) => mapMcpServer(s as never)),
    detailUrl: (r) => `/dashboard/mcp/${enc(r.id)}`,
  },
  {
    type: 'skill',
    // '/api/skills' is mapped to the 'agents' service in rbac.ts.
    service: 'agents',
    category: 'agents',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db }) => (await db.listSkills()).map((s) => mapSkill(s as never)),
    // Skills have no per-item page; the list page is where they are managed.
    detailUrl: () => '/dashboard/agents/skills',
  },
  {
    type: 'prompt',
    service: 'prompts',
    category: 'agents',
    scope: 'project',
    edition: 'community',
    list: async ({ db }) => (await db.listPrompts()).map((p) => mapPrompt(p as never)),
    detailUrl: (r) => `/dashboard/prompts/${enc(r.id)}`,
  },
  {
    type: 'memory-store',
    service: 'memory',
    category: 'agents',
    scope: 'project',
    edition: 'community',
    list: async ({ db }) => (await db.listMemoryStores()).map((m) => mapMemoryStore(m as never)),
    detailUrl: (r) => (r.key ? `/dashboard/memory/${enc(r.key)}` : null),
  },
  {
    type: 'browser',
    service: 'browser',
    category: 'agents',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db, tenantId }) => (await db.listBrowsers(tenantId)).map((b) => mapBrowser(b as never)),
    detailUrl: (r) => `/dashboard/browser/${enc(r.id)}`,
  },
  {
    type: 'browser-flow',
    service: 'browser',
    category: 'agents',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db, tenantId }) => (await db.listBrowserFlows(tenantId)).map((f) => mapBrowserFlow(f as never)),
    detailUrl: (r) => `/dashboard/browser/flows/${enc(r.id)}`,
  },
];
