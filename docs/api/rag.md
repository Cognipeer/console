# RAG API

Endpoints for managing RAG modules, document ingestion, and semantic retrieval.

## Modules

### List Modules

```
GET /api/client/v1/rag/modules
```

```json
{ "modules": [{ "key": "support-kb", "name": "Support Knowledge Base", ... }] }
```

### Get Module

```
GET /api/client/v1/rag/modules/:key
```

### Delete Module

```
DELETE /api/client/v1/rag/modules/:key
```

## Document Ingestion

### Ingest Text

```
POST /api/client/v1/rag/modules/:key/ingest
```

```json
{
  "fileName": "faq.txt",
  "content": "Long document text here...",
  "contentType": "text/plain",
  "metadata": { "source": "docs", "version": "2.0" }
}
```

```json
{ "document": { "id": "doc-123", "fileName": "faq.txt", "chunkCount": 15 } }
```

**Status:** 201

### Ingest File

```
POST /api/client/v1/rag/modules/:key/ingest
```

```json
{
  "fileName": "manual.pdf",
  "data": "base64-encoded-file-content",
  "contentType": "application/pdf",
  "metadata": { "department": "support" }
}
```

When `data` is provided instead of `content`, the file is converted to Markdown first, then chunked and embedded.

## Querying

```
POST /api/client/v1/rag/modules/:key/query
```

```json
{
  "query": "How do I reset my password?",
  "topK": 5,
  "filter": { "source": "docs" }
}
```

```json
{
  "result": {
    "matches": [
      {
        "content": "To reset your password, navigate to Settings...",
        "score": 0.92,
        "metadata": { "source": "docs", "documentTitle": "FAQ" }
      }
    ]
  }
}
```

## Documents

### List Documents

```
GET /api/client/v1/rag/modules/:key/documents
```

### Delete Document

```
DELETE /api/client/v1/rag/modules/:key/documents/:documentId
```

Deletes the document record and all associated vectors from the vector store.

### Re-ingest Document

```
POST /api/client/v1/rag/modules/:key/documents/:documentId
```

Re-chunks and re-embeds an existing document. Optionally provide updated content:

```json
{
  "content": "Updated document text...",
  "metadata": { "version": "3.0" }
}
```

Send an empty body to re-ingest with existing content and current chunking settings.

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing required fields |
| 401 | Invalid API token |
| 404 | Module or document not found |
| 429 | Rate limit or quota exceeded |
