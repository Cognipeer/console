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
  },
  async createRuntime({ settings, providerKey, logger }) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore – @zilliz/milvus2-sdk-node is an optional peer dependency
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { MilvusClient, DataType } = await import('@zilliz/milvus2-sdk-node') as any;

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
          metadata: { ...input.metadata, vectorField: vf, provider: 'milvus-local' },
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
          metadata_json: JSON.stringify(item.metadata ?? {}),
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
