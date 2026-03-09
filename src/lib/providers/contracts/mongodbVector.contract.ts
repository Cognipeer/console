import { MongoClient, type Db, type Collection } from 'mongodb';
import type { ProviderContract } from '../types';
import type {
  CreateVectorIndexInput,
  VectorIndexHandle,
  VectorProviderRuntime,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertItem,
} from '../domains/vector';

interface MongoDbVectorCredentials {
  uri: string;
}

interface MongoDbVectorSettings {
  database: string;
  collection: string;
  indexName?: string;
  vectorField?: string;
  dimensions?: number;
}

const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_VECTOR_FIELD = 'embedding';

type VectorDocument = {
  _id: string;
  [field: string]: unknown;
  metadata?: Record<string, unknown>;
};

async function getMongoCollection(
  uri: string,
  database: string,
  collectionName: string,
): Promise<{ client: MongoClient; db: Db; coll: Collection<VectorDocument> }> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(database);
  const coll = db.collection<VectorDocument>(collectionName);
  return { client, db, coll };
}

export const MongoDbVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  MongoDbVectorCredentials,
  MongoDbVectorSettings
> = {
  id: 'mongodb',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'MongoDB Atlas Vector Search',
    description: 'MongoDB Atlas $vectorSearch for semantic similarity search on Atlas deployments.',
  },
  form: {
    sections: [
      {
        title: 'Connection',
        fields: [
          {
            name: 'uri',
            label: 'Connection URI',
            type: 'password',
            required: true,
            placeholder: 'mongodb+srv://user:pass@cluster.mongodb.net',
            description: 'MongoDB Atlas connection string.',
            scope: 'credentials',
          },
        ],
      },
      {
        title: 'Database & Collection',
        fields: [
          {
            name: 'database',
            label: 'Database',
            type: 'text',
            required: true,
            description: 'MongoDB database name.',
            scope: 'settings',
          },
          {
            name: 'collection',
            label: 'Collection',
            type: 'text',
            required: true,
            description: 'MongoDB collection that stores the vector documents.',
            scope: 'settings',
          },
          {
            name: 'indexName',
            label: 'Vector Search Index Name',
            type: 'text',
            required: false,
            placeholder: 'vector_index',
            description:
              'Atlas Vector Search index name. The index must already exist in Atlas UI or via the Atlas API.',
            scope: 'settings',
          },
          {
            name: 'vectorField',
            label: 'Vector Field Name',
            type: 'text',
            required: false,
            placeholder: 'embedding',
            description: 'Name of the field that stores vector embeddings in each document.',
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
    if (!credentials?.uri?.trim()) {
      throw new Error('MongoDB connection URI is required.');
    }
    if (!settings?.database?.trim()) {
      throw new Error('MongoDB database name is required.');
    }
    if (!settings?.collection?.trim()) {
      throw new Error('MongoDB collection name is required.');
    }

    const uri = credentials.uri.trim();
    const database = settings.database.trim();
    const collectionName = settings.collection.trim();
    const indexName = settings.indexName?.trim() || 'vector_index';
    const vectorField = settings.vectorField?.trim() || DEFAULT_VECTOR_FIELD;
    const dimensions = Number(settings.dimensions) > 0 ? Number(settings.dimensions) : DEFAULT_DIMENSIONS;

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        // MongoDB Atlas vector search indexes must be created via Atlas UI or API.
        // This method validates connectivity and returns a handle for the configured collection.
        const { client, coll } = await getMongoCollection(uri, database, collectionName);
        try {
          await coll.findOne({}, { projection: { _id: 1 } });
          logger?.info?.('MongoDB Atlas collection verified', { providerKey, database, collectionName });
        } finally {
          await client.close();
        }

        const name = input.name || collectionName;
        const dim = input.dimension || dimensions;
        const metric = input.metric ?? 'cosine';

        return {
          externalId: `${database}/${collectionName}/${indexName}`,
          name,
          dimension: dim,
          metric,
          metadata: {
            ...input.metadata,
            database,
            collectionName,
            indexName,
            vectorField,
            provider: 'mongodb',
          },
        };
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        // MongoDB Atlas vector search indexes cannot be dropped programmatically here.
        // This is a no-op; indexes must be deleted via Atlas UI or the Atlas API.
        logger?.warn?.('MongoDB Atlas vector search indexes must be deleted via Atlas UI or API.', {
          providerKey,
          externalId,
        });
      },

      async listIndexes(): Promise<VectorIndexHandle[]> {
        return [
          {
            externalId: `${database}/${collectionName}/${indexName}`,
            name: collectionName,
            dimension: dimensions,
            metric: 'cosine',
            metadata: { database, collectionName, indexName, vectorField, provider: 'mongodb' },
          },
        ];
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        const meta = handle.metadata ?? {};
        const db = (meta.database as string) || database;
        const coll_ = (meta.collectionName as string) || collectionName;
        const vf = (meta.vectorField as string) || vectorField;

        const { client, coll } = await getMongoCollection(uri, db, coll_);
        try {
          const ops = items.map((item) => ({
            replaceOne: {
              filter: { _id: item.id as unknown },
              replacement: {
                _id: item.id,
                [vf]: item.values,
                metadata: item.metadata ?? {},
              },
              upsert: true,
            },
          }));
          await coll.bulkWrite(ops as Parameters<typeof coll.bulkWrite>[0]);
          logger?.debug?.('MongoDB upserted vectors', { providerKey, count: items.length });
        } finally {
          await client.close();
        }
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const meta = handle.metadata ?? {};
        const db = (meta.database as string) || database;
        const coll_ = (meta.collectionName as string) || collectionName;
        const idx = (meta.indexName as string) || indexName;
        const vf = (meta.vectorField as string) || vectorField;

        const { client, coll } = await getMongoCollection(uri, db, coll_);
        try {
          const pipeline: Record<string, unknown>[] = [
            {
              $vectorSearch: {
                index: idx,
                path: vf,
                queryVector: query.vector,
                numCandidates: query.topK * 10,
                limit: query.topK,
                filter: query.filter,
              },
            },
            {
              $project: {
                _id: 1,
                metadata: 1,
                score: { $meta: 'vectorSearchScore' },
              },
            },
          ];

          const results = await coll.aggregate(pipeline).toArray();
          return {
            matches: results.map((doc) => ({
              id: doc._id as string,
              score: (doc as Record<string, unknown>).score as number ?? 0,
              metadata: doc.metadata as Record<string, unknown> | undefined,
            })),
          };
        } finally {
          await client.close();
        }
      },

      async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        const meta = handle.metadata ?? {};
        const db = (meta.database as string) || database;
        const coll_ = (meta.collectionName as string) || collectionName;

        const { client, coll } = await getMongoCollection(uri, db, coll_);
        try {
          await coll.deleteMany({ _id: { $in: ids } } as Parameters<typeof coll.deleteMany>[0]);
          logger?.debug?.('MongoDB deleted vectors', { providerKey, count: ids.length });
        } finally {
          await client.close();
        }
      },
    };

    return runtime;
  },
};
