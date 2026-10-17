# Inference (LLM & Embeddings)

The inference service provides OpenAI-compatible chat completion and embedding endpoints backed by multiple LLM providers. Models are configured in [Model Hub](/guide/model-hub) and called through the runtime documented below.

## Model discovery

OpenAI-compatible clients can discover project-scoped LLMs before starting a chat:

```http
GET /api/client/v1/models
Authorization: Bearer <api-token>
```

The response preserves the OpenAI list envelope and Console's legacy model records:

```json
{
  "object": "list",
  "data": [
    {
      "id": "support-fast",
      "object": "model",
      "created": 1785403593,
      "owned_by": "cognipeer",
      "name": "Support Fast",
      "context_length": 131072,
      "max_output_tokens": 16384,
      "supports_image_input": true,
      "supports_reasoning": true,
      "supports_structured_outputs": true,
      "supports_tool_calls": true,
      "architecture": {
        "input_modalities": ["text", "image"],
        "output_modalities": ["text"]
      },
      "cognipeer": {
        "schema_version": "1.0",
        "canonical_model_id": "upstream/model-27b",
        "capabilities": {
          "contextWindow": 131072,
          "maxOutputTokens": 16384,
          "inputModalities": ["text", "image"],
          "outputModalities": ["text"],
          "supportsReasoning": true,
          "supportsStructuredOutputs": true,
          "supportsToolCalls": true
        }
      }
    }
  ],
  "models": []
}
```

`data[].id` is the stable public alias and must be sent as the `model` in inference requests. `cognipeer.canonical_model_id` is the provider-facing model identifier used for capability correlation; clients must not substitute it for the public alias. Consumers that only implement the OpenAI core schema can ignore all additional fields.

The route admits a token that holds the Models service (read) **or** the Agents service (read), and what the caller sees follows the service it holds. The list carries the project's **active agents**, as `agent:<key>`, when the token's owner may read the Agents service (a token with Models only simply sees the models; the agents are not an error), and the models and providers only when it may read Models: a token with **Agents only** gets `data` with the agents, `models: []` and no providers, which is all an OpenAI client's model picker needs. A token with neither is `403`:

```json
{
  "id": "agent:support",
  "object": "model",
  "created": 1785403593,
  "owned_by": "cognipeer-agent",
  "name": "Support",
  "description": "Answers customer questions",
  "cognipeer": { "kind": "agent", "key": "support" }
}
```

`GET /api/client/v1/models/agent:support` retrieves one (404 when it is not an active agent of the project, or the token may not read agents). Retrieving a model id needs Models (read), so an Agents-only token gets `403` for it. A narrowing query (`category` other than `llm`, `providerKey`, `providerDriver`) lists models only. Agents are not part of the legacy `models` array.

Capability values come from the explicit Model Hub profile. Legacy model records without that profile continue to work through normalized fallback fields, so upgrading does not require a database migration.

## Calling an agent on chat completions

`POST /api/client/v1/chat/completions` takes `model: "agent:<key>"` (a bare agent key also works when no model has that key) and runs the agent's published version, so any OpenAI client or SDK can call an agent. The token's owner needs the Agents service for it; a model needs the Models service. What differs from a model call:

- **Only the last user message is the turn.** System and developer messages are ignored (the agent owns its prompt), and so are `temperature`, `top_p`, `max_tokens`, `tools` and the other sampling parameters (listed back in the `X-Cognipeer-Ignored-Params` response header). The text parts of that message are joined with a blank line; `image_url` and `file` parts (`file_data`, `file_id`) become files of the session when the agent takes attachments (otherwise 403), and a message with only an image is a valid message.
- **The session is kept by the agent.** Continue one with `conversation_id` in the body or the `X-Cognipeer-Session-Id` header. A client that resends its whole transcript and names no session is matched back automatically: after every turn the session remembers a digest of the transcript the client now holds (its messages without system and developer ones, plus the answer), and a request whose earlier messages digest to it continues that session; any other request starts a new one. The digest also covers the references of files and images (a long value or a data URL is reduced to its hash) and the request's OpenAI `user` field, so a transcript with other files, or from another end user, is a different transcript. A session is continued only when **exactly one** of the person's sessions matches: a transcript that matches two or more (ambiguous) starts a new session instead of guessing. The matching is scoped to the agent, the project and the person who started the session, and a client that edits its history starts a new session. Every response carries the session in `X-Cognipeer-Session-Id`; the body (and, when streaming, the first and the last chunk) carries `conversation_id`.
- **`response_format`** (`json_schema` or `json_object`) shapes the answer for that call; `message.content` is then the JSON string. `inputs` (the agent's declared inputs), `metadata` (up to 16 string pairs, kept on the run), `reasoning_effort` and `agent_model` are accepted as extensions.
- **`Idempotency-Key`** makes a retry the same run: it gets the stored answer without a second run (409 when the key was used for a different request).
- **`version`** pins a published version (a positive integer or a numeric string) or runs the draft (`"draft"`); any other value is `400 invalid_version` and a version that does not exist is `404 version_not_found`.
- **`service_tier: "flex"`** queues the run in the low-priority class and waits for it like a plain call (it cannot be combined with `stream`).
- **Streaming** opens with a chunk whose `delta.role` is `assistant`, sends a `: ping` comment every 15 seconds while the agent works, and ends with `data: [DONE]`; `stream_options.include_usage` adds a final chunk with the run's `usage`. The active-run caps and the agent quota are checked before the stream opens: over a limit the answer is a plain JSON `429` with `Retry-After` and no session is created. A failure after that (a limit reached in the instant after the check, a failing run, a run ended elsewhere: `agent_run_interrupted`) is an error chunk followed by `[DONE]`. A client that disconnects cancels the run.
- **A call that is still running when the wait window ends** answers `202` with an empty `chat.completion` (`choices: []`) whose `cognipeer` object names the run (`status`, `run_id`, `session_id`) and a `Location` header on the [runs API](/guide/agent-background-execution); the run carries on in the background.

## Models and agents on `/responses`

`POST /api/client/v1/responses` takes both. `model` is resolved the same way as on chat completions: `agent:<key>` is an agent; a bare name is a model of the project first, then an agent, and `404 model_not_found` when it is neither. (`/agents/responses` is the agents-only alias.) The token needs the Models **or** the Agents service to reach the route, and then the service of what it names.

- **A model** is translated to a chat completion, run through the same gateway as `/chat/completions` (quota, rate limits, guardrails, routing, usage rows under the route `responses`) and translated back, with `response.*` events when `stream: true`. It takes `input`, `instructions`, `text.format`, function `tools`, `tool_choice`, `temperature`, `top_p`, `max_output_tokens`, `reasoning.effort`, `metadata` and `stream`. Nothing is stored, so `previous_response_id`, `conversation` and `background` are refused with `400 unsupported_parameter` and `GET /responses/{id}` does not know the response.
- **An agent** runs its published version as a [run](/guide/agent-background-execution): `previous_response_id`, `background`, `service_tier`, streaming, `GET` and `cancel` all work, and a call past its wait window answers `202`. See [Agents API](/api/agents#invoke-an-agent-responses-api).

`GET /api/client/v1/models` lists the agents too (above), so an OpenAI-compatible client can pick one from its model dropdown.

## Where inference is observed

Operators monitor live inference through **Operate → Model Monitoring**. The page summarises every connected inference server, splitting them by status: `active`, `disabled`, or `errored`. From here you also wire up new self-hosted endpoints (vLLM, TGI, llama.cpp, Ollama) that don't fit the cloud-provider model.

![Inference monitoring](/screenshots/inference/01-inference-monitoring.png)

For per-call inspection — request body, completion, token usage, tool calls — open the **Logs** tab on a model's detail page in [Model Hub](/guide/model-hub#inspecting-a-model), or query [Agent Tracing](/guide/tracing) for the full trace timeline.

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
| `capabilities` | Context/output limits, modalities, reasoning, structured output, and tool-call support |
| `pricing` | Cost per 1M tokens (input/output) |
| `overrides` | Default parameters (temperature, maxTokens, etc.) |

## Error Handling

| Status | Meaning |
|--------|---------|
| 400 | Missing model key or invalid request body |
| 401 | Invalid or missing API token |
| 429 | Quota, rate limit, or budget exceeded |
| 500 | Provider/internal error (includes unresolved model, category mismatch, and circuit-breaker-open) |
