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

interface ElasticsearchSelfHostedCredentials {
  apiKey?: string;
  username?: string;
  password?: string;
}

interface ElasticsearchSelfHostedSettings {
  node: string;
  indexName?: string;
  dimensions?: number;
}

const DEFAULT_DIMENSIONS = 1536;

function getSelfHostedDimensions(settings: ElasticsearchSelfHostedSettings): number {
  const parsed = Number(settings.dimensions);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DIMENSIONS;
}

export const ElasticsearchSelfHostedVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  ElasticsearchSelfHostedCredentials,
  ElasticsearchSelfHostedSettings
> = {
  id: 'elasticsearch-self-hosted',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'Elasticsearch (Self-Hosted)',
    description: 'Self-hosted Elasticsearch instance with dense vector search capabilities.',
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
            required: true,
            placeholder: 'http://localhost:9200',
            description: 'Elasticsearch node URL.',
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
            scope: 'settings',
          },
          {
            name: 'dimensions',
            label: 'Dimensions',
            type: 'number',
            required: false,
            placeholder: '1536',
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
    if (!settings?.node?.trim()) {
      throw new Error('Elasticsearch node URL is required for self-hosted deployment.');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-ts-comment
    // @ts-ignore – @elastic/elasticsearch is an optional peer dependency
    const { Client } = await import('@elastic/elasticsearch') as any;

    const config: Record<string, unknown> = { node: settings.node.trim() };

    if (credentials.apiKey) {
      config.auth = { apiKey: credentials.apiKey };
    } else if (credentials.username && credentials.password) {
      config.auth = { username: credentials.username, password: credentials.password };
    }

    const client = new Client(config);
    const dimensions = getSelfHostedDimensions(settings);

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const indexName = input.name || settings.indexName;
        if (!indexName) {
          throw new Error('Index name is required to create an Elasticsearch self-hosted index.');
        }
        const dim = input.dimension || dimensions;
        const metric = input.metric ?? 'cosine';
        const exists = await client.indices.exists({ index: indexName });
        if (!exists) {
          const similarity = metric === 'dot' ? 'dot_product' : metric === 'euclidean' ? 'l2_norm' : 'cosine';
          await client.indices.create({
            index: indexName,
            mappings: {
              properties: {
                vector: { type: 'dense_vector', dims: dim, index: true, similarity },
                metadata: { type: 'object', dynamic: true },
              },
            },
          });
        }
        logger?.info?.('Elasticsearch self-hosted index ensured', { providerKey, indexName });
        return {
          externalId: indexName,
          name: indexName,
          dimension: dim,
          metric,
          metadata: { ...input.metadata, provider: 'elasticsearch-self-hosted' },
        };
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        await client.indices.delete({ index: externalId });
      },

      async listIndexes(): Promise<VectorIndexHandle[]> {
        const pattern = settings.indexName || '*';
        const indices = await client.cat.indices({ index: pattern, format: 'json', h: ['index'] });
        return (indices as Array<{ index: string }>).map((entry) => ({
          externalId: entry.index,
          name: entry.index,
          dimension: dimensions,
          metric: 'cosine' as const,
          metadata: { provider: 'elasticsearch-self-hosted' },
        }));
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        const body: unknown[] = [];
        for (const item of items) {
          body.push({ index: { _index: handle.externalId, _id: item.id } });
          body.push({ vector: item.values, metadata: item.metadata ?? {} });
        }
        await client.bulk({ body });
        logger?.debug?.('Elasticsearch self-hosted upserted vectors', { providerKey, count: items.length });
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
          matches: (result.hits.hits as Array<{ _id: string; _score: number; _source?: Record<string, unknown> }>).map((hit) => ({
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
      },
    
      async listVectors(handle: VectorIndexHandle, input?: VectorListInput): Promise<VectorListResult> {
        const limit = input?.limit ?? 100;
        let searchAfter: unknown[] | undefined;
        if (input?.cursor) { try { searchAfter = JSON.parse(input.cursor) as unknown[]; } catch { /* ignore */ } }
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
