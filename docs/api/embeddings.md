# Embeddings API

OpenAI-compatible embedding endpoint for generating vector representations of text.

## Endpoint

```
POST /api/client/v1/embeddings
```

## Request

```json
{
  "model": "text-embedding-ada-002",
  "input": "Hello world",
  "request_id": "optional-correlation-id"
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Embedding model key |
| `input` | string \| string[] | Yes | Text to embed (single or batch) |
| `request_id` | string | No | Client-provided correlation ID |

## Response

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.0023, -0.0092, 0.0156, ...]
    }
  ],
  "model": "text-embedding-ada-002",
  "usage": {
    "prompt_tokens": 2,
    "total_tokens": 2
  },
  "request_id": "req_abc123"
}
```

### Batch Input

```json
{
  "model": "text-embedding-ada-002",
  "input": ["Hello world", "How are you?", "Embedding example"]
}
```

Returns multiple embedding objects indexed by position.

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing `model` or `input` |
| 401 | Invalid API token |
| 404 | Model not found |
| 422 | Model is not an embedding model (wrong category) |
| 429 | Rate limit or quota exceeded |
| 503 | Provider circuit breaker open |

## Example

```bash
curl -X POST https://gateway.example.com/api/client/v1/embeddings \
  -H "Authorization: Bearer cgt_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-ada-002",
    "input": "Hello world"
  }'
```
