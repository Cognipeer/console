# Vector Stores

The vector store service provides multi-provider vector database management with index CRUD, vector upsert/query/delete operations, and runtime pooling. Operators manage it through **Data → Knowledge Index**.

## Knowledge Index

The list view groups indices by their vector provider. Counters at the top show how many indices are deployed, how many providers are wired up, and how many providers are currently failing health checks.

![Knowledge Index list](/screenshots/vector-stores/01-vector-list.png)

A fresh tenant lands on the empty state — the **Create index** action only enables once at least one vector-domain provider has been registered. The **Indexes** and **Migrations** entries in the left sidebar give you flat list views; **Migrations** is where you reshape indices when you change embedding dimensions or rename keys.

## Supported Providers

Providers are registered through the contract system:

| Provider | ID | Description |
|----------|-----|-------------|
| **SQLite Vector** | `sqlite-vector` | Local brute-force similarity search using SQLite. No external dependencies. |
| Postgres | `postgres` | Postgres/pgvector-backed vector storage |
| Azure AI Search | `azure-ai-search` | Managed vector search on Azure AI Search |
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
  "driver": "postgres",
  "name": "Production Vectors",
  "credentials": { "connectionString": "postgres://..." },
  "settings": { "schema": "public" }
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

## Metadata Filtering

Queries can narrow candidates by chunk metadata using one provider-neutral filter
language. The gateway parses and validates the filter once, then each driver
translates it into its store's native syntax and pushes it down.

**Filters are never applied after the query.** A driver that cannot express an
operator rejects the request with a `400` naming what is unsupported, instead of
returning results that quietly ignore the filter. That way `topK` always means
"topK matching documents".

### Filter language

```jsonc
{ "source": "crawler" }                       // shorthand for $eq
{ "depth": { "$lte": 2 }, "lang": "tr" }      // several fields are ANDed
{ "lang": { "$in": ["tr", "en"] } }
{ "draft": { "$exists": false } }
{ "$or": [{ "source": "crawler" }, { "$not": { "depth": { "$gt": 5 } } }] }
{ "$raw": { "term": { "metadata.source": "crawler" } } }  // provider-native escape hatch
```

Field operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`,
`$exists`. Composition: `$and`, `$or`, `$not`. `$raw` replaces the entire filter
and cannot be combined with other keys.

### Provider support

| Driver | Push-down | Notes |
| --- | --- | --- |
| `elasticsearch`, `elasticsearch-cloud`, `elasticsearch-self-hosted` | full | Exact matches target the `.keyword` sub-field. |
| `postgres` | full | Parameterised `jsonb` predicates in the same `SELECT`. |
| `sqlite-vector` | full | Evaluated during the scan, before top-K selection. |
| `mongodb-community-vector` | full | Applied as part of the scan query. |
| `milvus`, `milvus-cloud`, `milvus-local` | full | Requires a collection created with the JSON metadata column (see below). |
| `mongodb` (Atlas) | no `$exists` | Filtered paths must be declared in the Atlas vector index. |
| `aws-s3-vectors`, `system-default` | no `$not` | Metadata keys must be filterable in the index. |
| `chroma`, `chroma-cloud`, `chroma-local` | no `$not`, no `$exists` | Chroma `where` has no equivalent. |
| `azure-ai-search` | equality family only | `$eq`, `$ne`, `$in`, `$nin`, `$exists`; range operators are not expressible (see below). |
| `orama` | none | Metadata is stored as an opaque JSON string; filtered queries are rejected. |

Every driver except `orama` also accepts `$raw`.

### Index schema requirements

Two stores need an index created by a current version of the console before
filters can be pushed down; older ones keep serving unfiltered queries and reject
filtered ones with an actionable error:

- **Azure AI Search** cannot filter inside the metadata JSON blob, so indexes now
  carry `metadata_kv` (flattened `key=value` entries) and `metadata_keys`
  alongside it. That covers equality and set membership; range comparisons over a
  string collection are not expressible, so `$gt`/`$gte`/`$lt`/`$lte` are rejected.
- **Milvus** can only filter a metadata column typed as JSON. Collections created
  earlier store `metadata_json` as `VarChar`.

To enable filtering on an existing index in either store, recreate the index and
reingest its documents.

### Knowledge Engine

Knowledge Engine modules add two settings on top of the same language:

- `defaultFilter` — ANDed into every query against the module, so several sources
  can share one vector index while each module retrieves only its own slice.
- `filterableFields` — the metadata keys callers may filter on. When set, a query
  touching any other key is rejected, and the list is advertised to agents and MCP
  clients so they know what is filterable.

Documents ingested by the crawler carry `source`, `sourceUrl`, `crawlerKey`,
`jobId`, `depth`, and `title`, which makes those the natural `filterableFields`
for a crawled knowledge base.
