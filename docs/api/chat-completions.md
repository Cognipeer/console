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
| `model` | string | Yes | Model key configured in the dashboard, or `agent:<key>` ([below](#agents)) |
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

## Agents

`model` may also name an agent: `agent:<key>` (a bare agent key works when no model has that key). The call runs the agent's published version as a [run](/guide/agent-background-execution), takes `response_format` for [structured output](/api/agents#structured-output) and `variables` for the agent's declared [variables](/api/agents#variables) (chat clients cannot send them: give a variable that chat also needs a default), and answers `202` with a `Location` header when it is still running after the wait window. Details: [Calling an agent on chat completions](/guide/inference#calling-an-agent-on-chat-completions).

## Files the agent produced

When `model` is an agent and the turn produced files (left in its sandbox's `/outputs/` folder, or written with `session_files_create`), the reply also carries them (additive; absent otherwise, see [Session files](/guide/session-files#files-the-agent-produces)):

- non-streaming: `output_files: [{ id, name, mime_type, size, download_url }]` on the body and `file_path` annotations (`{ type, file_id, filename }`) on `choices[0].message.annotations`;
- streaming: the same `output_files`-shaped list as `files` on the closing chunk (the one with `finish_reason`).

`download_url` is relative to the server origin and already includes `/api`; fetch it with the same credentials.

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
| 500 | Model not found |
| 500 | Model is not configured for chat completions |
| 429 | Rate limit or quota exceeded |
| 500 | Provider error (circuit breaker / upstream) |

## Examples

### cURL

```bash
curl -X POST https://gateway.example.com/api/client/v1/chat/completions \
  -H "Authorization: Bearer cpeer_your_token" \
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
    headers={"Authorization": "Bearer cpeer_your_token"},
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
    'Authorization': 'Bearer cpeer_your_token',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
});
const data = await response.json();
```
