import type { ProviderContract } from '../types';
import type {
  CreateVectorIndexInput,
  VectorIndexHandle,
  VectorProviderRuntime,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertItem,
} from '../domains/vector';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface OramaCredentials {}

interface OramaSettings {
  defaultDimension?: number;
}

type OramaDb = {
  insert: (db: OramaDb, document: Record<string, unknown>) => Promise<void>;
  insertMultiple: (db: OramaDb, documents: Record<string, unknown>[]) => Promise<void>;
  remove: (db: OramaDb, id: string) => Promise<boolean>;
  search: (
    db: OramaDb,
    params: { mode: string; vector: { value: number[]; property: string }; limit?: number; similarity?: number },
  ) => Promise<{ hits: Array<{ id: string; score: number; document: Record<string, unknown> }> }>;
  create: (schema: Record<string, unknown>) => Promise<OramaDb>;
};

const DEFAULT_DIMENSIONS = 1536;

export const OramaVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  OramaCredentials,
  OramaSettings
> = {
  id: 'orama',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'Orama',
    description:
      'In-memory vector search powered by Orama. Fast and dependency-free for development and lightweight workloads.',
  },
  form: {
    sections: [
      {
        title: 'Settings',
        fields: [
          {
            name: 'defaultDimension',
            label: 'Default Dimension',
            type: 'number',
            required: false,
            placeholder: '1536',
            description:
              'Embedding vector dimensions. Must match the output size of your embedding model.',
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
    // @ts-ignore – @orama/orama is an optional peer dependency
    const orama = await import('@orama/orama') as any;
    const { create, insert, insertMultiple, remove, search } = orama;

    const dimensions = Number(settings.defaultDimension) > 0
      ? Number(settings.defaultDimension)
      : DEFAULT_DIMENSIONS;

    // In-memory store: externalId → { db, handle }
    const store = new Map<string, { db: OramaDb; handle: VectorIndexHandle }>();

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const dim = input.dimension || dimensions;
        const metric = input.metric ?? 'cosine';

        const db: OramaDb = await create({
          schema: {
            id: 'string',
            vector: `vector[${dim}]`,
            metadata: 'string',
          },
        });

        const handle: VectorIndexHandle = {
          externalId: input.name,
          name: input.name,
          dimension: dim,
          metric,
          metadata: { ...input.metadata, provider: 'orama' },
        };

        store.set(input.name, { db, handle });
        logger?.info?.('Orama in-memory index created', { providerKey, name: input.name });
        return handle;
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        store.delete(externalId);
        logger?.info?.('Orama in-memory index deleted', { providerKey, externalId });
      },

      async listIndexes(): Promise<VectorIndexHandle[]> {
        return Array.from(store.values()).map((entry) => entry.handle);
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        const entry = store.get(handle.externalId);
        if (!entry) {
          throw new Error(`Orama index "${handle.externalId}" not found. Call createIndex first.`);
        }
        const documents = items.map((item) => ({
          id: item.id,
          vector: item.values,
          metadata: JSON.stringify(item.metadata ?? {}),
        }));
        await insertMultiple(entry.db, documents);
        logger?.debug?.('Orama upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const entry = store.get(handle.externalId);
        if (!entry) {
          throw new Error(`Orama index "${handle.externalId}" not found. Call createIndex first.`);
        }
        const result = await search(entry.db, {
          mode: 'vector',
          vector: { value: query.vector, property: 'vector' },
          limit: query.topK,
        });

        return {
          matches: result.hits.map((hit: { id: string; score: number; document: Record<string, unknown> }) => {
            let metadata: Record<string, unknown> | undefined;
            try {
              const raw = hit.document.metadata;
              metadata = typeof raw === 'string' ? JSON.parse(raw) : undefined;
            } catch {
              metadata = undefined;
            }
            return { id: hit.id, score: hit.score, metadata };
          }),
        };
      },

      async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
        const entry = store.get(handle.externalId);
        if (!entry) return;
        for (const id of ids) {
          await remove(entry.db, id);
        }
        logger?.debug?.('Orama deleted vectors', { providerKey, count: ids.length });
      },
    };

    return runtime;
  },
};
