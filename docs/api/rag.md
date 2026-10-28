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

### OCR for scanned files and images

A module can read the text of scanned PDFs, images (`.png`, `.jpg`, `.tif`, ...) and, optionally, pictures inside Word and PowerPoint files. It is off by default: without `extraction` files are converted exactly as before.

Set it on the module (create with `extraction`, change with `PATCH`; `"extraction": null` clears it):

```json
{
  "extraction": {
    "ocr": { "mode": "auto", "modelKey": "mistral-ocr", "languages": ["tr", "en"], "maxPages": 100, "images": true }
  }
}
```

| Property | Description |
|----------|-------------|
| `mode` | `off`, `auto` (only pages without a text layer, and images, are read) or `always` (every page). |
| `modelKey` | An OCR model, or a vision LLM, of the module's project. Omit it for the server's built-in CPU engine (Tesseract, offline). An unknown or unusable model is a `400`. |
| `languages` | ISO 639-1 hints. Default `tr`, `en`. |
| `maxPages` | Read at most this many pages per document (default 100; hard cap 500). |
| `images` | Also read pictures embedded in Word and PowerPoint files. |

A single upload may override the module: send `"extraction": { "ocr": { ... } }` with `data`, or `"extraction": { "ocr": null }` to switch OCR off for that file.

Reading the pages of a scan can take minutes. With `"async": true` (and a module that keeps files in a bucket) the call returns `202` as soon as the file is stored; the document is `pending` and carries `extraction.stage` (`queued`, then `running` with `extraction.progress`) until its text is there. The text is then chunked and embedded as usual. Without `async` the request waits for the pages to be read.

A document read with OCR carries `extraction` (`sourceType` `converted`, `ocr` or `mixed`, `ocrPages`, `pageCount`, `engine`, `warnings`, ...). If OCR cannot finish in time, or fails, a file with a text layer keeps that text and a warning code (such as `ocr_timeout`) is recorded. A file without one (a scan, an image) has no text to keep: the upload answers `422` with `code` `ocr_incomplete`, and with `async` the document ends `failed` with the reason.

The bytes of a file are never compared with earlier uploads (their hash is only recorded). A synchronous upload whose text matches an indexed document of the same name returns that document, as any upload does; an `async` upload whose pages are read later is not compared and becomes a new document.

In a knowledge base with access control the folder and permissions of an upload are checked before its pages are read, so a refused placement costs no OCR. A document deleted while its pages are being read is not indexed afterwards.

Re-indexing never runs OCR again: a document that was read with OCR keeps its text. To read the stored original again with the module's current settings, re-ingest the document with `"reextract": true`.

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

Send `"reextract": true` to read the stored original file again with the module's current OCR settings (see above) and replace the document's text with the result. If the original was not kept the call fails with `409`. A new file sent with `data` is always read with the module's OCR settings.

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing required fields |
| 401 | Invalid API token |
| 403 | The change needs Knowledge Engine `admin` (`access_denied`), or it names the vector index or a crawler binding of a knowledge base with access control (`kb_access_controlled`: query the knowledge base instead) |
| 404 | Module or document not found, or a document the caller may not read |
| 409 | Module not active; `reextract` of a document whose original was not kept, or whose OCR could not finish (the previous text, folder and permissions are kept); a re-ingest of a document read with OCR whose stored text cannot be read |
| 422 | `ocr_incomplete`: the file has no text layer and OCR could not read it |
| 429 | Rate limit or quota exceeded |
