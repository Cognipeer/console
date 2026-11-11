import { createHash, randomBytes } from 'node:crypto';
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
import { FULL_FILTER_OPERATORS } from '../domains/vectorFilter';
import {
  describeHybrid,
  extractVectorText,
  fuseHybridMatches,
  hybridCandidateCount,
  resolveHybridOptions,
  type VectorHybridChannelHit,
} from '../domains/vectorHybrid';
import { toPostgresCondition } from './vectorFilterTranslators';

interface PostgresVectorCredentials {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export type PostgresIndexLayout = 'shared-table' | 'table-per-index';

interface PostgresVectorSettings {
  /** Used by the shared-table layout only. */
  tableName?: string;
  dimensions?: number;
  indexLayout?: PostgresIndexLayout;
  /** Schema of the table-per-index layout. Default 'public'. */
  schema?: string;
  /** Pool size. Default 10, clamped to 1..100. */
  maxConnections?: number;
}

const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_PORT = 5432;

/**
 * Keyword channel expression, shared by the GIN index and the query so the
 * planner can actually use one for the other. 'simple' rather than a language
 * configuration because the column holds chunks in whatever language the
 * corpus is written in, and a wrong stemmer is worse than none.
 */
const TSVECTOR_EXPR = "to_tsvector('simple', coalesce(content, ''))";

type PgPool = {
  connect: () => Promise<PgClient>;
  end: () => Promise<void>;
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
};

type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
};

type PgModule = {
  Pool: new (config: Record<string, unknown>) => PgPool;
};

function buildPoolConfig(credentials: PostgresVectorCredentials): Record<string, unknown> {
  if (credentials.connectionString?.trim()) {
    return { connectionString: credentials.connectionString.trim() };
  }

  const config: Record<string, unknown> = {
    host: credentials.host?.trim() || 'localhost',
    port: credentials.port ?? DEFAULT_PORT,
  };

  if (credentials.database) config.database = credentials.database.trim();
  if (credentials.user) config.user = credentials.user.trim();
  if (credentials.password) config.password = credentials.password;

  return config;
}

const DEFAULT_MAX_CONNECTIONS = 10;
const MAX_CONNECTIONS_LIMIT = 100;
const CONNECTION_TIMEOUT_MS = 10_000;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const MAX_VECTOR_DIMENSION = 16000;
const ID_CHUNK = 1000;
const UPSERT_BATCH = 100;
const CREATE_TABLE_TRIES = 3;

/** A physical table of the table-per-index layout: `v_<slug>_<8 hex>`. */
const INDEX_TABLE_PATTERN = /^v_[a-z0-9_]{0,40}_[0-9a-f]{8}$/;

export function isPostgresIndexTableName(value: unknown): value is string {
  return typeof value === 'string' && INDEX_TABLE_PATTERN.test(value);
}

function indexTableName(name: string): string {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/^_+|_+$/g, '');
  return `v_${slug}_${randomBytes(4).toString('hex')}`;
}

type VectorColumn = { type: 'vector' | 'halfvec'; ann: boolean };

function validDimension(value: unknown): number {
  const dim = Number(value);
  if (!Number.isInteger(dim) || dim < 1 || dim > MAX_VECTOR_DIMENSION) {
    throw new Error(`Vector dimension must be an integer between 1 and ${MAX_VECTOR_DIMENSION}.`);
  }
  return dim;
}

function columnFor(dimension: number): VectorColumn {
  if (dimension <= 2000) return { type: 'vector', ann: true };
  if (dimension <= 4000) return { type: 'halfvec', ann: true };
  return { type: 'vector', ann: false };
}

function opClass(column: VectorColumn, metric: string): string {
  const suffix = metric === 'dot' ? 'ip_ops' : metric === 'euclidean' ? 'l2_ops' : 'cosine_ops';
  return `${column.type}_${suffix}`;
}

function normalizeMetric(metric: unknown): 'cosine' | 'dot' | 'euclidean' {
  return metric === 'dot' || metric === 'euclidean' ? metric : 'cosine';
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- shared pools ---------------------------------------------------------------------------------------------

interface PoolEntry {
  pool: PgPool;
  refs: number;
}

const poolRegistry = new Map<string, PoolEntry>();

function stableStringify(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Test helper: forget every shared pool without ending it. */
export function resetPostgresVectorPoolsForTests(): void {
  poolRegistry.clear();
}

/**
 * One pool per distinct connection config, shared by every runtime built from it and ended when the last of them
 * closes. The managed runtime pool keys runtimes per tenant, so without sharing N tenants would hold N pools.
 */
async function acquirePool(
  config: Record<string, unknown>,
  perIndex: boolean,
  logger?: { warn?: (...args: any[]) => void },
): Promise<{ pool: PgPool; release: () => Promise<void> }> {
  const { Pool } = await import(/* webpackIgnore: true */ 'pg') as unknown as PgModule;
  const key = createHash('sha256').update(stableStringify({ config, perIndex })).digest('hex');
  let entry = poolRegistry.get(key);
  if (!entry) {
    const pool: PgPool = new Pool(config);
    pool.on?.('error', (error: unknown) => {
      logger?.warn?.('PostgreSQL pool error (idle client)', { error: error instanceof Error ? error.message : error });
    });
    if (perIndex) {
      pool.on?.('connect', (client: PgClient) => {
        try {
          // Older pgvector has no such setting: the SET fails and the connection works as before.
          Promise.resolve(client.query('SET hnsw.iterative_scan = relaxed_order')).catch(() => undefined);
        } catch {
          // ignored
        }
      });
    }
    entry = { pool, refs: 0 };
    poolRegistry.set(key, entry);
  }
  entry.refs += 1;
  const held = entry;
  let released = false;
  return {
    pool: held.pool,
    release: async () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      if (poolRegistry.get(key) === held) poolRegistry.delete(key);
      await held.pool.end();
    },
  };
}

function pgMetricOp(metric: string): string {
  if (metric === 'dot') return '<#>';
  if (metric === 'euclidean') return '<->';
  return '<=>';  // cosine
}

/**
 * SQL expression turning a pgvector operator result into a similarity score
 * (higher = more similar), which is what `VectorQueryMatch.score` must be.
 * Each operator returns something different: `<=>` cosine distance, `<->` L2
 * distance, and `<#>` the NEGATIVE inner product.
 */
function toChannelHit(row: Record<string, unknown>): VectorHybridChannelHit {
  return {
    id: row.id as string,
    score: parseFloat(row.score as string),
    metadata: row.metadata as Record<string, unknown> | undefined,
  };
}

function pgScoreExpr(metric: string, op: string, tbl: string, cast = 'vector'): string {
  if (metric === 'dot') return `-(${tbl}.vector ${op} $1::${cast})`;
  if (metric === 'euclidean') return `1 / (1 + (${tbl}.vector ${op} $1::${cast}))`;
  return `1 - (${tbl}.vector ${op} $1::${cast})`;
}

function parseVectorText(value: unknown): number[] {
  // pgvector returns vector as "[1,2,3]" string
  if (typeof value !== 'string') return [];
  try { return JSON.parse(value) as number[]; } catch { return []; }
}

interface TablePerIndexOptions {
  pool: PgPool;
  release: () => Promise<void>;
  schema: string;
  dimensions: number;
  providerKey?: string;
  logger?: { debug?: (...a: any[]) => void; info?: (...a: any[]) => void; warn?: (...a: any[]) => void };
}

function createTablePerIndexRuntime(opts: TablePerIndexOptions): VectorProviderRuntime {
  const { pool, release, schema, dimensions, providerKey, logger } = opts;
  const qualified = (table: string): string => `"${schema}"."${table}"`;

  async function withClient<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let discard = false;
    try {
      return await fn(client);
    } catch (error) {
      discard = (error as { __discardClient?: boolean } | null)?.__discardClient === true;
      throw error;
    } finally {
      // A client whose ROLLBACK failed may be dead or aborted: have the pool drop it.
      (client.release as (err?: boolean) => void)(discard ? true : undefined);
    }
  }

  async function inTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
    return withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          if (error && typeof error === 'object') {
            try { Object.defineProperty(error, '__discardClient', { value: true, configurable: true }); } catch { /* frozen */ }
          }
        }
        throw error;
      }
    });
  }

  /** The table comes from the handle's externalId only, never from its metadata. */
  function resolve(handle: VectorIndexHandle): { tbl: string; column: VectorColumn; metric: 'cosine' | 'dot' | 'euclidean' } {
    if (!isPostgresIndexTableName(handle?.externalId)) throw new Error('Invalid PostgreSQL index identifier.');
    return {
      tbl: qualified(handle.externalId),
      column: columnFor(validDimension(handle.dimension)),
      metric: normalizeMetric(handle.metric),
    };
  }

  function ignoreExisting(error: unknown, codes: string[]): void {
    const code = (error as { code?: string } | null)?.code;
    if (!code || !codes.includes(code)) throw error;
  }

  return {
    async close(): Promise<void> {
      await release();
    },

    async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
      const dim = validDimension(input.dimension || dimensions);
      const metric = normalizeMetric(input.metric);
      const column = columnFor(dim);
      if (!column.ann) {
        logger?.warn?.('PostgreSQL vector dimension is above the index limit; queries scan exactly', { providerKey, dimension: dim });
      }
      const comment = JSON.stringify({ name: input.name, metric });
      // A table name is never taken from, or handed back through, metadata in this layout.
      const { tableName: _ignored, ...rest } = input.metadata ?? {};
      void _ignored;

      await withClient(async (client) => {
        try {
          await client.query('CREATE EXTENSION IF NOT EXISTS vector');
        } catch (error) {
          ignoreExisting(error, ['23505', '42710']);
        }
        // CREATE SCHEMA IF NOT EXISTS still needs CREATE on the database, so only run it for a missing schema.
        const existing = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
        if (!existing?.rows?.length) {
          try {
            await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
          } catch (error) {
            ignoreExisting(error, ['42P06', '23505']);
          }
        }
      });

      for (let attempt = 1; attempt <= CREATE_TABLE_TRIES; attempt += 1) {
        const table = indexTableName(input.name);
        const tbl = qualified(table);
        try {
          await inTransaction(async (client) => {
            await client.query(
              `CREATE TABLE ${tbl} (
                id TEXT PRIMARY KEY,
                vector ${column.type}(${dim}),
                metadata JSONB NOT NULL DEFAULT '{}',
                content TEXT
              )`,
            );
            if (column.ann) {
              await client.query(
                `CREATE INDEX "${table}_hnsw" ON ${tbl} USING hnsw (vector ${opClass(column, metric)})`,
              );
            }
            await client.query(`CREATE INDEX "${table}_fts" ON ${tbl} USING GIN (${TSVECTOR_EXPR})`);
            const statement = await client.query(
              "SELECT format('COMMENT ON TABLE %I.%I IS %L', $1::text, $2::text, $3::text) AS statement",
              [schema, table, comment],
            );
            await client.query(statement.rows[0].statement as string);
          });
        } catch (error) {
          if ((error as { code?: string } | null)?.code === '42P07' && attempt < CREATE_TABLE_TRIES) continue;
          throw error;
        }

        logger?.info?.('PostgreSQL vector table created', { providerKey, tableName: table });
        return {
          externalId: table,
          name: input.name,
          dimension: dim,
          metric,
          metadata: { ...rest, provider: 'postgres' },
        };
      }
      throw new Error('Could not allocate a PostgreSQL index table.');
    },

    async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
      if (!isPostgresIndexTableName(externalId)) throw new Error('Invalid PostgreSQL index identifier.');
      await withClient(async (client) => {
        await client.query(`DROP TABLE IF EXISTS ${qualified(externalId)}`);
      });
      logger?.info?.('PostgreSQL vector table dropped', { providerKey, externalId });
    },

    async listIndexes(): Promise<VectorIndexHandle[]> {
      const rows = await withClient(async (client) => {
        const result = await client.query(
          `SELECT c.relname AS table_name,
                  (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'vector' AND NOT a.attisdropped) AS vector_type,
                  obj_description(c.oid, 'pg_class') AS comment
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname ~ $2
            ORDER BY c.relname`,
          [schema, INDEX_TABLE_PATTERN.source],
        );
        return result.rows;
      });

      const handles: VectorIndexHandle[] = [];
      for (const row of rows) {
        const table = row.table_name;
        if (!isPostgresIndexTableName(table)) continue;
        const dimMatch = /^(?:vector|halfvec)\((\d+)\)$/.exec(String(row.vector_type ?? ''));
        let name = table;
        let metric: 'cosine' | 'dot' | 'euclidean' = 'cosine';
        if (typeof row.comment === 'string') {
          try {
            const parsed = JSON.parse(row.comment) as { name?: unknown; metric?: unknown };
            if (typeof parsed.name === 'string' && parsed.name) name = parsed.name;
            metric = normalizeMetric(parsed.metric);
          } catch { /* fall back to the table name */ }
        }
        handles.push({
          externalId: table,
          name,
          dimension: dimMatch ? Number(dimMatch[1]) : dimensions,
          metric,
          metadata: { provider: 'postgres' },
        });
      }
      return handles;
    },

    async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
      const { tbl, column } = resolve(handle);
      // One statement must not touch a row twice: the last occurrence of an id wins.
      const unique = [...new Map(items.map((item) => [item.id, item] as const)).values()];
      if (unique.length === 0) return;

      await inTransaction(async (client) => {
        for (const batch of chunk(unique, UPSERT_BATCH)) {
          const params: unknown[] = [];
          const rows = batch.map((item, i) => {
            const base = i * 4;
            params.push(
              item.id,
              `[${item.values.join(',')}]`,
              JSON.stringify(item.metadata ?? {}),
              extractVectorText(item.metadata) ?? '',
            );
            return `($${base + 1}, $${base + 2}::${column.type}, $${base + 3}::jsonb, $${base + 4})`;
          });
          await client.query(
            `INSERT INTO ${tbl} (id, vector, metadata, content)
             VALUES ${rows.join(', ')}
             ON CONFLICT (id) DO UPDATE SET vector = EXCLUDED.vector,
               metadata = EXCLUDED.metadata, content = EXCLUDED.content`,
            params,
          );
        }
      });

      logger?.debug?.('PostgreSQL upserted vectors', { providerKey, count: unique.length });
    },

    async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
      const { tbl, column, metric } = resolve(handle);
      const op = pgMetricOp(metric);
      const vectorStr = `[${query.vector.join(',')}]`;
      const text = query.text?.trim();
      const limit = text ? hybridCandidateCount(query.topK) : query.topK;

      const params: unknown[] = [vectorStr];
      let whereClause = '';
      if (query.filter) {
        const fragment = toPostgresCondition(query.filter, 'metadata', params.length + 1);
        whereClause = ` WHERE ${fragment.sql}`;
        params.push(...fragment.params);
      }
      params.push(limit);
      const limitPlaceholder = `$${params.length}`;

      const denseSql = `SELECT id, metadata, ${pgScoreExpr(metric, op, tbl, column.type)} AS score
           FROM ${tbl}${whereClause}
           ORDER BY vector ${op} $1::${column.type}
           LIMIT ${limitPlaceholder}`;

      // Iterative index scans may hand rows back in a relaxed order.
      const byScore = (rows: Record<string, unknown>[]) =>
        rows.map(toChannelHit).sort((a, b) => b.score - a.score);

      if (!text) {
        const rows = await withClient(async (client) => (await client.query(denseSql, params)).rows);
        return { matches: byScore(rows) };
      }

      const lexParams: unknown[] = [text];
      let lexWhere = '';
      if (query.filter) {
        const fragment = toPostgresCondition(query.filter, 'metadata', lexParams.length + 1);
        lexWhere = ` AND ${fragment.sql}`;
        lexParams.push(...fragment.params);
      }
      lexParams.push(limit);
      const lexLimitPlaceholder = `$${lexParams.length}`;

      const lexicalSql = `SELECT id, metadata, ts_rank_cd(${TSVECTOR_EXPR}, q) AS score
           FROM ${tbl}, websearch_to_tsquery('simple', $1) q
           WHERE ${TSVECTOR_EXPR} @@ q${lexWhere}
           ORDER BY score DESC
           LIMIT ${lexLimitPlaceholder}`;

      const [denseRows, lexicalRows] = await withClient(async (client) => {
        const dense = await client.query(denseSql, params);
        const lexical = await client.query(lexicalSql, lexParams);
        return [dense.rows, lexical.rows];
      });

      return {
        matches: fuseHybridMatches({
          dense: byScore(denseRows),
          lexical: lexicalRows.map(toChannelHit),
          topK: query.topK,
          options: query.hybrid,
        }),
        usage: describeHybrid({ ran: true, mode: resolveHybridOptions(query.hybrid).mode }),
      };
    },

    async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      const { tbl } = resolve(handle);
      await withClient(async (client) => {
        for (const part of chunk(ids, ID_CHUNK)) {
          await client.query(`DELETE FROM ${tbl} WHERE id = ANY($1::text[])`, [part]);
        }
      });
      logger?.debug?.('PostgreSQL deleted vectors', { providerKey, count: ids.length });
    },

    async existingVectorIds(handle: VectorIndexHandle, ids: string[]): Promise<string[]> {
      const { tbl } = resolve(handle);
      const found: string[] = [];
      await withClient(async (client) => {
        for (const part of chunk(ids, ID_CHUNK)) {
          const result = await client.query(`SELECT id FROM ${tbl} WHERE id = ANY($1::text[])`, [part]);
          for (const row of result.rows) found.push(row.id as string);
        }
      });
      return found;
    },

    async existingVectors(handle: VectorIndexHandle, ids: string[]) {
      const { tbl } = resolve(handle);
      const found: Array<{ id: string; metadata?: Record<string, unknown> }> = [];
      await withClient(async (client) => {
        for (const part of chunk(ids, ID_CHUNK)) {
          const result = await client.query(`SELECT id, metadata FROM ${tbl} WHERE id = ANY($1::text[])`, [part]);
          for (const row of result.rows) {
            found.push({ id: row.id as string, metadata: row.metadata as Record<string, unknown> | undefined });
          }
        }
      });
      return found;
    },

    async listVectors(handle: VectorIndexHandle, input?: VectorListInput): Promise<VectorListResult> {
      const { tbl } = resolve(handle);
      const limit = input?.limit ?? 100;
      const offset = input?.cursor ? parseInt(input.cursor, 10) : 0;

      const [rows, countRows] = await withClient(async (client) => {
        const dataRes = await client.query(
          `SELECT id, vector::text, metadata FROM ${tbl} ORDER BY id LIMIT $1 OFFSET $2`,
          [limit, offset],
        );
        const cntRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM ${tbl}`);
        return [dataRes.rows, cntRes.rows];
      });

      const total: number | undefined = countRows[0]?.cnt != null ? Number(countRows[0].cnt) : undefined;
      const items = rows.map((row) => ({
        id: row.id as string,
        values: parseVectorText(row.vector),
        metadata: row.metadata as Record<string, unknown> | undefined,
      }));
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor: total !== undefined && nextOffset < total ? String(nextOffset) : items.length === limit ? String(nextOffset) : undefined,
        total,
      };
    },
  };
}

export const PostgresVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  PostgresVectorCredentials,
  PostgresVectorSettings
> = {
  id: 'postgres',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'PostgreSQL (pgvector)',
    description:
      'PostgreSQL with the pgvector extension for vector similarity search.',
  },
  form: {
    sections: [
      {
        title: 'Connection',
        description: 'Provide either a connection string or individual host/port/database fields.',
        fields: [
          {
            name: 'connectionString',
            label: 'Connection String',
            type: 'password',
            required: false,
            placeholder: 'postgresql://user:pass@localhost:5432/mydb',
            description: 'PostgreSQL connection string. Overrides individual host/port fields when set.',
            scope: 'credentials',
          },
          {
            name: 'host',
            label: 'Host',
            type: 'text',
            required: false,
            placeholder: 'localhost',
            scope: 'settings',
          },
          {
            name: 'port',
            label: 'Port',
            type: 'number',
            required: false,
            placeholder: '5432',
            scope: 'settings',
          },
          {
            name: 'database',
            label: 'Database',
            type: 'text',
            required: false,
            scope: 'settings',
          },
          {
            name: 'user',
            label: 'User',
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
        title: 'Table Settings',
        fields: [
          {
            name: 'tableName',
            label: 'Table Name',
            type: 'text',
            required: false,
            placeholder: 'vectors',
            description: 'PostgreSQL table used to store vector embeddings. Used by the shared-table layout (required there).',
            scope: 'settings',
          },
          {
            name: 'indexLayout',
            label: 'Index Layout',
            type: 'select',
            required: false,
            defaultValue: 'shared-table',
            options: [
              { label: 'Shared table (one table for all indexes)', value: 'shared-table' },
              { label: 'Table per index (HNSW index, own table)', value: 'table-per-index' },
            ],
            description: 'How logical indexes map to tables.',
            scope: 'settings',
          },
          {
            name: 'schema',
            label: 'Schema',
            type: 'text',
            required: false,
            placeholder: 'public',
            description: 'Schema that holds the tables of the table-per-index layout. Lowercase letters, digits and underscores.',
            scope: 'settings',
          },
          {
            name: 'maxConnections',
            label: 'Max Connections',
            type: 'number',
            required: false,
            placeholder: '10',
            description: 'Maximum connections in the pool (1 to 100).',
            scope: 'settings',
          },
          {
            name: 'dimensions',
            label: 'Dimensions',
            type: 'number',
            required: false,
            placeholder: '1536',
            description: 'Embedding vector dimensions. Used when creating the table.',
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
    'vector.filterOperators': FULL_FILTER_OPERATORS,
    'vector.supportsHybrid': true,
  },
  async createRuntime({ credentials, settings, providerKey, logger }) {
    const layout = settings?.indexLayout ?? 'shared-table';
    if (layout !== 'shared-table' && layout !== 'table-per-index') {
      throw new Error('PostgreSQL index layout must be "shared-table" or "table-per-index".');
    }
    const perIndex = layout === 'table-per-index';
    if (!perIndex && !settings?.tableName?.trim()) {
      throw new Error('PostgreSQL table name is required.');
    }
    const schema = settings?.schema?.trim() || 'public';
    if (perIndex && !SCHEMA_PATTERN.test(schema)) {
      throw new Error('PostgreSQL schema must be lowercase letters, digits and underscores.');
    }

    const hasConnectionString = !!credentials?.connectionString?.trim();
    const hasHostConfig = !!credentials?.host?.trim();

    if (!hasConnectionString && !hasHostConfig) {
      throw new Error(
        'PostgreSQL requires either a connection string or a host setting.',
      );
    }

    const requestedMax = Number(settings?.maxConnections);
    const max = Number.isFinite(requestedMax) && requestedMax >= 1
      ? Math.min(MAX_CONNECTIONS_LIMIT, Math.floor(requestedMax))
      : DEFAULT_MAX_CONNECTIONS;
    const poolConfig: Record<string, unknown> = {
      ...buildPoolConfig(credentials),
      max,
      ...(perIndex ? { connectionTimeoutMillis: CONNECTION_TIMEOUT_MS } : {}),
    };
    const { pool, release } = await acquirePool(poolConfig, perIndex, logger);
    const dimensions = Number(settings?.dimensions) > 0 ? Number(settings?.dimensions) : DEFAULT_DIMENSIONS;

    if (perIndex) {
      return createTablePerIndexRuntime({ pool, release, schema, dimensions, providerKey, logger });
    }
    const tableName = (settings.tableName as string).trim();

    async function withClient<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    }

    // The searchable text column arrived with hybrid search, so every table
    // created before it lacks one. The migration is idempotent and cheap, but
    // it needs DDL rights this connection may not have — so the answer is
    // remembered either way: a restricted deployment keeps ingesting and
    // querying without hybrid instead of re-attempting an ALTER on every write.
    const contentColumn = new Map<string, Promise<boolean>>();

    function ensureContentColumn(tbl: string): Promise<boolean> {
      const pending = contentColumn.get(tbl);
      if (pending) return pending;

      const promise = withClient(async (client) => {
        await client.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS content TEXT`);
        await client.query(
          `CREATE INDEX IF NOT EXISTS ${tbl.replace(/\W/g, '_')}_content_fts
           ON ${tbl} USING GIN (${TSVECTOR_EXPR})`,
        );
        return true;
      }).catch((error: unknown) => {
        logger?.warn?.('PostgreSQL keyword column unavailable; hybrid search stays off', {
          providerKey,
          tableName: tbl,
          error: error instanceof Error ? error.message : error,
        });
        return false;
      });

      contentColumn.set(tbl, promise);
      return promise;
    }

    const runtime: VectorProviderRuntime = {
      async close(): Promise<void> {
        await release();
      },
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const dim = input.dimension || dimensions;
        const metric = input.metric ?? 'cosine';

        await withClient(async (client) => {
          await client.query('CREATE EXTENSION IF NOT EXISTS vector');
          await client.query(
            `CREATE TABLE IF NOT EXISTS ${tableName} (
              id TEXT PRIMARY KEY,
              vector vector(${dim}),
              metadata JSONB DEFAULT '{}',
              content TEXT
            )`,
          );
        });

        // CREATE TABLE IF NOT EXISTS never alters an existing table, so a
        // pre-hybrid table still needs the column and its index adding.
        await ensureContentColumn(tableName);

        logger?.info?.('PostgreSQL vector table ensured', { providerKey, tableName });

        return {
          externalId: tableName,
          name: input.name || tableName,
          dimension: dim,
          metric,
          metadata: { ...input.metadata, tableName, provider: 'postgres' },
        };
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        await withClient(async (client) => {
          await client.query(`DROP TABLE IF EXISTS ${externalId} CASCADE`);
        });
        logger?.info?.('PostgreSQL vector table dropped', { providerKey, externalId });
      },

      async listIndexes(): Promise<VectorIndexHandle[]> {
        const rows = await withClient(async (client) => {
          const result = await client.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = $1`,
            [tableName],
          );
          return result.rows;
        });

        if (rows.length === 0) return [];
        return [
          {
            externalId: tableName,
            name: tableName,
            dimension: dimensions,
            metric: 'cosine',
            metadata: { tableName, provider: 'postgres' },
          },
        ];
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        const tbl = (handle.metadata?.tableName as string) || tableName;
        const hasContent = await ensureContentColumn(tbl);

        const sql = hasContent
          ? `INSERT INTO ${tbl} (id, vector, metadata, content)
             VALUES ($1, $2::vector, $3::jsonb, $4)
             ON CONFLICT (id) DO UPDATE SET vector = EXCLUDED.vector,
               metadata = EXCLUDED.metadata, content = EXCLUDED.content`
          : `INSERT INTO ${tbl} (id, vector, metadata)
             VALUES ($1, $2::vector, $3::jsonb)
             ON CONFLICT (id) DO UPDATE SET vector = EXCLUDED.vector, metadata = EXCLUDED.metadata`;

        await withClient(async (client) => {
          for (const item of items) {
            const vectorStr = `[${item.values.join(',')}]`;
            const params: unknown[] = [item.id, vectorStr, JSON.stringify(item.metadata ?? {})];
            if (hasContent) params.push(extractVectorText(item.metadata) ?? '');
            await client.query(sql, params);
          }
        });

        logger?.debug?.('PostgreSQL upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const tbl = (handle.metadata?.tableName as string) || tableName;
        const op = pgMetricOp(handle.metric);
        const vectorStr = `[${query.vector.join(',')}]`;

        const text = query.text?.trim();
        const fused = Boolean(text) && await ensureContentColumn(tbl);
        const limit = fused ? hybridCandidateCount(query.topK) : query.topK;

        // Filter in SQL so the ORDER BY/LIMIT runs over matching rows only.
        const params: unknown[] = [vectorStr];
        let whereClause = '';
        if (query.filter) {
          const fragment = toPostgresCondition(query.filter, 'metadata', params.length + 1);
          whereClause = ` WHERE ${fragment.sql}`;
          params.push(...fragment.params);
        }
        params.push(limit);
        const limitPlaceholder = `$${params.length}`;

        const denseSql = `SELECT id, metadata, ${pgScoreExpr(handle.metric, op, tbl)} AS score
             FROM ${tbl}${whereClause}
             ORDER BY vector ${op} $1::vector
             LIMIT ${limitPlaceholder}`;

        if (!fused) {
          const rows = await withClient(async (client) => {
            const result = await client.query(denseSql, params);
            return result.rows;
          });

          const matches = rows.map(toChannelHit);
          // The caller asked for keywords and the table has no column to match
          // them against — say so rather than pass dense results off as fused.
          return text
            ? { matches, usage: describeHybrid({ ran: false, reason: 'index-schema' }) }
            : { matches };
        }

        const lexParams: unknown[] = [text];
        let lexWhere = '';
        if (query.filter) {
          const fragment = toPostgresCondition(query.filter, 'metadata', lexParams.length + 1);
          lexWhere = ` AND ${fragment.sql}`;
          lexParams.push(...fragment.params);
        }
        lexParams.push(limit);
        const lexLimitPlaceholder = `$${lexParams.length}`;

        const lexicalSql = `SELECT id, metadata, ts_rank_cd(${TSVECTOR_EXPR}, q) AS score
             FROM ${tbl}, websearch_to_tsquery('simple', $1) q
             WHERE ${TSVECTOR_EXPR} @@ q${lexWhere}
             ORDER BY score DESC
             LIMIT ${lexLimitPlaceholder}`;

        // Two statements over one connection rather than a single fused query:
        // joining the channels in SQL takes window functions that defeat the
        // pgvector top-k index scan, and it would put a second copy of the
        // score-scale correction somewhere it cannot be tested.
        const [denseRows, lexicalRows] = await withClient(async (client) => {
          const dense = await client.query(denseSql, params);
          const lexical = await client.query(lexicalSql, lexParams);
          return [dense.rows, lexical.rows];
        });

        return {
          matches: fuseHybridMatches({
            dense: denseRows.map(toChannelHit),
            lexical: lexicalRows.map(toChannelHit),
            topK: query.topK,
            options: query.hybrid,
          }),
          usage: describeHybrid({ ran: true, mode: resolveHybridOptions(query.hybrid).mode }),
        };
      },

      async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        const tbl = (handle.metadata?.tableName as string) || tableName;
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');

        await withClient(async (client) => {
          await client.query(`DELETE FROM ${tbl} WHERE id IN (${placeholders})`, ids);
        });

        logger?.debug?.('PostgreSQL deleted vectors', { providerKey, count: ids.length });
      },

      async existingVectorIds(handle: VectorIndexHandle, ids: string[]): Promise<string[]> {
        const tbl = (handle.metadata?.tableName as string) || tableName;
        const found: string[] = [];
        await withClient(async (client) => {
          for (const part of chunk(ids, ID_CHUNK)) {
            const result = await client.query(`SELECT id FROM ${tbl} WHERE id = ANY($1::text[])`, [part]);
            for (const row of result.rows) found.push(row.id as string);
          }
        });
        return found;
      },

      async existingVectors(handle: VectorIndexHandle, ids: string[]): Promise<Array<{ id: string; metadata?: Record<string, unknown> }>> {
        const tbl = (handle.metadata?.tableName as string) || tableName;
        const found: Array<{ id: string; metadata?: Record<string, unknown> }> = [];
        await withClient(async (client) => {
          for (const part of chunk(ids, ID_CHUNK)) {
            const result = await client.query(`SELECT id, metadata FROM ${tbl} WHERE id = ANY($1::text[])`, [part]);
            for (const row of result.rows) {
              found.push({ id: row.id as string, metadata: row.metadata as Record<string, unknown> | undefined });
            }
          }
        });
        return found;
      },

      async listVectors(handle: VectorIndexHandle, input?: VectorListInput): Promise<VectorListResult> {
        const tbl = (handle.metadata?.tableName as string) || tableName;
        const limit = input?.limit ?? 100;
        const offset = input?.cursor ? parseInt(input.cursor, 10) : 0;

        const [rows, countRows] = await withClient(async (client) => {
          const dataRes = await client.query(
            `SELECT id, vector::text, metadata FROM ${tbl} ORDER BY id LIMIT $1 OFFSET $2`,
            [limit, offset],
          );
          const cntRes = await client.query(`SELECT COUNT(*)::int AS cnt FROM ${tbl}`);
          return [dataRes.rows, cntRes.rows];
        });

        const total: number | undefined = countRows[0]?.cnt != null ? Number(countRows[0].cnt) : undefined;
        const items = (rows as Record<string, unknown>[]).map((row) => {
          // pgvector returns vector as "[1,2,3]" string
          let values: number[] = [];
          if (typeof row.vector === 'string') {
            try { values = JSON.parse(row.vector as string) as number[]; } catch { /* ignore */ }
          }
          return {
            id: row.id as string,
            values,
            metadata: row.metadata as Record<string, unknown> | undefined,
          };
        });

        const nextOffset = offset + items.length;
        return {
          items,
          nextCursor: total !== undefined && nextOffset < total ? String(nextOffset) : items.length === limit ? String(nextOffset) : undefined,
          total,
        };
      },
    };

    return runtime;
  },
};
