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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ChromaLocalCredentials {}

interface ChromaLocalSettings {
  host?: string;
  port?: number;
  scheme?: string;
  collectionName?: string;
  defaultDimension?: number;
}

type ChromaLocalClient = {
  getOrCreateCollection: (opts: { name: string; metadata?: Record<string, unknown> }) => Promise<ChromaLocalCollection>;
  getCollection: (opts: { name: string }) => Promise<ChromaLocalCollection>;
  deleteCollection: (opts: { name: string }) => Promise<void>;
  listCollections: () => Promise<Array<{ name: string; id: string; metadata?: Record<string, unknown> }>>;
};

type ChromaLocalCollection = {
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
  count: () => Promise<number>;
  get: (opts: { limit: number; offset: number; include: string[] }) => Promise<{
    ids: string[];
    embeddings: number[][] | null;
    metadatas: Array<Record<string, unknown> | null> | null;
  }>;
};

export const ChromaLocalVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  ChromaLocalCredentials,
  ChromaLocalSettings
> = {
  id: 'chroma-local',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'ChromaDB (Self-Hosted)',
    description: 'Self-hosted ChromaDB instance running locally or on your own infrastructure.',
  },
  form: {
    sections: [
      {
        title: 'Connection',
        fields: [
          {
            name: 'host',
            label: 'Host',
            type: 'text',
            required: false,
            placeholder: 'localhost',
            description: 'Chroma server hostname.',
            scope: 'settings',
          },
          {
            name: 'port',
            label: 'Port',
            type: 'number',
            required: false,
            placeholder: '8000',
            description: 'Chroma server port.',
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
  async createRuntime({ credentials: _credentials, settings, providerKey, logger }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-ts-comment
    // @ts-ignore – chromadb is an optional peer dependency
    const { ChromaClient } = await import('chromadb') as any;

    const resolvedHost = settings.host?.trim() || 'localhost';
    const resolvedPort = settings.port ?? 8000;
    const resolvedScheme = settings.scheme || 'http';
    const url = `${resolvedScheme}://${resolvedHost}:${resolvedPort}`;

    const client: ChromaLocalClient = new ChromaClient({ path: url });

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const name = input.name || settings.collectionName;
        if (!name) {
          throw new Error('Collection name is required to create a Chroma Local index.');
        }
        const dimension = input.dimension || settings.defaultDimension || 1536;
        const metric = input.metric ?? 'cosine';
        const collection = await client.getOrCreateCollection({
          name,
          metadata: { ...input.metadata, dimension, metric, provider: 'chroma-local' },
        });
        logger?.info?.('Chroma Local collection created', { providerKey, name });
        return {
          externalId: collection.id || name,
          name,
          dimension,
          metric,
          metadata: { ...input.metadata, dimension, metric, provider: 'chroma-local' },
        };
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        await client.deleteCollection({ name: externalId });
        logger?.info?.('Chroma Local collection deleted', { providerKey, externalId });
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
        logger?.debug?.('Chroma Local upserted vectors', { providerKey, count: items.length });
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
    
      async listVectors(handle: VectorIndexHandle, input?: VectorListInput): Promise<VectorListResult> {
        const limit = input?.limit ?? 100;
        const offset = input?.cursor ? parseInt(input.cursor, 10) : 0;
        const collection = await client.getCollection({ name: handle.name });
        const total = await collection.count();
        const result = await collection.get({ limit, offset, include: ['embeddings', 'metadatas'] });
        const ids = result.ids ?? [];
        const embeddings = (result.embeddings ?? []) as number[][];
        const metadatas = (result.metadatas ?? []) as (Record<string, unknown> | null)[];
        const items = ids.map((id: string, i: number) => ({
          id,
          values: embeddings[i] ?? [],
          metadata: metadatas[i] ?? undefined,
        }));
        const nextOffset = offset + items.length;
        return { items, nextCursor: nextOffset < total ? String(nextOffset) : undefined, total };
      },
    
    };

    return runtime;
  },
};
