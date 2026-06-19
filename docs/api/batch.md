# Batch API

OpenAI-compatible asynchronous bulk inference. Submit many chat-completion or embedding requests together and execute them asynchronously via per-item queue fan-out, then poll for status and download results as JSONL.

All endpoints are API-token authenticated (`Authorization: Bearer cgt_…`) and use snake_case request/response fields, mirroring OpenAI's `/v1/batches` surface.

## Supported endpoints

A batch runs every line against a single target endpoint:

```
/v1/chat/completions · /v1/embeddings
```

Streaming (`body.stream: true`) is rejected. Each line runs as a non-streaming request and consumes the submitting token's budget quota per item.

## Status lifecycle

**Batch** (`status`):

| Status | Meaning |
|--------|---------|
| `validating` | Reserved pre-run state. |
| `in_progress` | Items are queued/executing. Batches start here on create. |
| `completed` | All items finished (terminal). |
| `failed` | Batch-level failure (terminal). |
| `cancelling` | Cancellation requested; in-flight items drain. |
| `cancelled` | Cancellation finished (terminal). |

**Item** (`status` in items/results): `pending` · `running` · `succeeded` · `failed` · `cancelled`.

The batch is finalized automatically once `completed + failed + cancelled` items reach the total: to `completed` normally, or to `cancelled` if a cancel was requested.

---

## Create

```
POST /api/client/v1/batches
```

Provide requests inline via `requests`, **or** a JSONL object stored in a Document Store bucket via `input_file` — not both. The whole submission is rejected on the first invalid line.

```json
{
  "endpoint": "/v1/chat/completions",
  "requests": [
    {
      "custom_id": "req-1",
      "body": {
        "model": "gpt-4o-mini",
        "messages": [{ "role": "user", "content": "Hello" }]
      }
    }
  ],
  "completion_window": "24h",
  "metadata": { "job": "nightly-summaries" }
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `endpoint` | string | Yes | Target endpoint: `/v1/chat/completions` or `/v1/embeddings`. |
| `requests` | object[] | Conditional | Inline request lines. Each is `{ custom_id?, body }`; if no `body` key, the object itself is treated as the body. Required unless `input_file` is given. |
| `input_file` | object | Conditional | JSONL source in a bucket: `{ bucket_key, object_key }`. Mutually exclusive with `requests`. |
| `output_bucket_key` | string | No | When set, the result JSONL is written to this bucket on completion (`object_key` filled in by the finalizer). |
| `completion_window` | string | No | Informational (OpenAI compat); defaults to `24h`. Items run as soon as workers are free. |
| `metadata` | object | No | Arbitrary key/value metadata echoed back on the batch. |

Each request line `body` must include a `model`. For `/v1/chat/completions`, `body.messages` (array) is required; for `/v1/embeddings`, `body.input` is required.

JSONL input lines follow OpenAI's format — `{ custom_id?, method?, url?, body }`. When present, `url` must match `endpoint` and `method` must be `POST`. The maximum number of request lines per batch is 10,000 (configurable).

### Response

`201 Created` with the batch object.

```json
{
  "id": "665f…",
  "object": "batch",
  "endpoint": "/v1/chat/completions",
  "status": "in_progress",
  "completion_window": "24h",
  "input_file": null,
  "output_file": null,
  "error_message": null,
  "request_counts": { "total": 1, "completed": 0, "failed": 0, "cancelled": 0 },
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 },
  "metadata": { "job": "nightly-summaries" },
  "created_at": 1718409600,
  "started_at": 1718409600,
  "completed_at": null,
  "cancelled_at": null
}
```

`input_file` / `output_file` are `{ bucket_key, object_key }` when present, otherwise `null`. Timestamps are Unix seconds (or `null`).

---

## List

```
GET /api/client/v1/batches?status=in_progress&limit=50
```

| Query | Type | Description |
|-------|------|-------------|
| `status` | string | Optional status filter. |
| `limit` | number | Page size, default 50, clamped to 1–500. |

```json
{ "object": "list", "data": [ /* batch objects */ ] }
```

---

## Retrieve (status)

```
GET /api/client/v1/batches/:batchId
```

Returns the batch object (same shape as create). Poll this for `status` and `request_counts`. `404` if not found.

---

## Cancel

```
POST /api/client/v1/batches/:batchId/cancel
```

Cooperative cancel: pending items drain as `cancelled` without running; items already running finish normally. The batch moves to `cancelling` and is finalized to `cancelled` once the counters drain. Only `in_progress` / `validating` batches can be cancelled (otherwise `400`). Returns the updated batch object.

---

## Items

```
GET /api/client/v1/batches/:batchId/items?status=failed&limit=100&skip=0
```

Per-line execution status.

| Query | Type | Description |
|-------|------|-------------|
| `status` | string | Optional item status filter. |
| `limit` | number | Default 100, clamped to 1–1000. |
| `skip` | number | Offset for pagination. |

```json
{
  "object": "list",
  "data": [
    {
      "id": "665f…",
      "object": "batch.item",
      "index": 0,
      "custom_id": "req-1",
      "status": "succeeded",
      "response_status_code": 200,
      "response_body": { "id": "chatcmpl-…", "choices": [ /* … */ ] },
      "error_message": null,
      "usage": { "input_tokens": 12, "output_tokens": 8, "total_tokens": 20 },
      "started_at": 1718409601,
      "ended_at": 1718409603
    }
  ]
}
```

`usage` is `null` until the item runs. `404` if the batch is not found.

---

## Results

```
GET /api/client/v1/batches/:batchId/results?status=succeeded
```

Returns finished items (`succeeded` and `failed`) as a JSONL document (`Content-Type: application/jsonl`), in OpenAI batch-output format — one JSON object per line:

```json
{"id":"batch_req_665f…","custom_id":"req-1","response":{"status_code":200,"body":{ /* … */ }},"error":null}
{"id":"batch_req_6660…","custom_id":"req-2","response":{"status_code":500,"body":null},"error":{"code":"failed","message":"…"}}
```

On success, `response.body` holds the model output and `error` is `null`. On failure, `response.body` is `null` and `error` is `{ code, message }` where `code` is the item status. The optional `status` query filters which item statuses are included. `404` if the batch is not found.

---

## Errors

| Status | Description |
|--------|-------------|
| 400 | Validation error — bad `endpoint`, both/neither of `requests`/`input_file`, missing `body.model`, missing `messages`/`input`, streaming requested, unreadable input file, empty batch, exceeds max requests, or cancelling a non-cancellable batch. |
| 401 | Missing or invalid API token. |
| 404 | Batch not found. |
| 500 | Internal error. |

---

## Example

Create a batch:

```bash
curl -X POST https://gateway.example.com/api/client/v1/batches \
  -H "Authorization: Bearer cgt_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "endpoint": "/v1/chat/completions",
    "requests": [
      { "custom_id": "req-1", "body": { "model": "gpt-4o-mini", "messages": [{ "role": "user", "content": "Summarize: ..." }] } },
      { "custom_id": "req-2", "body": { "model": "gpt-4o-mini", "messages": [{ "role": "user", "content": "Translate: ..." }] } }
    ]
  }'
```

Poll for completion:

```bash
curl https://gateway.example.com/api/client/v1/batches/665f... \
  -H "Authorization: Bearer cgt_your_token"
# -> { "status": "completed", "request_counts": { "total": 2, "completed": 2, ... } }
```

Download results (JSONL):

```bash
curl https://gateway.example.com/api/client/v1/batches/665f.../results \
  -H "Authorization: Bearer cgt_your_token"
```
