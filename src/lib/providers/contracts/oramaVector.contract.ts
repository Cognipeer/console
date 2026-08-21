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
import {
  describeHybrid,
  extractVectorText,
  fuseHybridMatches,
  hybridCandidateCount,
  resolveHybridOptions,
  type VectorHybridChannelHit,
} from '../domains/vectorHybrid';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface OramaCredentials {}

interface OramaSettings {
  defaultDimension?: number;
}

type OramaStore = Record<string, unknown>;

type OramaVectorSearchParams = {
  mode: 'vector';
  vector: { value: number[]; property: string };
  limit?: number;
  similarity?: number;
};

type OramaListSearchParams = {
  mode: 'fulltext';
  term: string;
  limit?: number;
  offset?: number;
  /**
   * Without this Orama also matches the metadata JSON blob, so a query for
   * "content" would hit every document through its own field names.
   */
  properties?: string[];
};

type OramaSearchHit = {
  id: string;
  score: number;
  document: Record<string, unknown>;
};

type OramaSearchResult = {
  hits: OramaSearchHit[];
  count?: number;
};

type OramaModule = {
  create: (options: { schema: Record<string, unknown> }) => Promise<OramaStore>;
  insertMultiple: (db: OramaStore, documents: Record<string, unknown>[]) => Promise<void>;
  remove: (db: OramaStore, id: string) => Promise<boolean>;
  search: (db: OramaStore, params: OramaVectorSearchParams | OramaListSearchParams) => Promise<OramaSearchResult>;
};

const DEFAULT_DIMENSIONS = 1536;

function toChannelHit(hit: OramaSearchHit): VectorHybridChannelHit {
  let metadata: Record<string, unknown> | undefined;
  try {
    const raw = hit.document.metadata;
    metadata = typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch {
    metadata = undefined;
  }
  return { id: hit.id, score: hit.score, metadata };
}

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
    // Orama indexes metadata as an opaque JSON string, so its `where` clause
    // cannot address individual metadata keys. Declaring no operators makes
    // filtered queries fail loudly instead of returning unfiltered results.
    'vector.filterOperators': [],
    'vector.supportsHybrid': true,
  },
  async createRuntime({ settings, providerKey, logger }) {
    // @ts-expect-error -- @orama/orama is an optional peer dependency
    const orama = await import(/* webpackIgnore: true */ '@orama/orama') as unknown as OramaModule;
    const { create, insertMultiple, remove, search } = orama;

    const dimensions = Number(settings.defaultDimension) > 0
      ? Number(settings.defaultDimension)
      : DEFAULT_DIMENSIONS;

    // In-memory store: externalId → { db, handle }
    const store = new Map<string, { db: OramaStore; handle: VectorIndexHandle }>();

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const dim = input.dimension || dimensions;
        const metric = input.metric ?? 'cosine';

        const db = await create({
          schema: {
            id: 'string',
            vector: `vector[${dim}]`,
            metadata: 'string',
            // The keyword channel needs the chunk text as a field of its own;
            // the metadata blob is stored JSON, not searchable prose.
            content: 'string',
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
          content: extractVectorText(item.metadata) ?? '',
        }));
        // Orama's insertMultiple is an insert, not an upsert — re-ingesting a
        // document would duplicate every chunk. Drop existing ids first.
        for (const item of items) {
          try {
            await remove(entry.db, item.id);
          } catch {
            // not present yet — nothing to replace
          }
        }
        await insertMultiple(entry.db, documents);
        logger?.debug?.('Orama upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const entry = store.get(handle.externalId);
        if (!entry) {
          throw new Error(`Orama index "${handle.externalId}" not found. Call createIndex first.`);
        }
        const text = query.text?.trim();
        const limit = text ? hybridCandidateCount(query.topK) : query.topK;

        const dense = await search(entry.db, {
          mode: 'vector',
          vector: { value: query.vector, property: 'vector' },
          limit,
        });

        if (!text) {
          return { matches: dense.hits.map(toChannelHit) };
        }

        const lexical = await search(entry.db, {
          mode: 'fulltext',
          term: text,
          properties: ['content'],
          limit,
        });

        return {
          matches: fuseHybridMatches({
            dense: dense.hits.map(toChannelHit),
            lexical: lexical.hits.map(toChannelHit),
            topK: query.topK,
            options: query.hybrid,
          }),
          usage: describeHybrid({ ran: true, mode: resolveHybridOptions(query.hybrid).mode }),
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
    
      async listVectors(handle: VectorIndexHandle, input?: VectorListInput): Promise<VectorListResult> {
        const entry = store.get(handle.externalId);
        if (!entry) throw new Error(`Orama index "${handle.externalId}" not found. Call createIndex first.`);
        const limit = input?.limit ?? 100;
        const offset = input?.cursor ? parseInt(input.cursor, 10) : 0;
        const result = await search(entry.db, { mode: 'fulltext', term: '', limit, offset });
        const total: number = result.count ?? 0;
        const items = (result.hits ?? []).map((hit: OramaSearchHit) => {
          let metadata: Record<string, unknown> = {};
          try { if (hit.document?.metadata) metadata = JSON.parse(hit.document.metadata as string); } catch {}
          const values = Array.isArray(hit.document?.vector) ? hit.document.vector as number[] : [];
          return { id: hit.id as string, values, metadata };
        });
        const nextOffset = offset + items.length;
        return { items, nextCursor: nextOffset < total ? String(nextOffset) : undefined, total };
      },
    
    };

    return runtime;
  },
};
