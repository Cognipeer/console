import { MongoClient, type Db, type Collection } from 'mongodb';
import { getConfig } from '@/lib/core/config';
import type { ProviderContract } from '../types';
import type {
  CreateVectorIndexInput,
  VectorDeleteIndexInput,
  VectorIndexHandle,
  VectorProviderRuntime,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertItem,
  VectorListInput,
  VectorListResult,
} from '../domains/vector';

/**
 * MongoDB Community Vector Store — brute-force similarity, no Atlas required.
 *
 * The `mongodb` (Atlas Vector Search) contract needs a `$vectorSearch` index
 * created ahead of time via the Atlas UI/API, which only exists on Atlas
 * clusters. Self-hosted MongoDB (the `mongo:7` image in docker-compose, or
 * any Community server) has no equivalent. This contract scores every
 * candidate in application code instead — same trade-off the built-in SQLite
 * Vector Store already makes — so it works against any MongoDB deployment.
 *
 * Unlike the SQLite store, data lives in MongoDB rather than on node-local
 * disk: every app instance in a cluster reads/writes the same collections,
 * so indexing on one node and querying from another (the failure mode that
 * makes the local SQLite store unsafe in multi-instance deployments) cannot
 * happen here.
 */

interface MongoCommunityVectorCredentials {
  uri?: string;
}

interface MongoCommunityVectorSettings {
  database?: string;
  collectionPrefix?: string;
}

/* ------------------------------------------------------------------ */
/*  Similarity                                                         */
/* ------------------------------------------------------------------ */

function computeScore(
  query: number[],
  candidate: number[],
  metric: 'cosine' | 'dot' | 'euclidean',
): number {
  const len = Math.min(query.length, candidate.length);

  switch (metric) {
    case 'dot': {
      let dot = 0;
      for (let i = 0; i < len; i++) dot += query[i] * candidate[i];
      return dot;
    }
    case 'euclidean': {
      let sum = 0;
      for (let i = 0; i < len; i++) {
        const d = query[i] - candidate[i];
        sum += d * d;
      }
      return 1 / (1 + Math.sqrt(sum));
    }
    case 'cosine':
    default: {
      let dot = 0;
      let magQ = 0;
      let magC = 0;
      for (let i = 0; i < len; i++) {
        dot += query[i] * candidate[i];
        magQ += query[i] * query[i];
        magC += candidate[i] * candidate[i];
      }
      if (magQ === 0 || magC === 0) return 0;
      return dot / (Math.sqrt(magQ) * Math.sqrt(magC));
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Row types                                                          */
/* ------------------------------------------------------------------ */

interface IndexDoc {
  _id: string;
  name: string;
  dimension: number;
  metric: 'cosine' | 'dot' | 'euclidean';
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

interface EntryDoc {
  _id: string;
  indexId: string;
  vectorId: string;
  values: number[];
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

/* ------------------------------------------------------------------ */
/*  Connection resolution                                              */
/* ------------------------------------------------------------------ */

function resolveUri(credentials: MongoCommunityVectorCredentials): string {
  const explicit = credentials?.uri?.trim();
  if (explicit) return explicit;

  // Zero-config path: reuse the app's own MongoDB connection when it is
  // already the main database, mirroring the SQLite store's "no external
  // service required" positioning for Mongo-backed deployments.
  const cfg = getConfig();
  if (cfg.database.provider === 'mongodb' && cfg.database.uri) {
    return cfg.database.uri;
  }

  throw new Error(
    'MongoDB Vector Store requires a connection URI. Set DB_PROVIDER=mongodb (so the app\'s own MongoDB connection can be reused), or provide a "uri" credential explicitly.',
  );
}

// One collection pair per tenant+provider — the Mongo equivalent of the
// SQLite store's per-tenant file. Physically separates tenants instead of
// relying only on query filters to enforce isolation.
function buildCollectionNames(
  settings: MongoCommunityVectorSettings,
  tenantId: string,
  providerKey: string,
): { dbName: string; indexesCollection: string; entriesCollection: string } {
  const dbName = settings.database?.trim() || 'cognipeer_vectors';
  const prefix = settings.collectionPrefix?.trim() || 'vec';
  const safeTenant = tenantId.replace(/[^a-zA-Z0-9_]/g, '_');
  const safeProvider = providerKey.replace(/[^a-zA-Z0-9_]/g, '_');
  const suffix = `${safeTenant}__${safeProvider}`;
  return {
    dbName,
    indexesCollection: `${prefix}_indexes__${suffix}`,
    entriesCollection: `${prefix}_entries__${suffix}`,
  };
}

/* ------------------------------------------------------------------ */
/*  Contract                                                           */
/* ------------------------------------------------------------------ */

export const MongoCommunityVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  MongoCommunityVectorCredentials,
  MongoCommunityVectorSettings
> = {
  id: 'mongodb-community-vector',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'MongoDB Vector Store',
    description:
      'Shared vector store backed by any MongoDB deployment (self-hosted Community or Atlas). Scores candidates at query time instead of relying on an Atlas Search index, so it works out of the box in clustered/multi-instance deployments.',
  },
  form: {
    sections: [
      {
        title: 'Connection',
        description: 'Leave empty to reuse the app\'s own MongoDB connection (when DB_PROVIDER=mongodb).',
        fields: [
          {
            name: 'uri',
            label: 'Connection URI',
            type: 'password',
            required: false,
            placeholder: 'mongodb://user:pass@host:27017',
            description: 'Optional. Defaults to the app\'s MONGODB_URI when left empty.',
            scope: 'credentials',
          },
        ],
      },
      {
        title: 'Storage',
        fields: [
          {
            name: 'database',
            label: 'Database',
            type: 'text',
            required: false,
            placeholder: 'cognipeer_vectors',
            description: 'Optional. Defaults to a dedicated "cognipeer_vectors" database.',
            scope: 'settings',
          },
          {
            name: 'collectionPrefix',
            label: 'Collection Prefix',
            type: 'text',
            required: false,
            placeholder: 'vec',
            description: 'Optional. A tenant-scoped collection pair is created per Knowledge Engine using this prefix.',
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
    supportsMetadataFilter: false,
    local: false,
    builtin: true,
    shared: true,
  },

  async createRuntime({ tenantId, providerKey, credentials, settings, logger }) {
    const uri = resolveUri(credentials);
    const { dbName, indexesCollection, entriesCollection } = buildCollectionNames(
      settings,
      tenantId,
      providerKey,
    );

    const client = new MongoClient(uri);
    await client.connect();
    const db: Db = client.db(dbName);
    const indexes: Collection<IndexDoc> = db.collection(indexesCollection);
    const entries: Collection<EntryDoc> = db.collection(entriesCollection);

    await Promise.all([
      entries.createIndex({ indexId: 1 }),
      entries.createIndex({ indexId: 1, vectorId: 1 }, { unique: true }),
    ]);

    logger?.info?.('MongoDB community vector runtime initialised', {
      providerKey,
      dbName,
      indexesCollection,
      entriesCollection,
    });

    const runtime: VectorProviderRuntime = {
      /* ---- createIndex ---- */
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const metric = input.metric ?? 'cosine';
        const id = `idx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        await indexes.insertOne({
          _id: id,
          name: input.name,
          dimension: input.dimension,
          metric,
          metadata: input.metadata ?? null,
          createdAt: new Date(),
        });

        logger?.info?.('Created vector index', { providerKey, indexId: id, name: input.name });

        return {
          externalId: id,
          name: input.name,
          dimension: input.dimension,
          metric,
          metadata: input.metadata,
        };
      },

      /* ---- deleteIndex ---- */
      async deleteIndex({ externalId }: VectorDeleteIndexInput): Promise<void> {
        await indexes.deleteOne({ _id: externalId });
        await entries.deleteMany({ indexId: externalId });
        logger?.info?.('Deleted vector index', { providerKey, externalId });
      },

      /* ---- listIndexes ---- */
      async listIndexes(): Promise<VectorIndexHandle[]> {
        const docs = await indexes.find({}).sort({ createdAt: 1 }).toArray();
        return docs.map((d) => ({
          externalId: d._id,
          name: d.name,
          dimension: d.dimension,
          metric: d.metric,
          metadata: d.metadata ?? undefined,
        }));
      },

      /* ---- upsertVectors ---- */
      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        if (items.length === 0) return;

        for (const item of items) {
          if (item.values.length !== handle.dimension) {
            throw new Error(
              `Dimension mismatch: expected ${handle.dimension}, got ${item.values.length} for vector id=${item.id}`,
            );
          }
        }

        // Self-heal the index doc, mirroring the SQLite store: the console
        // keeps the index handle forever, so a parent row wiped independently
        // (manual cleanup, a dropped collection) must not break future writes.
        await indexes.updateOne(
          { _id: handle.externalId },
          {
            $setOnInsert: {
              _id: handle.externalId,
              name: handle.name,
              dimension: handle.dimension,
              metric: handle.metric,
              metadata: handle.metadata ?? null,
              createdAt: new Date(),
            },
          },
          { upsert: true },
        );

        const now = new Date();
        await entries.bulkWrite(
          items.map((item) => ({
            replaceOne: {
              filter: { _id: `${handle.externalId}:${item.id}` },
              replacement: {
                _id: `${handle.externalId}:${item.id}`,
                indexId: handle.externalId,
                vectorId: item.id,
                values: item.values,
                metadata: item.metadata ?? null,
                createdAt: now,
              },
              upsert: true,
            },
          })),
        );

        logger?.debug?.('Upserted vectors', {
          providerKey,
          externalId: handle.externalId,
          count: items.length,
        });
      },

      /* ---- deleteVectors ---- */
      async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        await entries.deleteMany({ indexId: handle.externalId, vectorId: { $in: ids } });
        logger?.debug?.('Deleted vectors', {
          providerKey,
          externalId: handle.externalId,
          count: ids.length,
        });
      },

      /* ---- queryVectors ---- */
      async queryVectors(
        handle: VectorIndexHandle,
        query: VectorQueryInput,
      ): Promise<VectorQueryResult> {
        if (query.vector.length !== handle.dimension) {
          throw new Error(
            `Query dimension mismatch: expected ${handle.dimension}, got ${query.vector.length}`,
          );
        }

        const metric = handle.metric ?? 'cosine';
        const topK = Math.max(1, query.topK);

        // Stream candidates and keep only the current top-K so memory stays
        // flat regardless of index size — same approach as the SQLite store.
        const best: Array<{ id: string; score: number; metadata?: Record<string, unknown> | null }> = [];
        let minIdx = 0;
        let candidateCount = 0;

        const cursor = entries.find(
          { indexId: handle.externalId },
          { projection: { vectorId: 1, values: 1, metadata: 1 } },
        );

        for await (const doc of cursor) {
          candidateCount += 1;
          const score = computeScore(query.vector, doc.values, metric);

          if (best.length < topK) {
            best.push({ id: doc.vectorId, score, metadata: doc.metadata });
            if (best.length === topK) {
              minIdx = 0;
              for (let i = 1; i < best.length; i++) {
                if (best[i].score < best[minIdx].score) minIdx = i;
              }
            }
            continue;
          }

          if (score > best[minIdx].score) {
            best[minIdx] = { id: doc.vectorId, score, metadata: doc.metadata };
            minIdx = 0;
            for (let i = 1; i < best.length; i++) {
              if (best[i].score < best[minIdx].score) minIdx = i;
            }
          }
        }

        best.sort((a, b) => b.score - a.score);

        return {
          matches: best.map((entry) => ({
            id: entry.id,
            score: entry.score,
            metadata: entry.metadata ?? undefined,
          })),
          usage: { candidateCount, metric },
        };
      },

      /* ---- listVectors ---- */
      async listVectors(
        handle: VectorIndexHandle,
        input?: VectorListInput,
      ): Promise<VectorListResult> {
        const limit = input?.limit ?? 100;
        const offset = input?.cursor ? parseInt(input.cursor, 10) : 0;

        const [docs, total] = await Promise.all([
          entries
            .find({ indexId: handle.externalId })
            .sort({ _id: 1 })
            .skip(offset)
            .limit(limit + 1)
            .toArray(),
          entries.countDocuments({ indexId: handle.externalId }),
        ]);

        const hasMore = docs.length > limit;
        const pageDocs = hasMore ? docs.slice(0, limit) : docs;

        return {
          items: pageDocs.map((doc) => ({
            id: doc.vectorId,
            values: doc.values,
            metadata: doc.metadata ?? undefined,
          })),
          nextCursor: hasMore ? String(offset + limit) : undefined,
          total,
        };
      },
    };

    return runtime;
  },
};
