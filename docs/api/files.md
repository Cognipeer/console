# Files API

Endpoints for file storage management: providers, buckets, and file operations.

## Providers

### List File Providers

```
GET /api/client/v1/files/providers?status=active&driver=s3
```

### Create File Provider

```
POST /api/client/v1/files/providers
```

```json
{
  "key": "s3-prod",
  "driver": "s3",
  "label": "Production Storage",
  "credentials": { "accessKeyId": "AKIA...", "secretAccessKey": "..." },
  "settings": { "region": "us-east-1" }
}
```

## Buckets

### List Buckets

```
GET /api/client/v1/files/buckets
```

```json
{ "buckets": [...], "count": 3 }
```

### Get Bucket

```
GET /api/client/v1/files/buckets/:bucketKey
```

## File Operations

### List Files

```
GET /api/client/v1/files/buckets/:bucketKey/objects?search=report&limit=50&cursor=abc
```

```json
{ "files": [...], "count": 12, "nextCursor": "def" }
```

### Upload File

```
POST /api/client/v1/files/buckets/:bucketKey/objects
```

```json
{
  "fileName": "report.pdf",
  "data": "base64-encoded-content-or-data-url",
  "contentType": "application/pdf",
  "convertToMarkdown": true,
  "metadata": { "department": "sales" }
}
```

```json
{ "file": { "key": "report-pdf", "originalName": "report.pdf", "sizeBytes": 12345 }, "message": "File uploaded successfully" }
```

**Status:** 201

### Get File Metadata

```
GET /api/client/v1/files/buckets/:bucketKey/objects/:objectKey
```

### Download File

```
GET /api/client/v1/files/buckets/:bucketKey/objects/:objectKey/download?variant=original
```

Query parameter `variant`:
- `original` — Download the original file
- `markdown` — Download the Markdown conversion (if available)

Returns binary content with appropriate headers:
- `Content-Type`
- `Content-Disposition`
- `Content-Length`
- `ETag`
- `X-File-Metadata`

### Delete File

```
DELETE /api/client/v1/files/buckets/:bucketKey/objects/:objectKey
```

```json
{ "message": "File deleted successfully", "bucketKey": "...", "objectKey": "..." }
```

## Markdown Conversion

When uploading with `convertToMarkdown: true`, the gateway extracts text content from the file and stores it as Markdown. This is used by the RAG pipeline for document ingestion.

Supported formats: PDF, DOCX, PPTX, HTML, plain text.

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing required fields |
| 401 | Invalid API token |
| 404 | Bucket or file not found |
| 429 | Rate limit, file size, or storage quota exceeded |
