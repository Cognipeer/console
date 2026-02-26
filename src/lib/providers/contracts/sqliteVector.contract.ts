import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { ProviderContract } from '../types';
import type {
  CreateVectorIndexInput,
  VectorDeleteIndexInput,
  VectorIndexHandle,
  VectorProviderRuntime,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertItem,
} from '../domains/vector';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type LocalVectorCredentials = Record<string, never>;

interface LocalVectorSettings {
  basePath: string;
}

/* ------------------------------------------------------------------ */
/*  Similarity helpers                                                 */
/* ------------------------------------------------------------------ */

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = dotProduct(a, b);
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function computeScore(
  a: number[],
  b: number[],
  metric: 'cosine' | 'dot' | 'euclidean',
): number {
  switch (metric) {
    case 'cosine':
      return cosineSimilarity(a, b);
    case 'dot':
      return dotProduct(a, b);
    case 'euclidean':
      // Convert distance to a similarity-style score: 1 / (1 + distance)
      return 1 / (1 + euclideanDistance(a, b));
  }
}

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

const INDEXES_DDL = `
CREATE TABLE IF NOT EXISTS vector_indexes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  dimension   INTEGER NOT NULL,
  metric      TEXT NOT NULL DEFAULT 'cosine',
  metadata    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const ENTRIES_DDL = `
CREATE TABLE IF NOT EXISTS vector_entries (
  id          TEXT NOT NULL,
  index_id    TEXT NOT NULL,
  vec_values  TEXT NOT NULL,
  metadata    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (index_id, id),
  FOREIGN KEY (index_id) REFERENCES vector_indexes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_vector_entries_index ON vector_entries(index_id);
`;

/* ------------------------------------------------------------------ */
/*  Database helpers                                                   */
/* ------------------------------------------------------------------ */

function openDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(INDEXES_DDL);
  db.exec(ENTRIES_DDL);
  return db;
}

function buildDbPath(
  settings: LocalVectorSettings,
  tenantId: string,
  providerKey: string,
): string {
  const base = settings.basePath?.trim();
  if (!base) {
    throw new Error('SQLite vector provider requires a basePath setting.');
  }
  return path.resolve(base, tenantId, `${providerKey}-vectors.sqlite`);
}

/* ------------------------------------------------------------------ */
/*  Row types                                                          */
/* ------------------------------------------------------------------ */

interface IndexRow {
  id: string;
  name: string;
  dimension: number;
  metric: string;
  metadata: string | null;
}

interface EntryRow {
  id: string;
  index_id: string;
  vec_values: string;
  metadata: string | null;
}

/* ------------------------------------------------------------------ */
/*  Contract                                                           */
/* ------------------------------------------------------------------ */

export const SqliteVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  LocalVectorCredentials,
  LocalVectorSettings
> = {
  id: 'sqlite-vector',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'SQLite Vector Store',
    description:
      'Local vector store using SQLite with brute-force similarity search. No external dependencies required.',
  },
  form: {
    sections: [
      {
        title: 'Storage',
        description: 'Configure where vector data is stored on disk.',
        fields: [
          {
            name: 'basePath',
            label: 'Data Directory',
            type: 'text',
            required: true,
            placeholder: './data/vectors',
            description:
              'Base directory for vector SQLite files. A subdirectory is created per tenant.',
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
    maxDimension: 4096,
    local: true,
  },

  createRuntime({ tenantId, providerKey, settings, logger }) {
    const dbPath = buildDbPath(settings, tenantId, providerKey);
    const db = openDb(dbPath);

    logger?.info?.('SQLite vector runtime initialised', {
      providerKey,
      dbPath,
    });

    const runtime: VectorProviderRuntime = {
      /* ---- createIndex ---- */
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const metric = input.metric ?? 'cosine';
        const id = `idx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        db.prepare(
          `INSERT INTO vector_indexes (id, name, dimension, metric, metadata) VALUES (?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.name,
          input.dimension,
          metric,
          input.metadata ? JSON.stringify(input.metadata) : null,
        );

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
        // Foreign key cascade deletes entries
        db.prepare(`DELETE FROM vector_indexes WHERE id = ?`).run(externalId);
        logger?.info?.('Deleted vector index', { providerKey, externalId });
      },

      /* ---- listIndexes ---- */
      async listIndexes(): Promise<VectorIndexHandle[]> {
        const rows = db.prepare(`SELECT * FROM vector_indexes ORDER BY created_at ASC`).all() as IndexRow[];
        return rows.map((r) => ({
          externalId: r.id,
          name: r.name,
          dimension: r.dimension,
          metric: r.metric as 'cosine' | 'dot' | 'euclidean',
          metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
        }));
      },

      /* ---- upsertVectors ---- */
      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        if (items.length === 0) return;

        const stmt = db.prepare(`
          INSERT INTO vector_entries (id, index_id, vec_values, metadata)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(index_id, id) DO UPDATE SET
            vec_values = excluded.vec_values,
            metadata   = excluded.metadata
        `);

        const tx = db.transaction((rows: VectorUpsertItem[]) => {
          for (const item of rows) {
            if (item.values.length !== handle.dimension) {
              throw new Error(
                `Dimension mismatch: expected ${handle.dimension}, got ${item.values.length} for vector id=${item.id}`,
              );
            }
            stmt.run(
              item.id,
              handle.externalId,
              JSON.stringify(item.values),
              item.metadata ? JSON.stringify(item.metadata) : null,
            );
          }
        });

        tx(items);

        logger?.debug?.('Upserted vectors', {
          providerKey,
          externalId: handle.externalId,
          count: items.length,
        });
      },

      /* ---- deleteVectors ---- */
      async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
        if (ids.length === 0) return;

        const placeholders = ids.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM vector_entries WHERE index_id = ? AND id IN (${placeholders})`,
        ).run(handle.externalId, ...ids);

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

        const rows = db
          .prepare(`SELECT id, vec_values, metadata FROM vector_entries WHERE index_id = ?`)
          .all(handle.externalId) as EntryRow[];

        const metric = handle.metric ?? 'cosine';

        // Compute scores using brute-force similarity
        const scored = rows.map((row) => {
          const values: number[] = JSON.parse(row.vec_values);
          return {
            id: row.id,
            score: computeScore(query.vector, values, metric),
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
          };
        });

        // Sort by score descending (higher = more similar)
        scored.sort((a, b) => b.score - a.score);

        return {
          matches: scored.slice(0, query.topK),
          usage: {
            candidateCount: rows.length,
            metric,
          },
        };
      },
    };

    return runtime;
  },
};
