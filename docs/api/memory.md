# Memory API

Endpoints for managing memory stores and performing semantic memory operations.

## Stores

### List Stores

```
GET /api/client/v1/memory/stores?status=active&search=agent
```

### Create Store

```
POST /api/client/v1/memory/stores
```

```json
{
  "name": "Agent Working Memory",
  "vectorProviderKey": "pinecone-prod",
  "embeddingModelKey": "text-embedding-ada-002",
  "description": "Memory for the research agent"
}
```

**Status:** 201

### Get Store

```
GET /api/client/v1/memory/stores/:storeKey
```

### Update Store

```
PATCH /api/client/v1/memory/stores/:storeKey
```

```json
{ "name": "Updated Name", "status": "inactive" }
```

### Delete Store

```
DELETE /api/client/v1/memory/stores/:storeKey
```

Deletes the store and its vector index.

## Memory Items

### Add Memory

```
POST /api/client/v1/memory/stores/:storeKey/memories
```

```json
{
  "content": "User prefers dark mode and concise responses",
  "scope": "user",
  "scopeId": "user-123",
  "tags": ["preferences", "ui"],
  "importance": 0.8,
  "metadata": { "source": "conversation" }
}
```

**Status:** 201

### Add Batch

```
POST /api/client/v1/memory/stores/:storeKey/memories/batch
```

```json
{
  "memories": [
    { "content": "Memory 1", "scope": "user", "tags": ["pref"] },
    { "content": "Memory 2", "scope": "session", "importance": 0.5 }
  ]
}
```

Maximum 100 items per batch. **Status:** 201

### List Memories

```
GET /api/client/v1/memory/stores/:storeKey/memories?scope=user&scopeId=user-123&tags=preferences&limit=50
```

```json
{ "memories": [...], "total": 25 }
```

| Query Parameter | Description |
|----------------|-------------|
| `scope` | Filter by scope (user, agent, session, global) |
| `scopeId` | Filter by scope ID |
| `tags` | Comma-separated tag filter |
| `status` | Filter by status (active, archived, expired) |
| `search` | Full-text search in content |
| `limit` | Page size (default 50) |
| `skip` | Offset for pagination |

### Get Memory

```
GET /api/client/v1/memory/stores/:storeKey/memories/:memoryId
```

### Update Memory

```
PATCH /api/client/v1/memory/stores/:storeKey/memories/:memoryId
```

```json
{ "content": "Updated content", "importance": 0.9 }
```

If content changes, the embedding is regenerated automatically.

### Delete Memory

```
DELETE /api/client/v1/memory/stores/:storeKey/memories/:memoryId
```

### Bulk Delete

```
DELETE /api/client/v1/memory/stores/:storeKey/memories?scope=user&scopeId=user-123&tags=temp
```

## Search

### Semantic Search

```
POST /api/client/v1/memory/stores/:storeKey/search
```

```json
{
  "query": "What are the user's UI preferences?",
  "topK": 10,
  "minScore": 0.7,
  "scope": "user",
  "scopeId": "user-123",
  "tags": ["preferences"]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | — | Search query text |
| `topK` | number | 10 | Maximum results |
| `minScore` | number | — | Minimum similarity score |
| `scope` | string | — | Filter by scope |
| `scopeId` | string | — | Filter by scope ID |
| `tags` | string[] | — | Filter by tags |

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing required fields |
| 401 | Invalid API token |
| 404 | Store or memory not found |
| 429 | Rate limit or quota exceeded |
