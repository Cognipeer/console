# Vector API

Endpoints for managing vector providers, indexes, and performing vector operations.

## Providers

### List Providers

```
GET /api/client/v1/vector/providers
```

Query parameters: `?status=active&driver=pinecone`

```json
{ "providers": [{ "key": "pinecone-prod", "driver": "pinecone", "name": "Production", "status": "active" }] }
```

### Create Provider

```
POST /api/client/v1/vector/providers
```

```json
{
  "key": "pinecone-prod",
  "driver": "pinecone",
  "label": "Production Vectors",
  "credentials": { "apiKey": "pk-..." },
  "settings": { "environment": "gcp-starter" }
}
```

Response: `201 Created`

### List Drivers

```
GET /api/client/v1/vector/providers/drivers
```

Returns available vector provider drivers.

### Get Driver Form

```
GET /api/client/v1/vector/providers/drivers/:driverId/form
```

Returns the credential/settings form schema for UI rendering.

## Indexes

### List Indexes

```
GET /api/client/v1/vector/providers/:providerKey/indexes
```

```json
{ "indexes": [{ "key": "products", "externalId": "idx-123", "dimension": 1536, "metric": "cosine" }] }
```

### Create Index

```
POST /api/client/v1/vector/providers/:providerKey/indexes
```

```json
{
  "name": "Product Embeddings",
  "dimension": 1536,
  "metric": "cosine"
}
```

If an index with the same normalized name exists, it is reused (returns `200` with `reused: true`). New indexes return `201`.

### Get Index

```
GET /api/client/v1/vector/providers/:providerKey/indexes/:externalId
```

### Update Index

```
PATCH /api/client/v1/vector/providers/:providerKey/indexes/:externalId
```

```json
{
  "name": "Updated Name",
  "metadata": { "description": "Updated metadata" }
}
```

### Delete Index

```
DELETE /api/client/v1/vector/providers/:providerKey/indexes/:externalId
```

## Vector Operations

### Upsert Vectors

```
POST /api/client/v1/vector/providers/:providerKey/indexes/:externalId/upsert
```

```json
{
  "vectors": [
    { "id": "vec-1", "values": [0.1, 0.2, ...], "metadata": { "category": "electronics" } },
    { "id": "vec-2", "values": [0.3, 0.4, ...], "metadata": { "category": "books" } }
  ]
}
```

```json
{ "upserted": 2 }
```

### Query Vectors

```
POST /api/client/v1/vector/providers/:providerKey/indexes/:externalId/query
```

```json
{
  "query": {
    "vector": [0.1, 0.2, ...],
    "topK": 10,
    "filter": { "category": "electronics" }
  }
}
```

```json
{
  "result": {
    "matches": [
      { "id": "vec-1", "score": 0.95, "metadata": { "category": "electronics" } }
    ]
  }
}
```

### Delete Vectors

```
DELETE /api/client/v1/vector/providers/:providerKey/indexes/:externalId/vectors
```

```json
{ "ids": ["vec-1", "vec-2"] }
```

```json
{ "deleted": 2 }
```

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing required fields |
| 401 | Invalid API token |
| 404 | Provider or index not found |
| 422 | Dimension mismatch |
| 429 | Rate limit or resource quota exceeded |
