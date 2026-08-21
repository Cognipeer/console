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
import { FULL_FILTER_OPERATORS, VectorFilterError } from '../domains/vectorFilter';
import { toMilvusExpression } from './vectorFilterTranslators';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface MilvusLocalCredentials {}

interface MilvusLocalSettings {
  host?: string;
  port?: number;
  collectionName?: string;
  vectorFieldName?: string;
  dimensions?: number;
}

const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_VECTOR_FIELD = 'vector';
const DEFAULT_PORT = 19530;

// Milvus can only filter inside a metadata column typed as JSON. Collections
// created before that switch store `metadata_json` as VarChar, where filter
// expressions cannot be evaluated, so those keep working unfiltered and reject
// filtered queries instead of silently ignoring the filter.
const MILVUS_FILTER_SCHEMA = 'json-v1';

function milvusHasFilterableSchema(handle: VectorIndexHandle): boolean {
  return handle.metadata?.filterSchema === MILVUS_FILTER_SCHEMA;
}

function milvusFilterExpression(
  handle: VectorIndexHandle,
  filter: VectorQueryInput['filter'],
): string | undefined {
  if (!filter) return undefined;
  if (!milvusHasFilterableSchema(handle)) {
    throw new VectorFilterError(
      `Milvus collection "${handle.externalId}" stores metadata as a string column, so `
      + 'metadata filters cannot be pushed down. Recreate the collection and reingest its '
      + 'vectors to enable filtering.',
    );
  }
  return toMilvusExpression(filter, 'metadata_json');
}

/** Metadata is a JSON object on new collections and a JSON string on old ones. */
function parseMilvusMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const MILVUS_FILTER_OPERATORS = FULL_FILTER_OPERATORS;
/**
 * Milvus filter expressions are strings, so an id containing a quote or
 * backslash would break the expression (or widen the delete). Escape both.
 */
function escapeMilvusString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}


export const MilvusLocalVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  MilvusLocalCredentials,
  MilvusLocalSettings
> = {
  id: 'milvus-local',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'Milvus (Self-Hosted)',
    description: 'Self-hosted Milvus vector database running locally or on your own infrastructure.',
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
            description: 'Milvus server host.',
            scope: 'settings',
          },
          {
            name: 'port',
            label: 'Port',
            type: 'number',
            required: false,
            placeholder: '19530',
            description: 'Milvus server port.',
            scope: 'settings',
          },
        ],
      },
      {
        title: 'Collection Settings',
        fields: [
          {
            name: 'collectionName',
            label: 'Default Collection Name',
            type: 'text',
            required: false,
            scope: 'settings',
          },
          {
            name: 'vectorFieldName',
            label: 'Vector Field Name',
            type: 'text',
            required: false,
            placeholder: 'vector',
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
    'vector.filterOperators': MILVUS_FILTER_OPERATORS,
    'vector.filterRaw': true,
    // Milvus serves full-text search from a BM25 function over a sparse vector
    // column, which has to be declared when the collection is created; this
    // driver's collections carry the dense field only.
    'vector.supportsHybrid': false,
  },
  async createRuntime({ settings, providerKey, logger }) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore – @zilliz/milvus2-sdk-node is an optional peer dependency
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { MilvusClient, DataType } = await import(/* webpackIgnore: true */ '@zilliz/milvus2-sdk-node') as any;

    const resolvedHost = settings.host?.trim() || 'localhost';
    const resolvedPort = settings.port ?? DEFAULT_PORT;
    const address = `${resolvedHost}:${resolvedPort}`;

    const milvusClient = new MilvusClient({ address });
    const dim = Number(settings.dimensions) > 0 ? Number(settings.dimensions) : DEFAULT_DIMENSIONS;
    const vf = settings.vectorFieldName?.trim() || DEFAULT_VECTOR_FIELD;

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const rawName = input.name || settings.collectionName;
        if (!rawName) {
          throw new Error('Collection name is required to create a Milvus Local index.');
        }
        // Milvus only allows letters, numbers and underscores
        const collectionName = rawName.replace(/[^a-zA-Z0-9_]/g, '_');
        const dimension = input.dimension || dim;
        const metric = input.metric ?? 'cosine';
        const metricType = metric === 'euclidean' ? 'L2' : metric === 'dot' ? 'IP' : 'COSINE';

        const hasCollection = await milvusClient.hasCollection({ collection_name: collectionName });
        const createdWithFilterableSchema = !hasCollection.value;
        if (!hasCollection.value) {
          await milvusClient.createCollection({
            collection_name: collectionName,
            fields: [
              { name: 'id', data_type: DataType.VarChar, max_length: 255, is_primary_key: true, auto_id: false },
              { name: vf, data_type: DataType.FloatVector, dim: dimension },
              { name: 'metadata_json', data_type: DataType.JSON },
            ],
            metric_type: metricType,
          });
          await milvusClient.createIndex({
            collection_name: collectionName,
            field_name: vf,
            index_type: 'FLAT',
            metric_type: metricType,
          });
          await milvusClient.loadCollection({ collection_name: collectionName });
          logger?.info?.('Milvus Local collection created', { providerKey, collectionName });
        }

        return {
          externalId: collectionName,
          name: collectionName,
          dimension,
          metric,
          metadata: {
            ...input.metadata,
            vectorField: vf,
            provider: 'milvus-local',
            ...(createdWithFilterableSchema ? { filterSchema: MILVUS_FILTER_SCHEMA } : {}),
          },
        };
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        await milvusClient.dropCollection({ collection_name: externalId });
      },

      async listIndexes(): Promise<VectorIndexHandle[]> {
        const result = await milvusClient.listCollections();
        const names: string[] = result.data?.map((c: { name: string }) => c.name) ?? [];
        return names.map((name) => ({
          externalId: name,
          name,
          dimension: dim,
          metric: 'cosine' as const,
          metadata: { vectorField: vf, provider: 'milvus-local' },
        }));
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        const vectorField = (handle.metadata?.vectorField as string) ?? vf;

        const hasCollection = await milvusClient.hasCollection({ collection_name: handle.externalId });
        if (!hasCollection.value) {
          throw new Error(`Milvus Local collection "${handle.externalId}" not found. Create the index first.`);
        }

        // Ensure a vector index exists before loading (collection may have been created externally without one)
        const indexInfo = await milvusClient.describeIndex({ collection_name: handle.externalId, field_name: vectorField }).catch(() => null);
        if (!indexInfo || !indexInfo.index_descriptions?.length) {
          await milvusClient.createIndex({
            collection_name: handle.externalId,
            field_name: vectorField,
            index_type: 'FLAT',
            metric_type: 'COSINE',
          });
        }

        await milvusClient.loadCollection({ collection_name: handle.externalId });

        const data = items.map((item) => ({
          id: item.id,
          [vectorField]: item.values,
          metadata_json: milvusHasFilterableSchema(handle)
            ? (item.metadata ?? {})
            : JSON.stringify(item.metadata ?? {}),
        }));
        await milvusClient.upsert({ collection_name: handle.externalId, data });
        logger?.debug?.('Milvus Local upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const vectorField = (handle.metadata?.vectorField as string) ?? vf;
        await milvusClient.loadCollection({ collection_name: handle.externalId });
        const result = await milvusClient.search({
          collection_name: handle.externalId,
          data: [query.vector],
          anns_field: vectorField,
          limit: query.topK,
          filter: milvusFilterExpression(handle, query.filter),
          output_fields: ['id', 'metadata_json'],
        });
        const hits = result.results ?? [];
        return {
          matches: hits.map((hit: { id: string; score: number; metadata_json?: unknown }) => {
            let metadata: Record<string, unknown> | undefined;
            try {
              metadata = parseMilvusMetadata(hit.metadata_json);
            } catch {
              metadata = undefined;
            }
            return { id: hit.id, score: hit.score ?? 0, metadata };
          }),
        };
      },

      async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        const expr = `id in [${ids.map((id) => `"${escapeMilvusString(id)}"`).join(', ')}]`;
        await milvusClient.deleteEntities({ collection_name: handle.externalId, expr });
      },
    
      async listVectors(handle: VectorIndexHandle, input?: VectorListInput): Promise<VectorListResult> {
        const vectorField = (handle.metadata?.vectorField as string) ?? vf;
        const limit = input?.limit ?? 100;
        const offset = input?.cursor ? parseInt(input.cursor, 10) : 0;
        try { await milvusClient.loadCollection({ collection_name: handle.externalId }); } catch (_) {}
        const countRes = await milvusClient.count({ collection_name: handle.externalId }).catch(() => null);
        const total = countRes?.data?.count != null ? Number(countRes.data.count) : undefined;
        const result = await milvusClient.query({
          collection_name: handle.externalId,
          expr: '',
          output_fields: ['id', vectorField, 'metadata_json'],
          limit,
          offset,
        });
        const items = (result.data ?? []).map((row: Record<string, unknown>) => {
          let metadata: Record<string, unknown> = {};
          metadata = parseMilvusMetadata(row.metadata_json) ?? {};
          return { id: row.id as string, values: Array.isArray(row[vectorField]) ? row[vectorField] as number[] : [], metadata };
        });
        const nextOffset = offset + items.length;
        const hasMore = total !== undefined ? nextOffset < total : items.length === limit;
        return { items, nextCursor: hasMore ? String(nextOffset) : undefined, total };
      },
    
    };

    return runtime;
  },
};
