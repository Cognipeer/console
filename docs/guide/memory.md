# Memory

The memory service provides semantic memory stores for AI agents — enabling them to remember context across conversations using vector-based storage and retrieval.

## Concepts

| Concept | Description |
|---------|-------------|
| **Memory Store** | Configuration container linking an embedding model and vector index |
| **Memory Item** | A single memory entry with content, tags, scope, and importance |
| **Search** | Semantic similarity search across stored memories |
| **Recall** | Chat-optimized retrieval with token limit awareness |

## Service Functions

| Function | Description |
|----------|-------------|
| `createMemoryStore()` | Create store with vector index + embedding model |
| `listMemoryStores()` | List stores for project |
| `getMemoryStore()` | Get store by key |
| `updateMemoryStore()` | Update config/status |
| `deleteMemoryStore()` | Delete store + vector index |
| `addMemory()` | Add single item (embed → store) |
| `addMemoryBatch()` | Batch add items |
| `listMemoryItems()` | List items in store |
| `getMemoryItem()` | Get single item |
| `updateMemoryItem()` | Update content (re-embed if changed) |
| `deleteMemoryItem()` | Delete single item |
| `deleteMemoryItemsBulk()` | Bulk delete |
| `searchMemories()` | Semantic search |
| `recallForChat()` | Chat-optimized recall with token limit |

## Create Store Request

```json
{
  "name": "Agent Working Memory",
  "vectorProviderKey": "pinecone-prod",
  "embeddingModelKey": "text-embedding-ada-002"
}
```

The store key is generated automatically, and creating a store provisions the backing vector index.

## Client API

### Create Memory Store

```
POST /api/client/v1/memory/stores
Authorization: Bearer <token>
```

### Add Memory

```
POST /api/client/v1/memory/stores/:storeKey/memories
Authorization: Bearer <token>
```

```json
{
  "content": "User prefers dark mode and concise responses",
  "scope": "user",
  "tags": ["preferences", "ui"],
  "importance": 0.8,
  "metadata": { "userId": "user-123" }
}
```

### Search Memories

```
POST /api/client/v1/memory/stores/:storeKey/search
Authorization: Bearer <token>
```

```json
{
  "query": "What are the user's UI preferences?",
  "topK": 5,
  "scope": "user",
  "scopeId": "user-123",
  "tags": ["preferences"],
  "minScore": 0.7
}
```

Response:

```json
{
  "memories": [
    {
      "id": "mem_123",
      "content": "User prefers dark mode and concise responses",
      "score": 0.94,
      "scope": "user",
      "scopeId": "user-123",
      "tags": ["preferences", "ui"],
      "metadata": { "userId": "user-123" },
      "importance": 0.8
    }
  ],
  "query": "What are the user's UI preferences?",
  "storeKey": "mem-agent-working-memory"
}
```

### Recall for Chat

```
POST /api/client/v1/memory/stores/:storeKey/recall
Authorization: Bearer <token>
```

```json
{
  "query": "What does this user like?",
  "scope": "user",
  "scopeId": "user-123",
  "topK": 5,
  "maxTokens": 500
}
```

The recall function is optimized for chat contexts. It returns a compact `context` string together with the matched `memories`, trimmed to fit the requested token budget.

## Memory Properties

| Field | Description |
|-------|-------------|
| `content` | The memory text |
| `scope` | Categorization (e.g., `user`, `session`, `global`) |
| `source` | Origin identifier |
| `tags` | Array of string tags for filtering |
| `importance` | Float 0-1, influences ranking |
| `metadata` | Arbitrary key-value pairs |

## Pipeline

**Adding a memory:**

```
Content → Embed (via inference service) → Vector Upsert → Store metadata
```

**Searching memories:**

```
Query → Embed → Vector Search → Rank by score + importance → Return
```

## Dependencies

- **Inference Service** — For generating embeddings
- **Vector Service** — For storing and querying vectors
