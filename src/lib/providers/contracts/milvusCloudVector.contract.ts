import type { ProviderContract } from '../types';
import type {
  CreateVectorIndexInput,
  VectorIndexHandle,
  VectorProviderRuntime,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertItem,
} from '../domains/vector';

interface MilvusCloudCredentials {
  address: string;
  token: string;
}

interface MilvusCloudSettings {
  collectionName?: string;
  vectorFieldName?: string;
  dimensions?: number;
}

const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_VECTOR_FIELD = 'vector';

export const MilvusCloudVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  MilvusCloudCredentials,
  MilvusCloudSettings
> = {
  id: 'milvus-cloud',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'Zilliz Cloud (Milvus)',
    description: 'Zilliz Cloud — fully managed Milvus vector database service.',
  },
  form: {
    sections: [
      {
        title: 'Zilliz Cloud',
        fields: [
          {
            name: 'address',
            label: 'Endpoint',
            type: 'text',
            required: true,
            placeholder: 'https://<cluster-id>.api.gcp-us-west1.zillizcloud.com',
            description: 'Zilliz Cloud cluster public endpoint.',
            scope: 'credentials',
          },
          {
            name: 'token',
            label: 'API Token',
            type: 'password',
            required: true,
            description: 'Zilliz Cloud API token.',
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
  },
  async createRuntime({ credentials, settings, providerKey, logger }) {
    if (!credentials?.address?.trim()) {
      throw new Error('Zilliz Cloud endpoint address is required.');
    }
    if (!credentials?.token?.trim()) {
      throw new Error('Zilliz Cloud API token is required.');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-ts-comment
    // @ts-ignore – @zilliz/milvus2-sdk-node is an optional peer dependency
    const { MilvusClient, DataType } = await import('@zilliz/milvus2-sdk-node') as any;

    const milvusClient = new MilvusClient({
      address: credentials.address.trim(),
      token: credentials.token,
    });

    const dim = Number(settings.dimensions) > 0 ? Number(settings.dimensions) : DEFAULT_DIMENSIONS;
    const vf = settings.vectorFieldName?.trim() || DEFAULT_VECTOR_FIELD;

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const collectionName = input.name || settings.collectionName;
        if (!collectionName) {
          throw new Error('Collection name is required to create a Zilliz Cloud index.');
        }
        const dimension = input.dimension || dim;
        const metric = input.metric ?? 'cosine';
        const metricType = metric === 'euclidean' ? 'L2' : metric === 'dot' ? 'IP' : 'COSINE';

        const hasCollection = await milvusClient.hasCollection({ collection_name: collectionName });
        if (!hasCollection.value) {
          await milvusClient.createCollection({
            collection_name: collectionName,
            fields: [
              { name: 'id', data_type: DataType.VarChar, max_length: 255, is_primary_key: true, auto_id: false },
              { name: vf, data_type: DataType.FloatVector, dim: dimension },
              { name: 'metadata_json', data_type: DataType.VarChar, max_length: 65535, default_value: '{}' },
            ],
            metric_type: metricType,
          });
          logger?.info?.('Zilliz Cloud collection created', { providerKey, collectionName });
        }

        return {
          externalId: collectionName,
          name: collectionName,
          dimension,
          metric,
          metadata: { ...input.metadata, vectorField: vf, provider: 'milvus-cloud' },
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
          metadata: { vectorField: vf, provider: 'milvus-cloud' },
        }));
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        const vectorField = (handle.metadata?.vectorField as string) ?? vf;
        const data = items.map((item) => ({
          id: item.id,
          [vectorField]: item.values,
          metadata_json: JSON.stringify(item.metadata ?? {}),
        }));
        await milvusClient.upsert({ collection_name: handle.externalId, data });
        logger?.debug?.('Zilliz Cloud upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const vectorField = (handle.metadata?.vectorField as string) ?? vf;
        const result = await milvusClient.search({
          collection_name: handle.externalId,
          data: [query.vector],
          anns_field: vectorField,
          limit: query.topK,
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
      },
    };

    return runtime;
  },
};
