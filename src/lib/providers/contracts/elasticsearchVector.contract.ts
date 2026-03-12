import type { ProviderContract } from '../types';
import type {
  CreateVectorIndexInput,
  VectorIndexHandle,
  VectorProviderRuntime,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertItem,
  VectorListInput,
  VectorListResult,
} from '../domains/vector';

interface ElasticsearchCredentials {
  apiKey?: string;
  username?: string;
  password?: string;
}

interface ElasticsearchSettings {
  node?: string;
  cloudId?: string;
  indexName?: string;
  dimensions?: number;
}

type EsClient = {
  ping: () => Promise<boolean>;
  indices: {
    exists: (p: { index: string }) => Promise<boolean>;
    create: (p: { index: string; mappings: unknown }) => Promise<unknown>;
    delete: (p: { index: string }) => Promise<unknown>;
    stats: (p: { index: string }) => Promise<{ indices: Record<string, unknown> }>;
    getMapping: (p: { index: string }) => Promise<Record<string, { mappings: { properties?: Record<string, unknown> } }>>;
    get: (p: { index: string }) => Promise<Record<string, { mappings: { properties?: Record<string, unknown> } }>>;
  };
  index: (p: { index: string; id: string; document: Record<string, unknown> }) => Promise<unknown>;
  bulk: (p: { body: unknown[] }) => Promise<{ errors: boolean }>;
  search: (p: { index: string; knn?: unknown; size: number; _source?: string[]; sort?: unknown[]; search_after?: unknown[] }) => Promise<{
    hits: { hits: Array<{ _id: string; _score: number; _source?: Record<string, unknown>; sort?: unknown[] }> };
  }>;
  count: (p: { index: string }) => Promise<{ count: number }>;
  delete: (p: { index: string; id: string }) => Promise<unknown>;
  deleteByQuery: (p: { index: string; query: unknown }) => Promise<unknown>;
  cat: {
    indices: (p: { index: string; format: string; h: string[] }) => Promise<Array<{ index: string }>>;
  };
};

const DEFAULT_DIMENSIONS = 1536;

function buildEsClient(
  credentials: ElasticsearchCredentials,
  settings: ElasticsearchSettings,
  ClientClass: new (config: Record<string, unknown>) => EsClient,
): EsClient {
  const { apiKey, username, password } = credentials;
  const { node, cloudId } = settings;

  if (!node && !cloudId) {
    throw new Error("Elasticsearch requires either a node URL or a cloudId setting.");
  }

  const config: Record<string, unknown> = {};

  if (cloudId) {
    config.cloud = { id: cloudId };
  } else {
    config.node = node;
  }

  if (apiKey) {
    config.auth = { apiKey };
  } else if (username && password) {
    config.auth = { username, password };
  }

  return new ClientClass(config);
}

function getEsDimensions(settings: ElasticsearchSettings): number {
  const parsed = Number(settings.dimensions);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DIMENSIONS;
}

async function ensureIndexExists(
  client: EsClient,
  indexName: string,
  dimension: number,
  metric: string,
): Promise<void> {
  const exists = await client.indices.exists({ index: indexName });
  if (!exists) {
    const similarity = metric === 'dot' ? 'dot_product' : metric === 'euclidean' ? 'l2_norm' : 'cosine';
    await client.indices.create({
      index: indexName,
      mappings: {
        properties: {
          vector: { type: 'dense_vector', dims: dimension, index: true, similarity },
          metadata: { type: 'object', dynamic: true },
        },
      },
    });
  }
}

export const ElasticsearchVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  ElasticsearchCredentials,
  ElasticsearchSettings
> = {
  id: 'elasticsearch',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'Elasticsearch',
    description: 'Elasticsearch dense vector search. Supports self-hosted instances and Elastic Cloud.',
  },
  form: {
    sections: [
      {
        title: 'Connection',
        fields: [
          {
            name: 'node',
            label: 'Node URL',
            type: 'text',
            required: false,
            placeholder: 'http://localhost:9200',
            description: 'Elasticsearch node URL. Required when Cloud ID is not set.',
            scope: 'settings',
          },
          {
            name: 'cloudId',
            label: 'Cloud ID',
            type: 'text',
            required: false,
            description: 'Elastic Cloud deployment ID. Use this instead of Node URL for Elastic Cloud.',
            scope: 'settings',
          },
        ],
      },
      {
        title: 'Authentication',
        fields: [
          {
            name: 'apiKey',
            label: 'API Key',
            type: 'password',
            required: false,
            description: 'Elasticsearch API key. Takes priority over username/password.',
            scope: 'credentials',
          },
          {
            name: 'username',
            label: 'Username',
            type: 'text',
            required: false,
            scope: 'credentials',
          },
          {
            name: 'password',
            label: 'Password',
            type: 'password',
            required: false,
            scope: 'credentials',
          },
        ],
      },
      {
        title: 'Index Settings',
        fields: [
          {
            name: 'indexName',
            label: 'Default Index Name',
            type: 'text',
            required: false,
            description: 'Default Elasticsearch index name for vector storage.',
            scope: 'settings',
          },
          {
            name: 'dimensions',
            label: 'Dimensions',
            type: 'number',
            required: false,
            placeholder: '1536',
            description: 'Vector dimensions. Must match the embedding model output size.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  capabilities: {
    supportsUpsert: true,
    supportsQuery: true,
    supportsDelete: true,
  },
  async createRuntime({ credentials, settings, providerKey, logger }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-ts-comment
    // @ts-ignore – @elastic/elasticsearch is an optional peer dependency
    const { Client } = await import('@elastic/elasticsearch') as any;
    const client: EsClient = buildEsClient(credentials, settings, Client);

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const indexName = input.name || settings.indexName;
        if (!indexName) {
          throw new Error('Index name is required to create an Elasticsearch index.');
        }
        const dimension = input.dimension || getEsDimensions(settings);
        const metric = input.metric ?? 'cosine';
        await ensureIndexExists(client, indexName, dimension, metric);
        logger?.info?.('Elasticsearch index ensured', { providerKey, indexName });
        return {
          externalId: indexName,
          name: indexName,
          dimension,
          metric,
          metadata: { ...input.metadata, provider: 'elasticsearch' },
        };
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        await client.indices.delete({ index: externalId });
        logger?.info?.('Elasticsearch index deleted', { providerKey, externalId });
      },

      async listIndexes(): Promise<VectorIndexHandle[]> {
        const pattern = settings.indexName ? settings.indexName : '*';
        const indices = await client.cat.indices({ index: pattern, format: 'json', h: ['index'] });
        return indices.map((entry) => ({
          externalId: entry.index,
          name: entry.index,
          dimension: getEsDimensions(settings),
          metric: 'cosine',
          metadata: { provider: 'elasticsearch' },
        }));
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        const body: unknown[] = [];
        for (const item of items) {
          body.push({ index: { _index: handle.externalId, _id: item.id } });
          body.push({ vector: item.values, metadata: item.metadata ?? {} });
        }
        const result = await client.bulk({ body });
        if (result.errors) {
          logger?.warn?.('Elasticsearch bulk upsert had errors', { providerKey });
        }
        logger?.debug?.('Elasticsearch upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const result = await client.search({
          index: handle.externalId,
          knn: {
            field: 'vector',
            query_vector: query.vector,
            k: query.topK,
            num_candidates: query.topK * 2,
            filter: query.filter,
          },
          size: query.topK,
        });
        return {
          matches: result.hits.hits.map((hit) => ({
            id: hit._id,
            score: hit._score ?? 0,
            metadata: hit._source?.metadata as Record<string, unknown> | undefined,
          })),
        };
      },

      async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        await client.deleteByQuery({
          index: handle.externalId,
          query: { ids: { values: ids } },
        });
        logger?.debug?.('Elasticsearch deleted vectors', { providerKey, count: ids.length });
      },

      async listVectors(handle: VectorIndexHandle, input?: VectorListInput): Promise<VectorListResult> {
        const limit = input?.limit ?? 100;
        // cursor encodes the search_after value serialized as JSON, or a plain offset string
        let searchAfter: unknown[] | undefined;
        if (input?.cursor) {
          try { searchAfter = JSON.parse(input.cursor) as unknown[]; } catch { /* use as pit */ }
        }

        const countRes = await client.count({ index: handle.externalId });
        const total: number | undefined = countRes?.count;

        const result = await client.search({
          index: handle.externalId,
          size: limit,
          _source: ['vector', 'metadata'],
          sort: [{ _doc: 'asc' }],
          ...(searchAfter ? { search_after: searchAfter } : {}),
        });

        const hits = result.hits?.hits ?? [];
        const items = hits.map((hit: Record<string, unknown>) => {
          const src = (hit._source ?? {}) as Record<string, unknown>;
          return {
            id: hit._id as string,
            values: Array.isArray(src.vector) ? src.vector as number[] : [],
            metadata: src.metadata as Record<string, unknown> | undefined,
          };
        });

        const lastHit = hits[hits.length - 1] as Record<string, unknown> | undefined;
        const nextCursor = items.length === limit && lastHit?.sort
          ? JSON.stringify(lastHit.sort)
          : undefined;

        return { items, nextCursor, total };
      },
    };

    return runtime;
  },
};
