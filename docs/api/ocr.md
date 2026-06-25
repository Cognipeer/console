# OCR API

Extract text, tables, and structured data from documents. Two surfaces ship with the OCR module:

- **Synchronous OCR** (`POST /api/client/v1/ocr`) — extract a single document in one request and get the result back inline.
- **OCR Jobs** (`/api/client/v1/ocr-jobs/*`) — a persistent, async batch container. Send files over time, process them via queue fan-out, and collect full-text / summary / structured output with token and cost accounting plus optional per-file callbacks.

All routes are API-token authenticated with a `Bearer cpeer_…` token. Base path: `/api/client/v1`.

## Synchronous OCR

```http
POST /api/client/v1/ocr
Authorization: Bearer cpeer_…
```

Accepts either `multipart/form-data` (upload a file) or `application/json` (URL or base64 document).

### Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | Yes | OCR model key. |
| `file` | file | Yes* | Document file (multipart only). |
| `document_url` | string | Yes* | Document URL (multipart only). |
| `document` | object | Yes* | JSON body: `{ url }` or `{ data }` (base64), with optional `fileName`, `contentType`. |
| `pages` | string \| number[] | No | Pages to process. Comma-separated string (`"1,2,5"`) or array. Only positive page numbers are kept. |
| `language` | string | No | Language hint for extraction. |
| `features` | string \| string[] | No | OCR features to enable (see below). Comma-separated string or array; unknown values are ignored. |
| `prompt` | string | No | Optional extraction guidance prompt. |

\* For multipart, supply **either** `file` **or** `document_url`. For JSON, supply a `document` object containing **either** `url` **or** `data` (base64).

**Valid `features`:** `text`, `tables`, `kv_pairs`, `layout`, `reading_order`, `handwriting`.

### Request (multipart)

```bash
curl -X POST https://gateway.example.com/api/client/v1/ocr \
  -H "Authorization: Bearer cpeer_your_token" \
  -F "model=mistral-ocr" \
  -F "file=@invoice.pdf" \
  -F "pages=1,2" \
  -F "features=text,tables,kv_pairs"
```

### Request (JSON)

```json
{
  "model": "mistral-ocr",
  "document": { "url": "https://example.com/invoice.pdf" },
  "pages": [1, 2],
  "language": "en",
  "features": ["text", "tables"],
  "prompt": "Extract the line items as a table."
}
```

To send raw bytes instead of a URL:

```json
{
  "model": "mistral-ocr",
  "document": { "data": "<base64>", "fileName": "invoice.pdf", "contentType": "application/pdf" }
}
```

### Response

The provider response is returned inline with the generated `request_id` merged in:

```json
{
  "text": "Invoice …",
  "pages": [ { "index": 0, "text": "…", "tables": [], "kv_pairs": {} } ],
  "request_id": "req_abc123"
}
```

The exact shape of the extracted fields depends on the OCR model/provider and the `features` requested.

## OCR Jobs (Async Batch)

An OCR Job is a persistent container holding processing rules (models, outputs, language, features), a storage bucket, and an optional callback. Files are added to the job over time and processed per-file by queue fan-out. Each file becomes an **item** with its own result, usage, and cost.

### Lifecycle and statuses

A job has one of three statuses:

| Status | Meaning |
|---|---|
| `active` | Files are processed as they arrive. |
| `paused` | Intake/processing is held; resume to continue. |
| `archived` | Job is retired. |

Items added with `mode: "sync"` are processed before the response returns (HTTP `200`); with `mode: "async"` (the default) they are queued and the response returns immediately (HTTP `202`).

### Create Job

```http
POST /api/client/v1/ocr-jobs
Authorization: Bearer cpeer_…
Content-Type: application/json
```

| Field | Type | Required | Description |
|---|---|---|---|
| `ocr_model` | string | Yes | OCR model key. (`model` is also accepted.) |
| `bucket_key` | string | Yes | Storage bucket key. (`bucketKey` also accepted.) |
| `name` | string | No | Display name. |
| `llm_model` | string | No | LLM model key used for summary/structured outputs. |
| `outputs` | string \| string[] | No | One or more of `full_text`, `summary`, `structured`. Defaults to `["full_text"]`. |
| `summary_prompt` | string | No | Prompt used when `summary` is requested. |
| `structured_schema` | object | No | Schema used when `structured` is requested. |
| `language` | string | No | Language hint. |
| `features` | string[] | No | OCR features to enable. |
| `pdf_max_pages` | number | No | Cap on PDF pages per file. |
| `callback_url` | string | No | Per-file webhook URL. |
| `callback_secret` | string | No | Secret used to sign callbacks. |
| `callback_events` | string \| string[] | No | Subset of `item.succeeded`, `item.failed`. |
| `metadata` | object | No | Arbitrary metadata. |

#### Response `201`

```json
{
  "job": {
    "id": "665f…",
    "name": "Invoices Q2",
    "status": "active",
    "bucket_key": "invoices",
    "ocr_model": "mistral-ocr",
    "llm_model": "gpt-4o-mini",
    "outputs": ["full_text", "summary"],
    "pdf_max_pages": null,
    "callback_url": "https://hooks.example.com/ocr",
    "items_total": 0,
    "items_processed": 0,
    "items_failed": 0,
    "usage": {
      "input_tokens": 0, "output_tokens": 0, "total_tokens": 0,
      "pages": 0, "ocr_tokens": 0, "llm_tokens": 0
    },
    "cost_total": 0, "cost_ocr": 0, "cost_llm": 0, "cost_currency": "USD",
    "last_item_at": null,
    "created_at": "2026-06-15T12:00:00.000Z"
  }
}
```

### List Jobs

```http
GET /api/client/v1/ocr-jobs?status=active&limit=50
Authorization: Bearer cpeer_…
```

Optional query params: `status`, `limit`. Returns `{ "jobs": [ <job>, … ] }` using the same job shape as above.

### Get Job

```http
GET /api/client/v1/ocr-jobs/:id
Authorization: Bearer cpeer_…
```

Returns `{ "job": <job> }`. The job object carries live progress (`items_total`, `items_processed`, `items_failed`) and rolling `usage`/`cost` totals, so this doubles as the status endpoint. Returns `404` if not found.

### Update Job

```http
PATCH /api/client/v1/ocr-jobs/:id
Authorization: Bearer cpeer_…
Content-Type: application/json
```

Any subset of these fields may be updated:

| Field | Type | Notes |
|---|---|---|
| `name` | string | |
| `status` | enum | `active`, `paused`, or `archived`. |
| `ocr_model` | string | |
| `llm_model` | string | |
| `outputs` | string \| string[] | Normalized; falls back to `["full_text"]`. |
| `summary_prompt` | string | |
| `structured_schema` | object | |
| `language` | string | |
| `pdf_max_pages` | number | |
| `callback_url` | string | |
| `callback_secret` | string | |
| `callback_events` | string \| string[] | |

Returns `{ "job": <job> }`, or `404` if not found.

### Delete Job

```http
DELETE /api/client/v1/ocr-jobs/:id
Authorization: Bearer cpeer_…
```

Returns `{ "ok": true }`, or `404` if not found.

### Add Files

```http
POST /api/client/v1/ocr-jobs/:id/files
Authorization: Bearer cpeer_…
```

Accepts `multipart/form-data` or `application/json`. At least one file is required.

**Multipart:** attach one or more files under the `files` (or `file`) field. Optional `mode` field: `sync` or `async` (default `async`).

**JSON:** pass an `items` (or `documents`) array. Each item may specify a `source`:

- `{ "kind": "inline", "data": "<base64>", "fileName", "contentType" }`
- `{ "kind": "url", "url": "https://…", "contentType" }`
- `{ "kind": "bucket", "bucketKey": "…", "objectKey": "…" }`

For convenience an item may instead use a top-level `bucket: { bucketKey, objectKey }` or a `document: { url }` / `document: { data }` (base64). Set top-level `mode: "sync"` to process inline.

```json
{
  "mode": "async",
  "items": [
    { "source": { "kind": "url", "url": "https://example.com/a.pdf" }, "fileName": "a.pdf" },
    { "document": { "data": "<base64>", "fileName": "b.png" } }
  ]
}
```

#### Response — `200` (sync) or `202` (async)

```json
{
  "items": [
    {
      "id": "665f…",
      "index": 0,
      "file_name": "a.pdf",
      "status": "queued",
      "result": null,
      "usage": null,
      "cost_total": 0,
      "cost_currency": "USD",
      "callback_status": null,
      "error_message": null
    }
  ]
}
```

### Pause Job

```http
POST /api/client/v1/ocr-jobs/:id/pause
Authorization: Bearer cpeer_…
```

Sets the job status to `paused` and returns `{ "job": <job> }`. Returns `404` if not found.

### Resume Job

```http
POST /api/client/v1/ocr-jobs/:id/resume
Authorization: Bearer cpeer_…
```

Sets the job status back to `active` and returns `{ "job": <job> }`. Returns `404` if not found.

### List Items

```http
GET /api/client/v1/ocr-jobs/:id/items?limit=50&skip=0&status=succeeded
Authorization: Bearer cpeer_…
```

Optional query params: `limit`, `skip`, `status`. Returns `{ "items": [ <item>, … ] }`. Returns `404` if the job is not found.

### Get Item

```http
GET /api/client/v1/ocr-jobs/:id/items/:itemId
Authorization: Bearer cpeer_…
```

Returns a single item:

```json
{
  "item": {
    "id": "665f…",
    "index": 0,
    "file_name": "a.pdf",
    "status": "succeeded",
    "result": { "fullText": "…", "summary": "…", "structured": {} },
    "usage": { "totalTokens": 1234 },
    "cost_total": 0.0021,
    "cost_currency": "USD",
    "callback_status": "delivered",
    "error_message": null
  }
}
```

Returns `404` if the item is not found.

### Job Usage

```http
GET /api/client/v1/ocr-jobs/:id/usage
Authorization: Bearer cpeer_…
```

Aggregate token and cost accounting for the job:

```json
{
  "usage": {
    "items_total": 12,
    "items_processed": 11,
    "items_failed": 1,
    "input_tokens": 5000,
    "output_tokens": 1200,
    "total_tokens": 6200,
    "pages": 34,
    "ocr_tokens": 4000,
    "llm_tokens": 2200,
    "cost_total": 0.042,
    "cost_ocr": 0.018,
    "cost_llm": 0.024,
    "cost_currency": "USD"
  }
}
```

Returns `404` if the job is not found.

### Export

```http
GET /api/client/v1/ocr-jobs/:id/export?format=json
Authorization: Bearer cpeer_…
```

Downloads all items in the requested `format` (default `json`) as an attachment:

| `format` | Content-Type | Contents |
|---|---|---|
| `json` | `application/json` | `{ "job": <job>, "items": [ <item>, … ] }`, pretty-printed. |
| `jsonl` | `application/x-ndjson` | One serialized item per line. |
| `csv` | `text/csv` | Columns: `index, file_name, status, full_text, summary, structured, total_tokens, cost_total`. |

Returns `404` if the job is not found.

## Errors

| Status | Cause |
|---|---|
| 400 | Missing `model`/`ocr_model`/`bucket_key`, no `file`/`document_url`/`document`, no files on add, unsupported `Content-Type`, malformed body. |
| 401 | Missing or invalid API token. |
| 404 | Job or item not found. |
| 429 | Rate limit, per-request limit, or budget/quota exceeded. |
| 500 | Internal / inference error. |
| 503 | Service is shutting down (`Retry-After` header set). |

## Example

Synchronous extraction of a single file:

```bash
curl -X POST https://gateway.example.com/api/client/v1/ocr \
  -H "Authorization: Bearer cpeer_your_token" \
  -F "model=mistral-ocr" \
  -F "file=@invoice.pdf" \
  -F "features=text,tables"
```

Batch job: create, add files, then poll status:

```bash
# 1. Create a job
curl -X POST https://gateway.example.com/api/client/v1/ocr-jobs \
  -H "Authorization: Bearer cpeer_your_token" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Invoices Q2", "ocr_model": "mistral-ocr", "bucket_key": "invoices", "outputs": ["full_text", "summary"] }'

# 2. Add files (async)
curl -X POST https://gateway.example.com/api/client/v1/ocr-jobs/<id>/files \
  -H "Authorization: Bearer cpeer_your_token" \
  -F "files=@invoice1.pdf" \
  -F "files=@invoice2.pdf"

# 3. Check status / progress
curl https://gateway.example.com/api/client/v1/ocr-jobs/<id> \
  -H "Authorization: Bearer cpeer_your_token"

# 4. Export results
curl "https://gateway.example.com/api/client/v1/ocr-jobs/<id>/export?format=jsonl" \
  -H "Authorization: Bearer cpeer_your_token" -o results.jsonl
```
