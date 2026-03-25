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

const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_VECTOR_FIELD = 'vector';

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
  },
  async createRuntime({ credentials, settings, providerKey, logger }) {
    if (!credentials?.address?.trim()) {
      throw new Error('Milvus address is required.');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-ts-comment
    // @ts-ignore – @zilliz/milvus2-sdk-node is an optional peer dependency
    const { MilvusClient, DataType } = await import('@zilliz/milvus2-sdk-node') as any;

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

        if (!hasCollection.value) {
          await milvusClient.createCollection({
            collection_name: collectionName,
            enable_dynamic_field: true,
            fields: [
              { name: 'id', data_type: DataType.VarChar, max_length: 255, is_primary_key: true, auto_id: false },
              { name: vectorField, data_type: DataType.FloatVector, dim },
              { name: 'metadata_json', data_type: DataType.VarChar, max_length: 65535, default_value: '{}' },
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
          try { await milvusClient.loadCollection({ collection_name: collectionName }); } catch (_) { /* already loaded */ }
        }

        return {
          externalId: collectionName,
          name: collectionName,
          dimension: dim,
          metric,
          metadata: { ...input.metadata, vectorField, provider: 'milvus' },
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
        try { await milvusClient.loadCollection({ collection_name: handle.externalId }); } catch (_) { /* already loaded */ }

        const data = items.map((item) => ({
          id: item.id,
          [vf]: item.values,
          metadata_json: JSON.stringify(item.metadata ?? {}),
        }));

        await milvusClient.upsert({
          collection_name: handle.externalId,
          data,
        });

        logger?.debug?.('Milvus upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const vf = (handle.metadata?.vectorField as string) ?? vectorField;

        try { await milvusClient.loadCollection({ collection_name: handle.externalId }); } catch (_) { /* already loaded */ }

        const result = await milvusClient.search({
          collection_name: handle.externalId,
          data: [query.vector],
          anns_field: vf,
          limit: query.topK,
          filter: query.filter ? JSON.stringify(query.filter) : undefined,
          output_fields: ['id', 'metadata_json'],
        });

        const hits = result.results ?? [];
        return {
          matches: hits.map((hit: { id: string; score: number; metadata_json?: string }) => {
            let metadata: Record<string, unknown> | undefined;
            try {
              metadata = hit.metadata_json ? JSON.parse(hit.metadata_json) : undefined;
            } catch {
              metadata = undefined;
            }
            return { id: hit.id, score: hit.score ?? 0, metadata };
          }),
        };
      },

      async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        const expr = `id in [${ids.map((id) => `"${id}"`).join(', ')}]`;
        await milvusClient.deleteEntities({ collection_name: handle.externalId, expr });
        logger?.debug?.('Milvus deleted vectors', { providerKey, count: ids.length });
      },

      async listVectors(handle: VectorIndexHandle, input?: VectorListInput): Promise<VectorListResult> {
        const vf = (handle.metadata?.vectorField as string) ?? vectorField;
        const limit = input?.limit ?? 100;
        const offset = input?.cursor ? parseInt(input.cursor, 10) : 0;

        try { await milvusClient.loadCollection({ collection_name: handle.externalId }); } catch (_) { /* already loaded */ }

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
          try { metadata = row.metadata_json ? JSON.parse(row.metadata_json as string) : {}; } catch { /* ignore */ }
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
