import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
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

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type LocalVectorCredentials = Record<string, never>;

interface LocalVectorSettings {
  basePath?: string;
}

/* ------------------------------------------------------------------ */
/*  Vector encoding                                                    */
/* ------------------------------------------------------------------ */

// Vectors are stored as Float32Array BLOBs (4 bytes/dimension). Rows written
// by earlier versions hold JSON text in the same column; decodeVector accepts
// both so existing databases keep working without migration.

function encodeVector(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

function decodeVector(raw: unknown): Float32Array {
  if (Buffer.isBuffer(raw)) {
    // Copy into a fresh ArrayBuffer: pooled Buffers are not 4-byte aligned.
    return new Float32Array(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    );
  }
  return Float32Array.from(JSON.parse(String(raw)) as number[]);
}

/* ------------------------------------------------------------------ */
/*  Similarity helpers                                                 */
/* ------------------------------------------------------------------ */

function computeScore(
  query: Float32Array,
  candidate: Float32Array,
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
      // Convert distance to a similarity-style score: 1 / (1 + distance)
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
  // Must be set before the first table is created to take effect; lets
  // deleteIndex reclaim disk space via incremental_vacuum when many
  // indexes come and go. A no-op on databases created without it.
  db.pragma('auto_vacuum = INCREMENTAL');
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
  const base = settings.basePath?.trim()
    || path.join(getConfig().storage.dataDir, 'vectors');
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
  vec_values: Buffer | string;
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
  version: '1.1.0',
  domains: ['vector'],
  display: {
    label: 'SQLite Vector Store',
    description:
      'Built-in local vector store backed by SQLite. Persistent, zero-configuration, no external dependencies required.',
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
            required: false,
            placeholder: 'Defaults to DATA_DIR/vectors',
            description:
              'Optional base directory for vector SQLite files. Leave empty to use the built-in data directory (DATA_DIR/vectors). A subdirectory is created per tenant.',
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
    builtin: true,
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
        try {
          db.pragma('incremental_vacuum');
        } catch {
          // Databases created before auto_vacuum was enabled cannot vacuum
          // incrementally; the space is reused by future inserts instead.
        }
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

        // Self-heal the index row. The console DB keeps the index record
        // (externalId) forever, but this file can be recreated empty (deleted
        // basePath, /tmp cleanup, relative path resolved against a new cwd) —
        // without the parent row every insert dies on the FK constraint.
        db.prepare(
          `INSERT OR IGNORE INTO vector_indexes (id, name, dimension, metric, metadata) VALUES (?, ?, ?, ?, ?)`,
        ).run(
          handle.externalId,
          handle.name,
          handle.dimension,
          handle.metric ?? 'cosine',
          handle.metadata ? JSON.stringify(handle.metadata) : null,
        );

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
              encodeVector(item.values),
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

        const queryVec = Float32Array.from(query.vector);
        const metric = handle.metric ?? 'cosine';
        const topK = Math.max(1, query.topK);

        // Stream rows and keep only the current top-K candidates so memory
        // stays flat no matter how large the index grows. Metadata JSON is
        // parsed lazily for the final matches only.
        const best: Array<{ id: string; score: number; metadataRaw: string | null }> = [];
        let minIdx = 0;
        let candidateCount = 0;

        const rows = db
          .prepare(`SELECT id, vec_values, metadata FROM vector_entries WHERE index_id = ?`)
          .iterate(handle.externalId) as IterableIterator<EntryRow>;

        for (const row of rows) {
          candidateCount += 1;
          const score = computeScore(queryVec, decodeVector(row.vec_values), metric);

          if (best.length < topK) {
            best.push({ id: row.id, score, metadataRaw: row.metadata });
            if (best.length === topK) {
              minIdx = 0;
              for (let i = 1; i < best.length; i++) {
                if (best[i].score < best[minIdx].score) minIdx = i;
              }
            }
            continue;
          }

          if (score > best[minIdx].score) {
            best[minIdx] = { id: row.id, score, metadataRaw: row.metadata };
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
            metadata: entry.metadataRaw ? JSON.parse(entry.metadataRaw) : undefined,
          })),
          usage: {
            candidateCount,
            metric,
          },
        };
      },

      /* ---- listVectors ---- */
      async listVectors(
        handle: VectorIndexHandle,
        input?: VectorListInput,
      ): Promise<VectorListResult> {
        const limit = input?.limit ?? 100;
        const cursor = input?.cursor;

        // Cursor encodes offset as a base-10 integer string
        const offset = cursor ? parseInt(cursor, 10) : 0;

        const rows = db
          .prepare(
            `SELECT id, vec_values, metadata FROM vector_entries WHERE index_id = ? ORDER BY rowid ASC LIMIT ? OFFSET ?`,
          )
          .all(handle.externalId, limit + 1, offset) as EntryRow[];

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;

        const totalRow = db
          .prepare(`SELECT COUNT(*) as cnt FROM vector_entries WHERE index_id = ?`)
          .get(handle.externalId) as { cnt: number } | undefined;

        const items = pageRows.map((row) => ({
          id: row.id,
          values: Array.from(decodeVector(row.vec_values)),
          metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
        }));

        return {
          items,
          nextCursor: hasMore ? String(offset + limit) : undefined,
          total: totalRow?.cnt,
        };
      },
    };

    return runtime;
  },
};
