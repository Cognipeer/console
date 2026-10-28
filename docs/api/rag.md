# Knowledge Engine API

Endpoints for managing Knowledge Engine modules, document ingestion, and semantic retrieval.

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

A module with [access control](/guide/rag#access-control) comes without `totalDocuments` and `totalChunks`, since the
reads of an API token are checked.

### Update Module

```
PATCH /api/client/v1/rag/modules/:key
```

```json
{ "access": { "enabled": true, "adminBypass": true } }
```

Changing `access` needs Knowledge Engine `admin`. `adminBypass` (default `true`) lets the administrators of the
knowledge base read every document in the console; calls of the client API never get that exception.

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

### Folders and permissions on ingest

An ingest, and a re-ingest, can place the document and give it its own permissions:

```json
{
  "fileName": "budget-2027.md",
  "content": "...",
  "folderPath": "Finance/Budgets",
  "acl": { "mode": "own", "entries": ["group:65f0c2a1e4b0a1b2c3d4e5f7", "email:ada@example.com"] }
}
```

| Field | Meaning |
|---|---|
| `folderId` | The folder to put the document in; `null` is the top level |
| `folderPath` | A `/`-separated path whose missing folders are created; ignored when `folderId` is given |
| `acl` | The document's own permissions: `mode` `own` (with `entries`; an empty list lets nobody read it) or `inherit`. Needs Knowledge Engine `admin` (`403 access_denied`) |

In a knowledge base with access control, a token without Knowledge Engine `admin` places a new document only in a
folder it can read and creates no folder. See [Access control](/guide/rag#access-control) for what an entry can name.

## Querying

```
POST /api/client/v1/rag/modules/:key/query
```

In a knowledge base with access control, matches come only from documents the caller may read: an API token reads
what is open to everyone and what names the token, and a call that acts for a person reads what that person may read.

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

In a knowledge base with access control, only the documents the caller may read are listed. Reading, re-ingesting
or deleting a document the caller may not read answers `404`, like a missing one.

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
| 403 | The change needs Knowledge Engine `admin` (`access_denied`), or it names the vector index or a crawler binding of a knowledge base with access control (`kb_access_controlled`: query the knowledge base instead) |
| 404 | Module or document not found, or a document the caller may not read |
| 429 | Rate limit or quota exceeded |
