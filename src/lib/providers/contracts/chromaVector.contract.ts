import type { ProviderContract } from '../types';
import type {
  CreateVectorIndexInput,
  VectorIndexHandle,
  VectorProviderRuntime,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertItem,
} from '../domains/vector';

interface ChromaCredentials {
  apiKey?: string;
}

interface ChromaSettings {
  host?: string;
  port?: number;
  scheme?: string;
  baseUrl?: string;
  tenant?: string;
  database?: string;
  collectionName?: string;
  defaultDimension?: number;
}

type ChromaClient = {
  getOrCreateCollection: (opts: { name: string; metadata?: Record<string, unknown> }) => Promise<ChromaCollection>;
  getCollection: (opts: { name: string }) => Promise<ChromaCollection>;
  deleteCollection: (opts: { name: string }) => Promise<void>;
  listCollections: () => Promise<Array<{ name: string; id: string; metadata?: Record<string, unknown> }>>;
};

type ChromaCollection = {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
  query: (opts: {
    queryEmbeddings: number[][];
    nResults: number;
    where?: Record<string, unknown>;
  }) => Promise<{
    ids: string[][];
    distances: number[][];
    metadatas: Array<Array<Record<string, unknown> | null>>;
  }>;
  add: (opts: {
    ids: string[];
    embeddings: number[][];
    metadatas?: Array<Record<string, unknown>>;
    documents?: string[];
  }) => Promise<void>;
  upsert: (opts: {
    ids: string[];
    embeddings: number[][];
    metadatas?: Array<Record<string, unknown>>;
    documents?: string[];
  }) => Promise<void>;
  delete: (opts: { ids?: string[]; where?: Record<string, unknown> }) => Promise<void>;
};

function buildClient(credentials: ChromaCredentials, settings: ChromaSettings, ChromaClientClass: new (config: Record<string, unknown>) => ChromaClient): ChromaClient {
  const { apiKey } = credentials;
  const { host, port, scheme, baseUrl, tenant, database } = settings;

  const trimmedBase = baseUrl?.trim();
  const resolvedHost = host && host.trim().length > 0 ? host.trim() : 'localhost';
  const resolvedPort = port ?? 8000;
  const resolvedScheme = scheme || 'http';

  const url = trimmedBase && trimmedBase.length > 0
    ? trimmedBase
    : `${resolvedScheme}://${resolvedHost}:${resolvedPort}`;

  const config: Record<string, unknown> = { path: url };

  if (tenant) {
    config.tenant = tenant;
  }
  if (database) {
    config.database = database;
  }
  if (apiKey) {
    config.auth = { provider: 'token', credentials: apiKey };
  }

  return new ChromaClientClass(config);
}

async function listIndexesFromChroma(
  client: ChromaClient,
): Promise<VectorIndexHandle[]> {
  const collections = await client.listCollections();
  return collections.map((col) => ({
    externalId: col.id || col.name,
    name: col.name,
    dimension: (col.metadata?.dimension as number) ?? 0,
    metric: ((col.metadata?.metric as string) ?? 'cosine') as VectorIndexHandle['metric'],
    metadata: col.metadata,
  }));
}

export const ChromaVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  ChromaCredentials,
  ChromaSettings
> = {
  id: 'chroma',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'ChromaDB',
    description: 'Open-source AI-native vector database. Supports self-hosted and Chroma Cloud deployments.',
  },
  form: {
    sections: [
      {
        title: 'Connection',
        fields: [
          {
            name: 'baseUrl',
            label: 'Base URL',
            type: 'text',
            required: false,
            placeholder: 'http://localhost:8000',
            description: 'Full server URL. Overrides host, port and scheme when set.',
            scope: 'settings',
          },
          {
            name: 'host',
            label: 'Host',
            type: 'text',
            required: false,
            placeholder: 'localhost',
            description: 'Chroma server host. Ignored when Base URL is set.',
            scope: 'settings',
          },
          {
            name: 'port',
            label: 'Port',
            type: 'number',
            required: false,
            placeholder: '8000',
            description: 'Chroma server port. Ignored when Base URL is set.',
            scope: 'settings',
          },
          {
            name: 'scheme',
            label: 'Scheme',
            type: 'select',
            required: false,
            defaultValue: 'http',
            options: [
              { label: 'HTTP', value: 'http' },
              { label: 'HTTPS', value: 'https' },
            ],
            scope: 'settings',
          },
        ],
      },
      {
        title: 'Authentication',
        fields: [
          {
            name: 'apiKey',
            label: 'API Key / Token',
            type: 'password',
            required: false,
            description: 'Token for Chroma Cloud or token-authenticated self-hosted instances.',
            scope: 'credentials',
          },
          {
            name: 'tenant',
            label: 'Tenant',
            type: 'text',
            required: false,
            description: 'Chroma Cloud tenant identifier.',
            scope: 'settings',
          },
          {
            name: 'database',
            label: 'Database',
            type: 'text',
            required: false,
            description: 'Chroma database name within the tenant.',
            scope: 'settings',
          },
        ],
      },
      {
        title: 'Defaults',
        fields: [
          {
            name: 'collectionName',
            label: 'Default Collection Name',
            type: 'text',
            required: false,
            description: 'Default collection name used when creating new indexes.',
            scope: 'settings',
          },
          {
            name: 'defaultDimension',
            label: 'Default Dimension',
            type: 'number',
            required: false,
            placeholder: '1536',
            description: 'Default embedding dimension for new collections.',
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
    // @ts-ignore – chromadb is an optional peer dependency
    const { ChromaClient } = await import('chromadb') as any;
    const client: ChromaClient = buildClient(credentials, settings, ChromaClient);

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const name = input.name || settings.collectionName;
        if (!name) {
          throw new Error('Collection name is required to create a Chroma index.');
        }
        const dimension = input.dimension || settings.defaultDimension || 1536;
        const metric = input.metric ?? 'cosine';
        const collection = await client.getOrCreateCollection({
          name,
          metadata: { ...input.metadata, dimension, metric, provider: 'chroma' },
        });
        logger?.info?.('Chroma collection created/retrieved', { providerKey, name });
        return {
          externalId: collection.id || name,
          name,
          dimension,
          metric,
          metadata: { ...input.metadata, dimension, metric, provider: 'chroma' },
        };
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        await client.deleteCollection({ name: externalId });
        logger?.info?.('Chroma collection deleted', { providerKey, externalId });
      },

      async listIndexes(): Promise<VectorIndexHandle[]> {
        return listIndexesFromChroma(client);
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        const collection = await client.getCollection({ name: handle.name });
        const ids = items.map((i) => i.id);
        const embeddings = items.map((i) => i.values);
        const metadatas = items.map((i) => i.metadata ?? {});
        await collection.upsert({ ids, embeddings, metadatas });
        logger?.debug?.('Chroma upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const collection = await client.getCollection({ name: handle.name });
        const result = await collection.query({
          queryEmbeddings: [query.vector],
          nResults: query.topK,
          where: query.filter as Record<string, unknown> | undefined,
        });

        const ids = result.ids[0] ?? [];
        const distances = result.distances[0] ?? [];
        const metadatas = result.metadatas[0] ?? [];

        return {
          matches: ids.map((id, idx) => ({
            id,
            score: 1 - (distances[idx] ?? 0),
            metadata: metadatas[idx] ?? undefined,
          })),
        };
      },

      async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
        const collection = await client.getCollection({ name: handle.name });
        await collection.delete({ ids });
        logger?.debug?.('Chroma deleted vectors', { providerKey, count: ids.length });
      },
    };

    return runtime;
  },
};
