# Vector Stores

The vector store service provides multi-provider vector database management with index CRUD, vector upsert/query/delete operations, and runtime pooling.

## Supported Providers

Providers are registered through the contract system:

| Provider | ID | Description |
|----------|-----|-------------|
| **SQLite Vector** | `sqlite-vector` | Local brute-force similarity search using SQLite. No external dependencies. |
| Pinecone | `pinecone` | Managed vector database |
| Qdrant | `qdrant` | Open-source vector database |
| AWS S3 Vectors | `aws-s3-vectors` | S3-based vector storage |

Additional providers can be added via the provider contract mechanism.

### SQLite Vector Provider

The built-in SQLite vector provider stores embeddings locally with brute-force cosine/dot/euclidean similarity search. Ideal for development, small-scale deployments, or environments without external vector database access.

```bash
# No extra configuration needed — just create a provider via API or UI
# with driver: "sqlite-vector" and settings.basePath: "./data/vectors"
```

**Capabilities:**
- Cosine, dot-product, and euclidean similarity metrics
- Upsert with conflict resolution
- Batch vector operations within transactions
- Per-tenant, per-provider isolated SQLite files

**Limitations:**
- Brute-force search (scans all vectors per query) — suitable for up to ~100K vectors per index
- No metadata filtering (planned)

## Service Layer

The vector service (`src/lib/services/vector/vectorService.ts`) provides tenant-scoped operations:

| Function | Description |
|----------|-------------|
| `listVectorDrivers()` | List available vector provider drivers |
| `listVectorProviders()` | List tenant's configured providers |
| `createVectorProvider()` | Create a provider configuration |
| `createVectorIndex()` | Create an index with unique key |
| `listVectorIndexes()` | List indexes for a provider |
| `getVectorIndex()` | Get index with metadata |
| `updateVectorIndex()` | Update index name/metadata |
| `deleteVectorIndex()` | Delete index and remote resources |
| `upsertVectors()` | Upsert vectors to an index |
| `deleteVectors()` | Delete vectors by IDs |
| `queryVectorIndex()` | Similarity search |

## API Endpoints

### List Providers

```
GET /api/client/v1/vector/providers
Authorization: Bearer <token>
```

Optional query parameters: `status`, `driver`

### Create Provider

```
POST /api/client/v1/vector/providers
Authorization: Bearer <token>
```

```json
{
  "driver": "pinecone",
  "name": "Production Vectors",
  "credentials": { "apiKey": "pk-..." },
  "settings": { "environment": "gcp-starter" }
}
```

### Create Index

```
POST /api/client/v1/vector/providers/:providerKey/indexes
Authorization: Bearer <token>
```

```json
{
  "name": "Product Embeddings",
  "dimension": 1536,
  "metric": "cosine"
}
```

Index names are deduplicated — if an index with the same normalized name exists, it is reused.

### Query Vectors

```
POST /api/client/v1/vector/providers/:providerKey/indexes/:externalId/query
```

```json
{
  "vector": [0.1, 0.2, ...],
  "topK": 10,
  "filter": { "category": "electronics" }
}
```

## Key Generation

Each index gets a unique key derived from its name:

```
"Product Embeddings" → "product-embeddings"
"Product Embeddings" (duplicate) → "product-embeddings-1"
```

The `generateUniqueIndexKey()` helper ensures uniqueness within a tenant.

## Runtime Context

Building a runtime from stored configuration:

```typescript
const { runtime, index } = await buildRuntimeContext(tenantDbName, providerKey);

// The runtime is cached in runtimePool
// Credentials are decrypted and validated
// Provider status is checked (must be 'active')
```

## Vector Provider Runtime Interface

```typescript
interface VectorProviderRuntime {
  createIndex(params: CreateIndexParams): Promise<IndexInfo>;
  listIndexes(): Promise<IndexInfo[]>;
  describeIndex(name: string): Promise<IndexInfo>;
  deleteIndex(name: string): Promise<void>;
  upsertVectors(index: string, vectors: VectorRecord[]): Promise<void>;
  queryVectors(index: string, vector: number[], options: QueryOptions): Promise<QueryResult[]>;
  deleteVectors(index: string, ids: string[]): Promise<void>;
}
```

## Validation

- Vector dimension is validated before upsert operations
- Provider type and status are checked before any runtime operation
- Credentials are validated during runtime construction
