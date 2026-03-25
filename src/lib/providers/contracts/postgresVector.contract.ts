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

interface PostgresVectorCredentials {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

interface PostgresVectorSettings {
  tableName: string;
  dimensions?: number;
}

const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_PORT = 5432;

type PgPool = {
  connect: () => Promise<PgClient>;
  end: () => Promise<void>;
};

type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
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

function pgMetricOp(metric: string): string {
  if (metric === 'dot') return '<#>';
  if (metric === 'euclidean') return '<->';
  return '<=>';  // cosine
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
            required: true,
            placeholder: 'vectors',
            description: 'PostgreSQL table used to store vector embeddings.',
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
  },
  async createRuntime({ credentials, settings, providerKey, logger }) {
    if (!settings?.tableName?.trim()) {
      throw new Error('PostgreSQL table name is required.');
    }

    const hasConnectionString = !!credentials?.connectionString?.trim();
    const hasHostConfig = !!credentials?.host?.trim();

    if (!hasConnectionString && !hasHostConfig) {
      throw new Error(
        'PostgreSQL requires either a connection string or a host setting.',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-ts-comment
    // @ts-ignore – pg is an optional peer dependency
    const { Pool } = await import('pg') as any;
    const pool: PgPool = new Pool(buildPoolConfig(credentials));
    const tableName = settings.tableName.trim();
    const dimensions = Number(settings.dimensions) > 0 ? Number(settings.dimensions) : DEFAULT_DIMENSIONS;

    async function withClient<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    }

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const dim = input.dimension || dimensions;
        const metric = input.metric ?? 'cosine';

        await withClient(async (client) => {
          await client.query('CREATE EXTENSION IF NOT EXISTS vector');
          await client.query(
            `CREATE TABLE IF NOT EXISTS ${tableName} (
              id TEXT PRIMARY KEY,
              vector vector(${dim}),
              metadata JSONB DEFAULT '{}'
            )`,
          );
        });

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

        await withClient(async (client) => {
          for (const item of items) {
            const vectorStr = `[${item.values.join(',')}]`;
            await client.query(
              `INSERT INTO ${tbl} (id, vector, metadata)
               VALUES ($1, $2::vector, $3::jsonb)
               ON CONFLICT (id) DO UPDATE SET vector = EXCLUDED.vector, metadata = EXCLUDED.metadata`,
              [item.id, vectorStr, JSON.stringify(item.metadata ?? {})],
            );
          }
        });

        logger?.debug?.('PostgreSQL upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const tbl = (handle.metadata?.tableName as string) || tableName;
        const op = pgMetricOp(handle.metric);
        const vectorStr = `[${query.vector.join(',')}]`;

        const rows = await withClient(async (client) => {
          const result = await client.query(
            `SELECT id, metadata, 1 - (vector ${op} $1::vector) AS score
             FROM ${tbl}
             ORDER BY vector ${op} $1::vector
             LIMIT $2`,
            [vectorStr, query.topK],
          );
          return result.rows;
        });

        return {
          matches: rows.map((row) => ({
            id: row.id as string,
            score: parseFloat(row.score as string),
            metadata: row.metadata as Record<string, unknown> | undefined,
          })),
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

    // Expose pool teardown so the runtime pool can clean up connections.
    (runtime as unknown as Record<string, unknown>).__pool = pool;

    return runtime;
  },
};
