# Inference (LLM & Embeddings)

The inference service provides OpenAI-compatible chat completion and embedding endpoints backed by multiple LLM providers.

## Chat Completions

### Endpoint

```
POST /api/client/v1/chat/completions
Authorization: Bearer <api-token>
```

### Request

```json
{
  "model": "gpt-4",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "What is the capital of France?" }
  ],
  "temperature": 0.7,
  "max_tokens": 1000,
  "stream": false
}
```

### Response (Non-Streaming)

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "model": "gpt-4",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "The capital of France is Paris." },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 8,
    "total_tokens": 33
  },
  "request_id": "req_abc123"
}
```

### Streaming

Set `"stream": true` to receive Server-Sent Events:

```
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"delta":{"content":"The"},"index":0}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"delta":{"content":" capital"},"index":0}]}

data: [DONE]
```

## Embeddings

### Endpoint

```
POST /api/client/v1/embeddings
Authorization: Bearer <api-token>
```

### Request

```json
{
  "model": "text-embedding-ada-002",
  "input": "Hello world"
}
```

### Response

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.0023, -0.0092, ...]
    }
  ],
  "model": "text-embedding-ada-002",
  "usage": {
    "prompt_tokens": 2,
    "total_tokens": 2
  }
}
```

## Processing Pipeline

```
Request → requireApiToken()
       → Resolve model by key
       → Validate model category (LLM vs embedding)
       → Guardrail check (if configured)
       → Semantic cache lookup (if enabled)
       → Build provider runtime (via runtimePool)
       → Execute with withResilience()
       → Convert to OpenAI format
       → Log usage (fireAndForget)
       → Return response
```

## Features

### Semantic Caching

When enabled on a model, similar queries return cached responses:

- Cache lookup before provider call
- Cache store after successful response
- Configurable similarity threshold

### Guardrail Integration

Models can have guardrails attached that evaluate input before sending to the provider:

```typescript
// If guardrail blocks the request
throw new GuardrailBlockError(guardrailKey, action, findings);
```

### Usage Logging

Every request is logged asynchronously (via `fireAndForget`):

- Token counts (prompt, completion, total)
- Latency (ms)
- Model and provider info
- Tool call metadata
- Request ID for correlation

### Provider Resilience

External provider calls are wrapped with:
- **Retry** — Exponential backoff for transient failures
- **Circuit breaker** — Automatic rejection when provider is down
- **Runtime pooling** — Cached SDK clients for performance

## Model Configuration

Models are configured in the dashboard with:

| Field | Description |
|-------|-------------|
| `key` | Unique model identifier per tenant |
| `category` | `llm` or `embedding` |
| `providerKey` | Which provider config to use |
| `modelId` | Provider-specific model name |
| `pricing` | Cost per 1M tokens (input/output) |
| `overrides` | Default parameters (temperature, maxTokens, etc.) |

## Error Handling

| Status | Meaning |
|--------|---------|
| 400 | Missing model key or invalid request body |
| 401 | Invalid or missing API token |
| 403 | Feature not available in license |
| 404 | Model not found |
| 422 | Model category mismatch |
| 503 | Provider circuit breaker is open |
