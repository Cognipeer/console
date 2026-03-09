import type { ProviderContract } from '../types';
import type {
  CreateVectorIndexInput,
  VectorIndexHandle,
  VectorProviderRuntime,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertItem,
} from '../domains/vector';

interface ChromaCloudCredentials {
  apiKey: string;
}

interface ChromaCloudSettings {
  tenant: string;
  database?: string;
  collectionName?: string;
  defaultDimension?: number;
}

type ChromaCloudClient = {
  getOrCreateCollection: (opts: { name: string; metadata?: Record<string, unknown> }) => Promise<ChromaCloudCollection>;
  getCollection: (opts: { name: string }) => Promise<ChromaCloudCollection>;
  deleteCollection: (opts: { name: string }) => Promise<void>;
  listCollections: () => Promise<Array<{ name: string; id: string; metadata?: Record<string, unknown> }>>;
};

type ChromaCloudCollection = {
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
  upsert: (opts: {
    ids: string[];
    embeddings: number[][];
    metadatas?: Array<Record<string, unknown>>;
  }) => Promise<void>;
  delete: (opts: { ids?: string[] }) => Promise<void>;
};

export const ChromaCloudVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  ChromaCloudCredentials,
  ChromaCloudSettings
> = {
  id: 'chroma-cloud',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'ChromaDB Cloud',
    description: 'Chroma Cloud managed vector database service (api.trychroma.com).',
  },
  form: {
    sections: [
      {
        title: 'Authentication',
        fields: [
          {
            name: 'apiKey',
            label: 'API Key',
            type: 'password',
            required: true,
            description: 'Chroma Cloud API key.',
            scope: 'credentials',
          },
          {
            name: 'tenant',
            label: 'Tenant',
            type: 'text',
            required: true,
            description: 'Your Chroma Cloud tenant identifier.',
            scope: 'settings',
          },
          {
            name: 'database',
            label: 'Database',
            type: 'text',
            required: false,
            defaultValue: 'default',
            description: 'Database name within the tenant. Defaults to "default".',
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
            description: 'Default collection name for new indexes.',
            scope: 'settings',
          },
          {
            name: 'defaultDimension',
            label: 'Default Dimension',
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
    if (!credentials?.apiKey) {
      throw new Error('Chroma Cloud API key is required.');
    }
    if (!settings?.tenant) {
      throw new Error('Chroma Cloud tenant is required.');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-ts-comment
    // @ts-ignore – chromadb is an optional peer dependency
    const chromaModule = await import('chromadb') as any;
    const ClientClass = chromaModule.CloudClient ?? chromaModule.ChromaClient;

    const client: ChromaCloudClient = new ClientClass({
      apiKey: credentials.apiKey,
      tenant: settings.tenant,
      database: settings.database || 'default',
    });

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const name = input.name || settings.collectionName;
        if (!name) {
          throw new Error('Collection name is required to create a Chroma Cloud index.');
        }
        const dimension = input.dimension || settings.defaultDimension || 1536;
        const metric = input.metric ?? 'cosine';
        const collection = await client.getOrCreateCollection({
          name,
          metadata: { ...input.metadata, dimension, metric, provider: 'chroma-cloud' },
        });
        logger?.info?.('Chroma Cloud collection created', { providerKey, name });
        return {
          externalId: collection.id || name,
          name,
          dimension,
          metric,
          metadata: { ...input.metadata, dimension, metric, provider: 'chroma-cloud' },
        };
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        await client.deleteCollection({ name: externalId });
        logger?.info?.('Chroma Cloud collection deleted', { providerKey, externalId });
      },

      async listIndexes(): Promise<VectorIndexHandle[]> {
        const collections = await client.listCollections();
        return collections.map((col) => ({
          externalId: col.id || col.name,
          name: col.name,
          dimension: (col.metadata?.dimension as number) ?? 0,
          metric: ((col.metadata?.metric as string) ?? 'cosine') as VectorIndexHandle['metric'],
          metadata: col.metadata,
        }));
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        const collection = await client.getCollection({ name: handle.name });
        await collection.upsert({
          ids: items.map((i) => i.id),
          embeddings: items.map((i) => i.values),
          metadatas: items.map((i) => i.metadata ?? {}),
        });
        logger?.debug?.('Chroma Cloud upserted vectors', { providerKey, count: items.length });
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
      },
    };

    return runtime;
  },
};
