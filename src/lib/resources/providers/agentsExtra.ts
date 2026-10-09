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
import { buildAttributes, normalizeProjectId, str, toIso, toneForStatus } from '../mapping';
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

export function mapMcpServer(s: Doc): ResourceRecord {
  return base('mcp-server', s, s.name, str(s.status), buildAttributes({
    sourceType: str(s.sourceType),
    toolCount: Array.isArray(s.tools) ? s.tools.length : undefined,
    totalRequests: typeof s.totalRequests === 'number' ? s.totalRequests : undefined,
  }));
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
  return base('memory-store', m, m.name, str(m.status), buildAttributes({
    memoryCount: typeof m.memoryCount === 'number' ? m.memoryCount : undefined,
    vectorProviderKey: str(m.vectorProviderKey),
    vectorIndexKey: str(m.vectorIndexKey),
    embeddingModelKey: str(m.embeddingModelKey),
  }));
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
