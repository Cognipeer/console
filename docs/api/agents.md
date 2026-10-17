# Agents API

Manage and invoke AI agents via the client API. Agents combine a model, system prompt, tools, guardrails, and Knowledge Engine modules into a single deployable unit.

## List Agents

```
GET /api/client/v1/agents
```

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by status: `active`, `inactive`, `draft` |

### Response

```json
{
  "agents": [
    {
      "key": "support-bot",
      "name": "Support Bot",
      "description": "Customer support agent",
      "config": {
        "modelKey": "gpt-4o",
        "temperature": 0.7,
        "topP": 1,
        "maxTokens": 4096
      },
      "status": "active",
      "createdAt": "2026-01-15T10:00:00.000Z"
    }
  ]
}
```

## Get Agent

```
GET /api/client/v1/agents/:agentKey
```

### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentKey` | string | Yes | Unique agent key |

### Response

```json
{
  "agent": {
    "key": "support-bot",
    "name": "Support Bot",
    "description": "Customer support agent",
    "config": {
      "modelKey": "gpt-4o",
      "temperature": 0.7,
      "topP": 1,
      "maxTokens": 4096,
      "showReasoning": true
    },
    "status": "active",
    "createdAt": "2026-01-15T10:00:00.000Z",
    "input_schema": null,
    "output_schema": null,
    "attachments": {
      "enabled": true,
      "max_files": 10,
      "max_file_size_mb": 20,
      "allowed_mime_types": [],
      "accepts_images": true,
      "outputs": { "enabled": true, "max_files_per_turn": 10, "max_file_size_mb": 2, "types": ["md", "csv", "txt", "json", "html", "xml", "yaml", "yml"] }
    }
  }
}
```

`input_schema` and `output_schema` describe the agent as a typed function: the JSON Schema of the `inputs` it takes (`null` when it declares none) and of its structured answer (`null` for a plain-text agent). `attachments` is present when the agent can take files, and its `outputs` says whether the agent can [write files](/guide/session-files#files-the-agent-produces) for the person. `attachments.accepts_images` is `true` only while uploads are on and the bucket can take a file **and** the agent's model reads images, so it is `false` whenever uploads are off. The example shows exactly what the route returns; `models` is added when the agent offers more than one model, and nothing else (the older `experience` block is not part of this response).

## Invoke an agent (Responses API)

An agent is called with the OpenAI Responses format, on the same route as a model:

```
POST /api/client/v1/responses          # models and agents
POST /api/client/v1/agents/responses   # agents only (the same call)
```

`model` names the target. `agent:<key>` is always an agent. A bare name is a **model** of the project first, then an agent of the project, and `404 model_not_found` when it is neither. On `/agents/responses` the name is always an agent key.

Both routes run the agent's **published version** by default (the draft while nothing is published). `"version": 3` pins a published version; `"version": "draft"` runs the draft.

A token needs the Models **or** the Agents service for `/responses`, and then the service of what it names: Agents for an agent, Models for a model (`403 permission_error` otherwise). `/agents/responses` needs Agents.

### Request

```json
{
  "model": "agent:support-bot",
  "input": "How do I reset my password?",
  "previous_response_id": null,
  "version": 3
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | The agent (`agent:<key>` or its key) or a model key |
| `input` | string \| array | Yes | The user message: a string or Responses input items. The last user message is the turn |
| `previous_response_id` | string | No | The `id` of an earlier response of this agent: continues its session |
| `session_id`, `conversation` | string | No | Continue that session directly (the same as `previous_response_id`) |
| `version` | number \| `"draft"` | No | A published version, or the draft. Anything else is `400 invalid_version`; a version that does not exist is `404 version_not_found` |
| `stream` | boolean | No | Server-Sent Events, see [Streaming](#streaming) |
| `background` | boolean | No | Queue the run and answer `202` at once (also the `X-Cognipeer-Background: true` header). Streamed with `background: true`, a disconnect does not stop the run |
| `service_tier` | string | No | `flex` queues the run in the low-priority [class](/guide/agent-background-execution#run-classes) and waits for it like a plain call. Anything else is the default class |
| `text.format` | object | No | Structured output for this call, see [below](#typed-inputs-and-structured-output) |
| `inputs` | object | No | Values for the agent's declared inputs (an extension) |
| `metadata` | object | No | Up to 16 string pairs kept on the run |
| `reasoning.effort`, `agent_model` | string | No | Reasoning effort, and one of the agent's additional models. The effort applies to a run that executes in the request (a waited call, a stream); a queued run (`background: true`, `service_tier: "flex"`) uses the agent's own effort |
| `callback_url`, `callback_secret` | string | No | A [callback](/guide/agent-background-execution#callbacks-and-webhooks) for a run that nobody is waiting on |
| `budget` | object \| null | No | Spend budget for the session this request starts: `{ "max_cost_usd": 2, "on_reach": "pause" }`. See [Session budgets](/guide/agent-session-budgets) |
| `runtime_context`, `include_reasoning` | | No | Runtime context for the agent's tools; `false` hides reasoning from the output |
| `Idempotency-Key` (header) | string | No | A retry with the same key returns the stored run instead of starting a second one |

`store` is accepted and ignored (a run is always kept). The agent's own configuration decides `instructions`, `temperature`, `top_p`, `max_output_tokens`, `tools`, `tool_choice`, `parallel_tool_calls` and `truncation`: they are ignored and named in the `X-Cognipeer-Ignored-Params` response header. An input part the agent cannot take (for example `input_audio`) is `400 unsupported_content_part`.

### Input Formats

**Simple string:**

```json
{
  "model": "support-bot",
  "input": "Hello, I need help"
}
```

**Message array:**

```json
{
  "model": "support-bot",
  "input": [
    {
      "role": "user",
      "content": "Hello, I need help"
    }
  ]
}
```

**Structured content array:**

```json
{
  "model": "support-bot",
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Hello, I need help" }
      ]
    }
  ]
}
```

**With files** (`input_file`, `input_image`; see [Session files](/guide/session-files)):

```json
{
  "model": "support-bot",
  "previous_response_id": "resp_64a1b2c3d4e5f6",
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Compare these" },
        { "type": "input_file", "file_data": "data:application/pdf;base64,…", "filename": "a.pdf" },
        { "type": "input_file", "file_url": "https://example.com/report.pdf" },
        { "type": "input_image", "image_url": "https://example.com/cat.png" }
      ]
    }
  ]
}
```

All the `input_text` parts of the last user message are joined with a blank line. An `http(s)` `file_url` or `image_url` is fetched by the server (private addresses are refused) within the agent's size limit, and it has to arrive within the outbound timeout (30 seconds by default, one deadline for the headers and the body together): a file that does not is `400 attachment_unreachable`.

### Response

```json
{
  "id": "resp_6710c3d4e5f6a7b8c9d0e1f2",
  "object": "response",
  "model": "agent:support-bot",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "To reset your password, go to Settings > Security..."
        }
      ]
    }
  ],
  "output_text": "To reset your password, go to Settings > Security...",
  "status": "completed",
  "usage": {
    "input_tokens": 12,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens": 45,
    "output_tokens_details": { "reasoning_tokens": 0 },
    "total_tokens": 57
  },
  "created_at": 1709500000,
  "previous_response_id": null,
  "conversation": { "id": "6f1c…" },
  "metadata": {},
  "text": { "format": { "type": "text" } },
  "service_tier": "default",
  "background": false,
  "cognipeer": { "run_id": "run_6710c3d4e5f6a7b8c9d0e1f2", "session_id": "6f1c…" }
}
```

`usage` always carries the two detail objects, `0` when a detail was not reported (`reasoning_tokens` is `0` for an agent run). The `id` is the run's (`resp_<runId>`; the [runs API](/guide/agent-background-execution#the-runs-api) names the same run `run_<runId>`), so every call has its own id. `cognipeer.session_id` is the session to continue.

| `status` | When |
|----------|------|
| `queued` | Accepted, waiting for a worker or its start time |
| `in_progress` | Running |
| `completed` | Finished |
| `incomplete` | A run limit, a cancellation with a partial answer or the session budget ended the turn before a final answer (`stop_reason` and `incomplete_details.reason` say which) |
| `failed` | The run failed (`error`) |
| `cancelled` | The run was [cancelled](#cancelling) |
| `requires_action` | Paused for an approval or an answer, see below |

**HTTP status.** `200` when the response is final (or a replay of one). `202` when the run is still going: the call waited for its [window](/guide/agent-background-execution#the-wait-window) without an answer (`status: "in_progress"`), or `background: true` queued it (`status: "queued"`). The `202` carries `Location` (the run on the runs API) and `Retry-After`. Follow it with:

```
GET  /api/client/v1/responses/{id}          # the Response object, current
POST /api/client/v1/responses/{id}/cancel   # cancel it, answers the Response object
```

(also under `/agents/responses/{id}`). An unknown id is `404 response_not_found` in OpenAI's error envelope; `background` reads back what the request asked for: `true` for a run that was started with `background: true`, streamed or not; a `service_tier: "flex"` call is queued but reads `false`. A body that is not a JSON object is `400 invalid_json`. A waited call whose run was ended elsewhere (the server shut down, the worker was lost) answers `503 agent_run_interrupted`, never a partial answer as if it were final. A finished response is answered `200` by `cancel` with its final object.

### Streaming

`"stream": true` answers with the OpenAI Responses events, `event: <type>` and `data: {…}` each with a `sequence_number`: `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta` (the answer as it is written), `response.output_text.done`, `response.content_part.done`, `response.output_item.done`, the `response.reasoning_summary_*` events when the agent shows its reasoning, and one of `response.completed`, `response.incomplete` (also how a cancelled run ends) or `response.failed`; a failure before the stream opens is a normal error: the active-run caps and the agent quota are checked first, so over a limit the answer is a plain JSON `429` with `Retry-After` (30 seconds for the cap, 60 for the quota) and no session is created. A limit reached in the instant between that check and the run's start, and a run that is ended elsewhere (shutdown, lost worker: `agent_run_interrupted`), end the open stream with an `error` event. A `: ping` comment keeps the connection alive. If the reader goes away the run stops, unless the request said `background: true`.

A model target streams the model's own chunks as the same events.

### Models on `/responses`

A request whose `model` is a model of the project is translated to a chat completion and goes through the same gateway as [`/chat/completions`](/guide/inference) (quota, guardrails, routing, usage) and back. It takes `input` (text and image parts; function calls and their outputs), `instructions`, `text.format`, function `tools` and `tool_choice`, `temperature`, `top_p`, `max_output_tokens`, `reasoning.effort`, `metadata` and `stream`. Nothing is stored: `GET /responses/{id}` of it is `404`, and `previous_response_id`, `conversation`, `background` and built-in tool types are `400 unsupported_parameter`.

### Waiting for an approval or an answer

An agent with [approvals & questions](/guide/agent-approvals) can pause. The response then has `status: "requires_action"`, `stop_reason: "requires_action"` and the requests to answer in `required_action`:

```json
{
  "id": "resp_6710c3d4e5f6a7b8c9d0e1f2",
  "object": "response",
  "status": "requires_action",
  "stop_reason": "requires_action",
  "required_action": {
    "type": "agent_actions",
    "actions": [
      { "id": "act_0123456789abcdef01234567", "kind": "tool_approval", "tool_name": "sandbox_exec", "args": { "command": "ls" }, "status": "pending" }
    ]
  }
}
```

Answer with `POST /api/client/v1/agents/sessions/{conversationId}/actions/{actionId}` (the session id is `cognipeer.session_id`; the run's own `POST /agents/runs/{runId}/actions/{actionId}` does the same). An agent that does not use these features never returns this status.

### Typed inputs and structured output

An agent can declare **inputs**, typed arguments of a call (**Configure → Inputs**: a name, a type of `string`, `number`, `integer`, `boolean` or `json`, a label, an enum, a default, required or not; up to 32 of them). A request sends values in `inputs` (the runs API, `/responses`, chat completions, A2A data parts and routines all take them); they are checked (`400 invalid_inputs` with `errors: [{ field, message }]`, each string at most 8 KiB, all of them at most 32 KiB), defaults are applied, and the turn gets them as the prompt variables <span v-pre>`{{input.<name>}}`</span> and as an `Inputs` JSON block after the user message. `GET /agents/{key}` publishes them as `input_schema`.

A call can ask for **structured output** instead of free text, in each API's own spelling:

| API | Field |
|-----|-------|
| Responses | `text.format`: `{ "type": "json_schema", "name": "ticket", "schema": {…}, "strict": true }` or `{ "type": "json_object" }` |
| Chat completions | `response_format` (the OpenAI shape); `message.content` is then the JSON text |
| Runs API and routines | `response_format`: `{ "type": "json_schema", "json_schema": { "name", "schema", "strict" } }` |
| A2A | A `data` artifact with the parsed object |

It replaces the agent's own structured-output setting (**Configure → Output**) for that call. A schema the platform cannot enforce is `400 invalid_response_format`. The parsed object comes back as `output_parsed` (runs API, Responses), or `output_error` when the answer did not validate: the run still succeeded, so check it.

### Sessions

The conversation a response belongs to is a session. Besides the Responses call, it has its own endpoints:

| Endpoint | |
|----------|---|
| `GET /agents/sessions/{conversationId}` | Runtime state: `idle`, `running`, `requires_action` or `budget_paused`; the pending requests; budget and spend |
| `PATCH /agents/sessions/{conversationId}` | Set, raise or remove the [spend budget](/guide/agent-session-budgets); continues a session paused on it |
| `POST /agents/sessions/{conversationId}/cancel` | [Cancel](#cancelling) whatever the session is doing |
| `GET /agents/sessions/{conversationId}/events` | The [event log](/guide/agent-session-events) (poll) |
| `GET /agents/sessions/{conversationId}/events/stream` | The event log as Server-Sent Events, resumable with `Last-Event-ID` |
| `POST /agents/sessions/{conversationId}/actions/{actionId}` | Answer an [approval or question](/guide/agent-approvals) |
| `POST`, `GET /agents/sessions/{conversationId}/files`, `GET …/files/{fileId}/content`, `DELETE …/files/{fileId}` | [Session files](/guide/session-files) |

[Webhooks](/guide/webhooks) (`/webhooks`) notify your service when a session goes idle, needs an answer, reaches its budget or a run finishes. Field names of these endpoints are `snake_case`. The full request and response shapes are in the [OpenAPI spec](/api/openapi).

### Multi-Turn Conversations

Use `previous_response_id` to continue a conversation:

```json
{
  "model": "support-bot",
  "input": "Can you elaborate on the security settings?",
  "previous_response_id": "resp_6710c3d4e5f6a7b8c9d0e1f2"
}
```

The id resolves to the run, and the run to its session, so the history is rebuilt from the session. Ids of the form `resp_<sessionId>` (from earlier releases) still work. A `previous_response_id` of another agent or project is `404`.

## Runs, routines and cancelling

| | |
|---|---|
| **Runs API** | `POST /agents/{agentKey}/runs` starts a run (async-first, `wait`, `class`, `run_at` / `delay_seconds`, `callback`, `metadata`, `response_format`, `stream`); `GET /agents/runs` lists them, `GET /agents/runs/{runId}` reads one (`?wait=`), `GET /agents/runs/queue` shows the queue, `…/events` and `…/events/stream` follow it, `…/actions/{actionId}` answers it. See [Agent runs](/guide/agent-background-execution). |
| **Routines** | `…/agents/{agentKey}/routines` (list, create, get, update, delete, `…/run`, and for webhook routines `…/webhook/rotate-secret` and `…/deliveries`). See [Agent routines](/guide/agent-routines). |
| **Models** | `GET /models` lists the project's models and its active agents (`agent:<key>`); a token with only the Agents service lists the agents alone. See [Inference](/guide/inference#model-discovery). |
| **A2A** | `POST /a2a/{agentKey}`: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`. A run that was canceled answers a Task `canceled`, one that failed after it started (the quota refusal, a request that is still pending) a Task `failed` with `metadata.errorType` / `errorCode`; `tasks/cancel` of a task that cannot be canceled is `-32002`. The public route (`/api/public/a2a/{tenantId}/{slug}`) binds a task to its caller: the ids are `run_<runId>.<nonce>` and `<sessionId>.<nonce>`, to be handed back whole (see the OpenAPI description). See [Approvals](/guide/agent-approvals#background-runs-and-a2a) and [Session files](/guide/session-files#files-the-agent-produces). |

### Cancelling

One meaning on four routes: `POST /agents/runs/{runId}/cancel`, `POST /agents/sessions/{sessionId}/cancel`, `POST /responses/{id}/cancel` and A2A `tasks/cancel`. A queued or scheduled run is cancelled at once, a running one stops before its next step, a run that waits for an approval is ended and its requests cancelled. Details are in [Agent runs](/guide/agent-background-execution#cancel).

## Agent Features

Agents configured in the dashboard can include:

| Feature | Description |
|---------|-------------|
| **System Prompt** | Base instructions for the agent |
| **Tools** | Bound tools from the unified tool system or MCP servers |
| **Guardrails** | Input/output validation rules |
| **Knowledge Engine Modules** | Retrieval-augmented generation sources |
| **Temperature / Top-P** | Model parameter overrides |
| **Max Tokens** | Output length limit |
| **Versioning** | Publish and pin specific agent configurations |

## Errors

| Status | Description |
|--------|-------------|
| 400 | A malformed field (the `code` says which: `invalid_json` for a body that is not a JSON object, `invalid_version`, `attachment_unreachable`), a missing `model` or `input`, or the agent is not active |
| 401 | Invalid API token |
| 402 | The session has reached its spend budget (`budget_reached`) |
| 403 | The token's owner lacks the service the target needs, or may not touch the session (`session_forbidden`) |
| 404 | Agent, run, response or version not found, or `previous_response_id` references another agent's session |
| 409 | Another run is active for the conversation (`agent_run_conflict`), the session waits for an approval or an answer (`pending_action`), or the `Idempotency-Key` belongs to another request (`idempotency_key_conflict`) |
| 429 | The run cap (`agent_run_concurrency_limit`, `Retry-After: 30`), the tenant's spend limit (`spend_limit_exceeded`) or its quota (`agent_quota_exceeded`, `Retry-After: 60`) is used up |
| 500 | Internal error during agent execution |
| 503 | The permission engine could not decide (`authorization_unavailable`), or the run a call waited on was ended elsewhere before it finished (`agent_run_interrupted`, retryable) |

The runs, sessions and routines APIs answer `{ "error": { "type", "message", "code" } }`; the OpenAI routes use OpenAI's envelope with `param`. The full list for runs is in [Agent runs](/guide/agent-background-execution#errors).
