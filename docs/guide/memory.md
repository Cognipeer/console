# Memory

The memory service provides semantic memory stores for AI agents — enabling them to remember context across conversations using vector-based storage and retrieval. Operators manage stores under **Data → Agent Memory**.

## Agent Memory

A *memory store* is the unit that binds an embedding model to a vector index — it's where individual memory items live, scoped to a project. The list view shows total stores, total memories across all stores, and how many stores are currently active.

![Agent Memory list](/screenshots/memory/01-memory-list.png)

Creating the first store requires two prerequisites: a vector provider configured in [Knowledge Index](/guide/vector-stores) and an embedding model deployed in [Model Hub](/guide/model-hub). The **Create First Store** flow walks you through both — it'll halt and point to the missing piece if either isn't ready.

Once a store exists, every memory item carries content, free-form tags, an importance score, and an optional scope. Agents read from the store via the `search()` and `recall()` APIs documented below — `recall()` is the chat-optimised variant that respects a max-tokens budget.

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

## Mounting memory stores on an agent

An agent's **Memory** section lets you mount one or more stores (up to 5) instead of a single one. Each mount has:

- **Store** - an existing store from this module.
- **Access** - `read & write` or `read only`. Read-only mounts are never written to or forgotten from.
- **Use for** - a short description; it is added to the agent's system prompt so the model knows which store holds what.
- **Scope** - optional per-mount override of the agent's memory scope.

The first mount is the primary store: it feeds the pre-injected recall and the automatic summary writes (skipped if it is read-only). With several mounts, `memory_search` takes an optional `store` (omitted = search all mounts, results interleaved by rank and tagged with their store), and `memory_write` / `memory_forget` take `store` (required when more than one mount is writable).

**Sharing across agents:** several agents that mount the same store with the same scope read and write the same facts. For mounts, `workspace` scope is shared project-wide (not per agent) and `tenant` scope is shared by the whole store; `session` and `user` follow the conversation and caller. Agents with only the legacy single store key keep their per-agent `workspace` namespace. A legacy key is treated as the first read & write mount when you edit mounts.

