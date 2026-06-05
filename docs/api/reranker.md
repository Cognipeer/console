# Reranker API

Two surfaces ship with the reranker module:

- **Dashboard API** (`/api/reranker/*`) — full CRUD plus playground runs and run logs. Session-authenticated.
- **Client API** (`/api/client/v1/rerankers`, `/api/client/v1/rerank/:key`) — Cohere-compatible call surface. API-token authenticated.

## Strategies

```
dedicated-model · llm-judge · llm-listwise · heuristic · fusion
```

The per-strategy `config` shape lives in `src/lib/services/reranker/strategies/`. The dashboard form mirrors it.

## Dashboard API

### List

```http
GET /api/reranker?status=active&search=support
```

#### Response

```json
{ "rerankers": [{ "key": "support-rerank", "name": "...", "strategy": "...", "status": "active", "totalRuns": 42, "avgLatencyMs": 180, ... }] }
```

### Create

```http
POST /api/reranker
```

```json
{
  "name": "support-rerank",
  "key": "support-rerank",
  "description": "Cohere v3 multilingual",
  "strategy": "dedicated-model",
  "status": "active",
  "config": {
    "providerKey": "cohere",
    "model": "rerank-multilingual-v3.0",
    "topN": 10
  },
  "metadata": {}
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Display name. |
| `strategy` | enum | yes | One of the five strategies above. |
| `config` | object | yes | Strategy-specific (see below). |
| `key` | string | no | Auto-generated from `name` if omitted. |
| `status` | `active \| disabled` | no | Defaults to `active`. |

### Get / Update / Delete

```
GET    /api/reranker/:key
PATCH  /api/reranker/:key
DELETE /api/reranker/:key
```

### Run (playground)

```http
POST /api/reranker/:key/run
```

```json
{
  "query": "How do I reset my password?",
  "documents": [
    "Forgot password? Click here to reset.",
    "Two-factor authentication setup guide."
  ],
  "topN": 3
}
```

`documents` accepts either strings or `{ id?, content, score?, metadata? }` objects. The response includes the original index, the relevance score, and the document content for each result, in descending score order.

### Run logs

```http
GET /api/reranker/:key/runs?from=2026-04-01&to=2026-05-01&limit=50
```

Returns the persisted run history (input, output, latency, source) for debugging and quality tracking.

## Client API (Cohere-compatible)

For SDKs and existing Cohere-rerank consumers, the client surface mirrors `https://api.cohere.com/v2/rerank`.

### List

```http
GET /api/client/v1/rerankers
Authorization: Bearer cgt_…
```

### Get

```http
GET /api/client/v1/rerank/:key
Authorization: Bearer cgt_…
```

### Run

```http
POST /api/client/v1/rerank/:key
Authorization: Bearer cgt_…
```

```json
{
  "query": "How do I reset my password?",
  "documents": ["Forgot password? Click here to reset.", "Two-factor setup."],
  "top_n": 5
}
```

`documents` accepts strings or `{ id?, text | content, score?, metadata? }`. Both `top_n` and `topN` are accepted.

#### Response (Cohere-shaped)

```json
{
  "id": "rerank-abc123",
  "results": [
    { "index": 0, "relevance_score": 0.92, "document": { "text": "Forgot password?…" } },
    { "index": 1, "relevance_score": 0.31, "document": { "text": "Two-factor setup." } }
  ],
  "meta": {
    "api_version": { "version": "1" },
    "reranker": "support-rerank",
    "strategy": "dedicated-model",
    "model": "rerank-multilingual-v3.0",
    "latency_ms": 180
  }
}
```

## Errors

| Status | Cause |
|---|---|
| 400 | Bad strategy, missing `query`, malformed `documents`. |
| 401 | Missing/invalid API token (client surface). |
| 404 | Reranker key not found. |
| 500 | Internal error. |
