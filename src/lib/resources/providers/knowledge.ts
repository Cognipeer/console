/**
 * Knowledge resource types: rag-module, vector-index, file-bucket, crawler, reranker.
 *
 * Backend semantics relied on (mongodb/*.mixin.ts and sqlite/*.mixin.ts agree):
 *   listRagModules():    projectId undefined -> ALL rows (tenant-wide are stored as
 *                        ''/null/missing; normalizeProjectId collapses them)
 *   listRerankers():     same as rag
 *   listVectorIndexes(): filters only when truthy; the HTTP route requires a
 *                        providerKey but the contract method does not
 *   listFileBuckets(tenantId): tenantId arg required, project clause when truthy
 *   listCrawlers(tenantId):    tenantId arg required, project clause when truthy
 *
 * Deliberately NOT surfaced: rag defaultFilter/metadata, vector metadata (may
 * hold provider hand-off data), bucket prefix/metadata, crawler http/webhook/
 * seeds/markdownOptions (headers, cookies, bearer tokens, webhook secret),
 * reranker config bodies (prompt templates).
 */
import { buildAttributes, normalizeProjectId, str, toIso, toneForStatus } from '../mapping';
import type { ResourceRecord, ResourceTypeDefinition } from '../types';

type Doc = Record<string, any>;

function base(
  type: string,
  d: Doc,
  status: string | null,
  attributes: ResourceRecord['attributes'],
): ResourceRecord {
  return {
    type,
    id: String(d._id ?? d.id),
    key: str(d.key),
    name: str(d.name) ?? String(d._id ?? d.id),
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

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

export function mapRagModule(m: Doc): ResourceRecord {
  return base('rag-module', m, str(m.status), buildAttributes({
    embeddingModelKey: str(m.embeddingModelKey),
    vectorProviderKey: str(m.vectorProviderKey),
    vectorIndexKey: str(m.vectorIndexKey),
    fileBucketKey: str(m.fileBucketKey),
    totalDocuments: num(m.totalDocuments),
    totalChunks: num(m.totalChunks),
  }));
}

export function mapVectorIndex(v: Doc): ResourceRecord {
  // Vector indexes have no lifecycle status.
  return base('vector-index', v, null, buildAttributes({
    providerKey: str(v.providerKey),
    dimension: num(v.dimension),
    metric: str(v.metric),
  }));
}

export function mapFileBucket(b: Doc): ResourceRecord {
  return base('file-bucket', b, str(b.status), buildAttributes({
    providerKey: str(b.providerKey),
  }));
}

export function mapCrawler(c: Doc): ResourceRecord {
  const schedule = (c.schedule ?? null) as Doc | null;
  const rag = (c.rag ?? null) as Doc | null;
  return base('crawler', c, str(c.status), buildAttributes({
    engine: str(c.engine),
    seedCount: Array.isArray(c.seeds) ? c.seeds.length : undefined,
    maxPages: num(c.maxPages),
    autoCrawl: typeof c.autoCrawl === 'boolean' ? c.autoCrawl : undefined,
    scheduled: schedule && typeof schedule.enabled === 'boolean' ? schedule.enabled : undefined,
    ragModuleKey: rag ? str(rag.ragModuleKey) : undefined,
  }));
}

export function mapReranker(r: Doc): ResourceRecord {
  const config = (r.config ?? {}) as Doc;
  return base('reranker', r, str(r.status), buildAttributes({
    strategy: str(r.strategy),
    modelKey: str(config.modelKey),
    totalRuns: num(r.totalRuns),
    avgLatencyMs: num(r.avgLatencyMs),
  }));
}

const enc = encodeURIComponent;

export const knowledgeResourceTypes: ResourceTypeDefinition[] = [
  {
    type: 'rag-module',
    service: 'rag',
    category: 'knowledge',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db }) => (await db.listRagModules()).map((m) => mapRagModule(m as never)),
    detailUrl: (r) => (r.key ? `/dashboard/rag/${enc(r.key)}` : null),
  },
  {
    type: 'vector-index',
    service: 'vector',
    category: 'knowledge',
    scope: 'project',
    edition: 'community',
    list: async ({ db }) => (await db.listVectorIndexes()).map((v) => mapVectorIndex(v as never)),
    // Page route is /vector/[providerKey]/[externalId], where the param is the index key.
    detailUrl: (r) => {
      const providerKey = r.attributes.find((a) => a.key === 'providerKey')?.value;
      return r.key && typeof providerKey === 'string'
        ? `/dashboard/vector/${enc(providerKey)}/${enc(r.key)}`
        : null;
    },
  },
  {
    type: 'file-bucket',
    service: 'files',
    category: 'knowledge',
    scope: 'project',
    edition: 'community',
    list: async ({ db, tenantId }) => (await db.listFileBuckets(tenantId)).map((b) => mapFileBucket(b as never)),
    detailUrl: (r) => (r.key ? `/dashboard/files/${enc(r.key)}` : null),
  },
  {
    type: 'crawler',
    service: 'crawler',
    category: 'knowledge',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db, tenantId }) => (await db.listCrawlers(tenantId)).map((c) => mapCrawler(c as never)),
    detailUrl: (r) => `/dashboard/crawler/${enc(r.id)}`,
  },
  {
    type: 'reranker',
    service: 'reranker',
    category: 'knowledge',
    scope: 'project-or-tenant',
    edition: 'community',
    list: async ({ db }) => (await db.listRerankers()).map((r) => mapReranker(r as never)),
    detailUrl: (r) => (r.key ? `/dashboard/reranker/${enc(r.key)}` : null),
  },
];
