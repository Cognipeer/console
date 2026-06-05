# Chat Completions API

OpenAI-compatible chat completion endpoint with optional streaming.

## Endpoint

```
POST /api/client/v1/chat/completions
```

## Request

```json
{
  "model": "gpt-4",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "What is the capital of France?" }
  ],
  "temperature": 0.7,
  "max_tokens": 1000,
  "stream": false,
  "request_id": "optional-correlation-id"
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Model key configured in the dashboard |
| `messages` | array | Yes | Array of message objects |
| `temperature` | number | No | Sampling temperature (0-2) |
| `max_tokens` | number | No | Maximum tokens in response |
| `max_completion_tokens` | number | No | Alternative to `max_tokens` |
| `stream` | boolean | No | Enable SSE streaming (default: false) |
| `request_id` | string | No | Client-provided correlation ID |

### Message Format

```json
{ "role": "system" | "user" | "assistant" | "tool", "content": "..." }
```

## Response (Non-Streaming)

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "model": "gpt-4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris."
      },
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

## Response (Streaming)

When `stream: true`, the response is a Server-Sent Events stream:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
X-Request-Id: req_abc123

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"index":0}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"delta":{"content":"The"},"index":0}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"delta":{"content":" capital"},"index":0}]}

data: [DONE]
```

## Guardrail Blocking

If a guardrail blocks the request:

```json
{
  "error": {
    "message": "Content blocked by guardrail",
    "type": "guardrail_block",
    "guardrail_key": "pii-checker",
    "action": "block",
    "findings": [
      { "category": "email", "message": "PII detected" }
    ]
  }
}
```

**Status code:** 400

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing `model` or `messages`, guardrail block |
| 401 | Invalid API token |
| 404 | Model not found |
| 422 | Model is not an LLM (wrong category) |
| 429 | Rate limit or quota exceeded |
| 503 | Provider circuit breaker open |

## Examples

### cURL

```bash
curl -X POST https://gateway.example.com/api/client/v1/chat/completions \
  -H "Authorization: Bearer cgt_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Python

```python
import requests

response = requests.post(
    "https://gateway.example.com/api/client/v1/chat/completions",
    headers={"Authorization": "Bearer cgt_your_token"},
    json={
        "model": "gpt-4",
        "messages": [{"role": "user", "content": "Hello"}]
    }
)
print(response.json())
```

### Node.js

```typescript
const response = await fetch('https://gateway.example.com/api/client/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer cgt_your_token',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
});
const data = await response.json();
```
