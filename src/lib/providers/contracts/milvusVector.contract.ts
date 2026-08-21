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

interface MilvusCredentials {
  address: string;
  username?: string;
  password?: string;
  token?: string;
}

interface MilvusSettings {
  collectionName?: string;
  vectorFieldName?: string;
  dimensions?: number;
}

interface MilvusCollectionResult {
  value: boolean;
}

interface MilvusIndexDescription {
  metric_type?: string;
}

interface MilvusDescribeIndexResult {
  index_descriptions?: MilvusIndexDescription[];
}

interface MilvusListCollectionsResult {
  data?: Array<{ name: string }>;
}

interface MilvusSearchHit {
  id: string;
  score?: number;
  metadata_json?: unknown;
}

interface MilvusSearchResult {
  results?: MilvusSearchHit[];
}

interface MilvusCountResult {
  data?: {
    count?: number | string;
  };
}

type MilvusQueryRow = Record<string, unknown> & {
  id?: string;
  metadata_json?: unknown;
};

interface MilvusQueryResultData {
  data?: MilvusQueryRow[];
}

interface MilvusClientLike {
  hasCollection(input: { collection_name: string }): Promise<MilvusCollectionResult>;
  createCollection(input: {
    collection_name: string;
    enable_dynamic_field: boolean;
    fields: Array<Record<string, unknown>>;
  }): Promise<unknown>;
  createIndex(input: {
    collection_name: string;
    field_name: string;
    index_type: string;
    metric_type: string;
    params: Record<string, unknown>;
  }): Promise<unknown>;
  loadCollection(input: { collection_name: string }): Promise<unknown>;
  dropCollection(input: { collection_name: string }): Promise<unknown>;
  listCollections(): Promise<MilvusListCollectionsResult>;
  describeIndex(input: {
    collection_name: string;
    field_name: string;
  }): Promise<MilvusDescribeIndexResult>;
  upsert(input: {
    collection_name: string;
    data: Array<Record<string, unknown>>;
  }): Promise<unknown>;
  search(input: {
    collection_name: string;
    data: number[][];
    anns_field: string;
    limit: number;
    filter?: string;
    output_fields: string[];
  }): Promise<MilvusSearchResult>;
  deleteEntities(input: { collection_name: string; expr: string }): Promise<unknown>;
  count(input: { collection_name: string }): Promise<MilvusCountResult>;
  query(input: {
    collection_name: string;
    expr: string;
    output_fields: string[];
    limit: number;
    offset: number;
  }): Promise<MilvusQueryResultData>;
}

interface MilvusSdkModule {
  MilvusClient: new (config: Record<string, unknown>) => MilvusClientLike;
  DataType: {
    VarChar: string | number;
    FloatVector: string | number;
    JSON: string | number;
  };
}

const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_VECTOR_FIELD = 'vector';

/**
 * Milvus filter expressions are strings, so an id containing a quote or
 * backslash would break the expression (or widen the delete). Escape both.
 */
function escapeMilvusString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}


function getMilvusDimensions(settings: MilvusSettings): number {
  const parsed = Number(settings.dimensions);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DIMENSIONS;
}

function getMilvusVectorField(settings: MilvusSettings): string {
  const value = settings.vectorFieldName?.trim();
  return value && value.length > 0 ? value : DEFAULT_VECTOR_FIELD;
}

function milvusMetricType(metric: string): string {
  if (metric === 'euclidean') return 'L2';
  if (metric === 'dot') return 'IP';
  return 'COSINE';
}

function metricFromMilvusType(milvusMetric: string | undefined): 'cosine' | 'euclidean' | 'dot' {
  if (milvusMetric === 'L2') return 'euclidean';
  if (milvusMetric === 'IP') return 'dot';
  return 'cosine';
}

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

export const MilvusVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  MilvusCredentials,
  MilvusSettings
> = {
  id: 'milvus',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'Milvus / Zilliz',
    description: 'Milvus open-source vector database or Zilliz Cloud managed service.',
  },
  form: {
    sections: [
      {
        title: 'Connection',
        fields: [
          {
            name: 'address',
            label: 'Address',
            type: 'text',
            required: true,
            placeholder: 'localhost:19530',
            description: 'Milvus server address or Zilliz Cloud endpoint.',
            scope: 'credentials',
          },
          {
            name: 'token',
            label: 'Token',
            type: 'password',
            required: false,
            description: 'Authentication token for Zilliz Cloud. Takes priority over username/password.',
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
        title: 'Collection Settings',
        fields: [
          {
            name: 'collectionName',
            label: 'Default Collection Name',
            type: 'text',
            required: false,
            description: 'Default Milvus collection name for vector storage.',
            scope: 'settings',
          },
          {
            name: 'vectorFieldName',
            label: 'Vector Field Name',
            type: 'text',
            required: false,
            placeholder: 'vector',
            description: 'Name of the vector field in the Milvus collection.',
            scope: 'settings',
          },
          {
            name: 'dimensions',
            label: 'Dimensions',
            type: 'number',
            required: false,
            placeholder: '1536',
            description: 'Embedding vector dimensions.',
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
  },
  async createRuntime({ credentials, settings, providerKey, logger }) {
    if (!credentials?.address?.trim()) {
      throw new Error('Milvus address is required.');
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore – @zilliz/milvus2-sdk-node is an optional peer dependency
    const { MilvusClient, DataType } = (await import(/* webpackIgnore: true */ '@zilliz/milvus2-sdk-node')) as unknown as MilvusSdkModule;

    const clientConfig: Record<string, unknown> = {
      address: credentials.address.trim(),
    };

    if (credentials.token) {
      clientConfig.token = credentials.token;
    } else if (credentials.username && credentials.password) {
      clientConfig.username = credentials.username;
      clientConfig.password = credentials.password;
    }

    const milvusClient = new MilvusClient(clientConfig);
    const dimensions = getMilvusDimensions(settings);
    const vectorField = getMilvusVectorField(settings);

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const collectionName = input.name || settings.collectionName;
        if (!collectionName) {
          throw new Error('Collection name is required to create a Milvus index.');
        }
        const dim = input.dimension || dimensions;
        const metric = input.metric ?? 'cosine';

        const hasCollection = await milvusClient.hasCollection({ collection_name: collectionName });
        const createdWithFilterableSchema = !hasCollection.value;

        if (!hasCollection.value) {
          await milvusClient.createCollection({
            collection_name: collectionName,
            enable_dynamic_field: true,
            fields: [
              { name: 'id', data_type: DataType.VarChar, max_length: 255, is_primary_key: true, auto_id: false },
              { name: vectorField, data_type: DataType.FloatVector, dim },
              { name: 'metadata_json', data_type: DataType.JSON },
            ],
          });
          // Use AUTOINDEX for cloud compatibility (Zilliz), FLAT is used for local
          const isCloud = !!credentials.token;
          await milvusClient.createIndex({
            collection_name: collectionName,
            field_name: vectorField,
            index_type: isCloud ? 'AUTOINDEX' : 'FLAT',
            metric_type: milvusMetricType(metric),
            params: {},
          });
          await milvusClient.loadCollection({ collection_name: collectionName });
          logger?.info?.('Milvus collection created', { providerKey, collectionName });
        } else {
          try { await milvusClient.loadCollection({ collection_name: collectionName }); } catch { /* already loaded */ }
        }

        return {
          externalId: collectionName,
          name: collectionName,
          dimension: dim,
          metric,
          metadata: {
            ...input.metadata,
            vectorField,
            provider: 'milvus',
            ...(createdWithFilterableSchema ? { filterSchema: MILVUS_FILTER_SCHEMA } : {}),
          },
        };
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        await milvusClient.dropCollection({ collection_name: externalId });
        logger?.info?.('Milvus collection dropped', { providerKey, externalId });
      },

      async listIndexes(): Promise<VectorIndexHandle[]> {
        const result = await milvusClient.listCollections();
        const names: string[] = result.data?.map((c: { name: string }) => c.name) ?? [];
        return Promise.all(
          names.map(async (name) => {
            const descResult = await milvusClient.describeIndex({ collection_name: name, field_name: vectorField }).catch(() => null);
            const milvusMetric: string | undefined = descResult?.index_descriptions?.[0]?.metric_type;
            const metric = metricFromMilvusType(milvusMetric);
            return {
              externalId: name,
              name,
              dimension: dimensions,
              metric,
              metadata: { vectorField, provider: 'milvus' },
            };
          }),
        );
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        const vf = (handle.metadata?.vectorField as string) ?? vectorField;

        // Ensure index exists before upsert (collection may have been created externally)
        const indexInfo = await milvusClient.describeIndex({ collection_name: handle.externalId, field_name: vf }).catch(() => null);
        if (!indexInfo || !indexInfo.index_descriptions?.length) {
          const isCloud = !!credentials.token;
          await milvusClient.createIndex({
            collection_name: handle.externalId,
            field_name: vf,
            index_type: isCloud ? 'AUTOINDEX' : 'FLAT',
            metric_type: milvusMetricType(handle.metric ?? 'cosine'),
            params: {},
          });
        }
        try { await milvusClient.loadCollection({ collection_name: handle.externalId }); } catch { /* already loaded */ }

        const data = items.map((item) => ({
          id: item.id,
          [vf]: item.values,
          metadata_json: milvusHasFilterableSchema(handle)
            ? (item.metadata ?? {})
            : JSON.stringify(item.metadata ?? {}),
        }));

        await milvusClient.upsert({
          collection_name: handle.externalId,
          data,
        });

        logger?.debug?.('Milvus upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const vf = (handle.metadata?.vectorField as string) ?? vectorField;

        try { await milvusClient.loadCollection({ collection_name: handle.externalId }); } catch { /* already loaded */ }

        const result = await milvusClient.search({
          collection_name: handle.externalId,
          data: [query.vector],
          anns_field: vf,
          limit: query.topK,
          filter: milvusFilterExpression(handle, query.filter),
          output_fields: ['id', 'metadata_json'],
        });

        const hits: MilvusSearchHit[] = result.results ?? [];
        return {
          matches: hits.map((hit) => {
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
        logger?.debug?.('Milvus deleted vectors', { providerKey, count: ids.length });
      },

      async listVectors(handle: VectorIndexHandle, input?: VectorListInput): Promise<VectorListResult> {
        const vf = (handle.metadata?.vectorField as string) ?? vectorField;
        const limit = input?.limit ?? 100;
        const offset = input?.cursor ? parseInt(input.cursor, 10) : 0;

        try { await milvusClient.loadCollection({ collection_name: handle.externalId }); } catch { /* already loaded */ }

        const countRes = await milvusClient.count({ collection_name: handle.externalId }).catch(() => null);
        const total: number | undefined = countRes?.data?.count != null ? Number(countRes.data.count) : undefined;

        const result = await milvusClient.query({
          collection_name: handle.externalId,
          expr: '',
          output_fields: ['id', vf, 'metadata_json'],
          limit,
          offset,
        });

        const items = (result.data ?? []).map((row: Record<string, unknown>) => {
          let metadata: Record<string, unknown> = {};
          metadata = parseMilvusMetadata(row.metadata_json) ?? {};
          return {
            id: row.id as string,
            values: Array.isArray(row[vf]) ? row[vf] as number[] : [],
            metadata,
          };
        });

        const nextOffset = offset + items.length;
        const hasMore = total !== undefined ? nextOffset < total : items.length === limit;

        return { items, nextCursor: hasMore ? String(nextOffset) : undefined, total };
      },
    };

    return runtime;
  },
};
