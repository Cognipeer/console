# RAG Pipeline

The RAG (Retrieval-Augmented Generation) service provides end-to-end document ingestion, chunking, embedding, and semantic retrieval.

## Architecture

```
Document → Chunk → Embed → Vector Store
                              ↓
Query   → Embed → Vector Search → Return Matches
```

## Concepts

| Concept | Description |
|---------|-------------|
| **RAG Module** | Configuration container linking chunking strategy, embedding model, and vector index |
| **Document** | A text or file ingested into a module |
| **Chunk** | A segment of a document after splitting |
| **Query Log** | Audit record of retrieval queries |

## Service Functions

| Function | Description |
|----------|-------------|
| `createRagModule()` | Create module with chunk/embed config |
| `updateRagModule()` | Update module settings |
| `deleteRagModule()` | Delete module and associated data |
| `getRagModule()` | Get by key |
| `listRagModules()` | List modules for tenant |
| `ingestDocument()` | Text ingestion: chunk → embed → store |
| `ingestFile()` | File ingestion: convert → chunk → embed → store |
| `queryRag()` | Semantic retrieval |
| `deleteRagDocument()` | Delete document and its vectors |
| `reingestDocument()` | Re-chunk and re-embed existing document |
| `listRagDocuments()` | List documents in a module |
| `listRagQueryLogs()` | Query audit log |

## Module Configuration

```json
{
  "name": "Support Knowledge Base",
  "key": "support-kb",
  "embeddingModelKey": "text-embedding-ada-002",
  "vectorProviderKey": "pinecone-prod",
  "vectorIndexKey": "support-index",
  "chunkConfig": {
    "strategy": "recursive",
    "chunkSize": 1000,
    "chunkOverlap": 200
  }
}
```

## Text Ingestion

```
POST /api/client/v1/rag/modules/:moduleKey/ingest
Authorization: Bearer <token>
```

```json
{
  "title": "Product FAQ",
  "content": "Long document text here...",
  "metadata": { "source": "docs", "version": "2.0" }
}
```

**Pipeline:**
1. Split text into chunks using configured strategy
2. Generate embeddings for each chunk
3. Upsert vectors to the vector index
4. Store document and chunk metadata

## File Ingestion

Submit a file for automatic processing:

1. File is converted to Markdown (using `@cognipeer/to-markdown`)
2. Markdown is chunked according to module config
3. Chunks are embedded and stored

## Querying

```
POST /api/client/v1/rag/modules/:moduleKey/query
Authorization: Bearer <token>
```

```json
{
  "query": "How do I reset my password?",
  "topK": 5,
  "filter": { "source": "docs" }
}
```

**Pipeline:**
1. Embed the query text
2. Perform vector similarity search
3. Return matching chunks with scores and metadata

**Response:**

```json
{
  "matches": [
    {
      "content": "To reset your password, navigate to...",
      "score": 0.92,
      "metadata": { "source": "docs", "documentTitle": "Product FAQ" }
    }
  ]
}
```

## Re-ingestion

When a document is updated or chunking config changes, use `reingestDocument()` to:

1. Remove existing vectors for the document
2. Re-chunk with current settings
3. Re-embed and store new vectors

## Dependencies

The RAG pipeline integrates several gateway services:

- **Inference Service** — For generating embeddings
- **Vector Service** — For storing and querying vectors
- **File Service** — For file conversion (optional)
