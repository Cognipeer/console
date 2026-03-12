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

interface ElasticsearchCloudCredentials {
  cloudId: string;
  apiKey?: string;
  username?: string;
  password?: string;
}

interface ElasticsearchCloudSettings {
  indexName?: string;
  dimensions?: number;
}

const DEFAULT_DIMENSIONS = 1536;

function getCloudDimensions(settings: ElasticsearchCloudSettings): number {
  const parsed = Number(settings.dimensions);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DIMENSIONS;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractEsError(error: any): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error) || 'Unknown Elasticsearch error');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const esError = error as any;

  // @elastic/elasticsearch v8 ResponseError — has meta.body with server response
  const body = esError?.meta?.body;
  if (body) {
    const reason =
      body?.error?.reason ||
      body?.error?.root_cause?.[0]?.reason ||
      body?.error?.type ||
      body?.message;
    const status = esError?.meta?.statusCode;
    if (reason) {
      return new Error(`Elasticsearch error (HTTP ${status ?? 'unknown'}): ${reason}`);
    }
    if (status) {
      return new Error(`Elasticsearch HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
  }

  // ConnectionError / serialization error — cause is the underlying Node.js error
  const cause = esError?.cause;
  if (cause) {
    const causeMsg = cause?.message || cause?.code || String(cause);
    if (causeMsg) {
      return new Error(`Elasticsearch connection error: ${causeMsg}`);
    }
  }

  // Some errors have a non-empty message but still reach here
  if (error.message) {
    // Enrich with error name if available
    const name = esError?.name;
    if (name && name !== 'Error') {
      return new Error(`[${name}] ${error.message}`);
    }
    return error;
  }

  // Last resort — try to stringify for any clue
  let details = '';
  try {
    details = JSON.stringify({ name: esError?.name, meta: esError?.meta, keys: Object.keys(esError) }).slice(0, 300);
  } catch {
    details = String(esError);
  }
  return new Error(
    `Elasticsearch error — check Cloud ID format (must contain ":"), API key validity, and network connectivity.` +
    (details ? ` Debug: ${details}` : ''),
  );
}

export const ElasticsearchCloudVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  ElasticsearchCloudCredentials,
  ElasticsearchCloudSettings
> = {
  id: 'elasticsearch-cloud',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'Elasticsearch Cloud',
    description: 'Elastic Cloud managed Elasticsearch with dense vector search.',
  },
  form: {
    sections: [
      {
        title: 'Elastic Cloud',
        fields: [
          {
            name: 'cloudId',
            label: 'Cloud ID',
            type: 'text',
            required: true,
            description: 'Elastic Cloud deployment ID (found in your Elastic Cloud console).',
            scope: 'credentials',
          },
          {
            name: 'apiKey',
            label: 'API Key',
            type: 'password',
            required: false,
            description: 'Elasticsearch API key (recommended). If omitted, provide Username and Password below instead.',
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
    if (!credentials?.cloudId?.trim()) {
      throw new Error('Elastic Cloud ID is required.');
    }

    // Validate Cloud ID format: must contain a colon separating cluster name from base64 endpoint
    const cloudId = credentials.cloudId.trim();
    if (!cloudId.includes(':')) {
      throw new Error(
        'Invalid Elastic Cloud ID format. Expected "<cluster-name>:<base64-endpoint>". ' +
        'Find it at cloud.elastic.co → your deployment → Manage page.',
      );
    }

    if (!credentials.apiKey && !(credentials.username && credentials.password)) {
      throw new Error(
        'Authentication is required for Elasticsearch Cloud. Provide an API Key or username/password.',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-ts-comment
    // @ts-ignore – @elastic/elasticsearch is an optional peer dependency
    const { Client } = await import('@elastic/elasticsearch') as any;

    const config: Record<string, unknown> = {
      cloud: { id: cloudId },
    };

    if (credentials.apiKey) {
      config.auth = { apiKey: credentials.apiKey };
    } else if (credentials.username && credentials.password) {
      config.auth = { username: credentials.username, password: credentials.password };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any;
    try {
      client = new Client(config);
      // Verify connectivity and credentials with a lightweight ping
      await client.info();
    } catch (err) {
      throw extractEsError(err);
    }

    const dimensions = getCloudDimensions(settings);

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const indexName = input.name || settings.indexName;
        if (!indexName) {
          throw new Error('Index name is required to create an Elasticsearch Cloud index.');
        }
        const dim = input.dimension || dimensions;
        const metric = input.metric ?? 'cosine';
        try {
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
        } catch (err) {
          throw extractEsError(err);
        }
        logger?.info?.('Elasticsearch Cloud index ensured', { providerKey, indexName });
        return {
          externalId: indexName,
          name: indexName,
          dimension: dim,
          metric,
          metadata: { ...input.metadata, provider: 'elasticsearch-cloud' },
        };
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        try {
          await client.indices.delete({ index: externalId });
        } catch (err) {
          throw extractEsError(err);
        }
      },

      async listIndexes(): Promise<VectorIndexHandle[]> {
        const pattern = settings.indexName || '*';
        const indices = await client.cat.indices({ index: pattern, format: 'json', h: ['index'] });
        return (indices as Array<{ index: string }>).map((entry) => ({
          externalId: entry.index,
          name: entry.index,
          dimension: dimensions,
          metric: 'cosine' as const,
          metadata: { provider: 'elasticsearch-cloud' },
        }));
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        const body: unknown[] = [];
        for (const item of items) {
          body.push({ index: { _index: handle.externalId, _id: item.id } });
          body.push({ vector: item.values, metadata: item.metadata ?? {} });
        }
        try {
          await client.bulk({ body });
        } catch (err) {
          throw extractEsError(err);
        }
        logger?.debug?.('Elasticsearch Cloud upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        let result;
        try {
          result = await client.search({
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
        } catch (err) {
          throw extractEsError(err);
        }
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
        try {
          await client.deleteByQuery({
            index: handle.externalId,
            query: { ids: { values: ids } },
          });
        } catch (err) {
          throw extractEsError(err);
        }
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
