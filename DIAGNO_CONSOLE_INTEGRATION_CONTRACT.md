# Diagno ↔ Cognipeer Console Integration Contract

Audience: the developer of the new Diagno Fastify service implementing a `ConsoleClient`.
Scope: only what Diagno needs from Console. Everything here was read from Console's executable code
(file references in §10); where docs and code disagree, code wins and the mismatch is listed in §9.

Responsibility split: **Diagno decides what work happens and when. Console executes the AI work.**
Console never talks to Jira, Confluence, ELK or Conviva directly.

---

## 0. Conventions

- Base URL (Digiturk): `https://console.aws-eks-prod.devops.digiturk.net` (internal load balancer).
- All client endpoints live under `/api/client/v1/...`. (The Fastify plugins register them as
  `/client/v1/...` and the `/api` prefix is applied by the server. Always call the `/api/client/v1/...` form.)
- Auth on every call: `Authorization: Bearer <API token>`. A token is bound to one **tenant + project**; every
  resource (agents, runs, knowledge modules/documents, MCP servers) is resolved inside that project.
  `401` = missing/invalid token, `403` = token not allowed for the resource.
- Request/response bodies are JSON. Timestamps in the Agent Run API are Unix **seconds**; elsewhere ISO strings.
- Never log tokens, `callback_secret`, or full model payloads.

---

## 1. Agent invocation contract

`POST /api/client/v1/agents/responses`

Runs the **published** version of an agent (this is the one Diagno uses). `POST /api/client/v1/responses`
takes the same body but runs the *draft* unless `version` is given; do not use it from production code.

| Body field | Type | Notes |
|---|---|---|
| `model` | string, **required** | The **agent key** (not an LLM model). Unknown key → `404`; agent not `active` → `400`. |
| `input` | string \| array | A string, or an array of messages (the last `role: "user"` item is used). |
| `version` | integer | Pin a published version. Omit for the latest published. |
| `previous_response_id` | string | Continue a conversation: `resp_<conversationId>`, `resp_<runId>` or `run_<runId>`. Omit to start a **new conversation** (Diagno's normal case: one new conversation per analysis attempt). |
| `background` | boolean | `true` → background run (see §2). Header `X-Cognipeer-Background: true` is equivalent and takes precedence over the body. If neither is sent, the agent's `execution.defaultMode` decides (default `sync`). |
| `callback_url` | string | http(s), ≤ 2048 chars. Background only. See §3. |
| `callback_secret` | string | 16–256 chars. Requires `callback_url`. Enables HMAC signing. |
| `runtime_context` | object | Per-run context; headers in it are sealed at rest and erased when the run finalizes. |

Headers: `Authorization`, `Content-Type: application/json`, optional `Idempotency-Key` (background only), optional
`X-Cognipeer-Background`.

### Synchronous response (`200`)

OpenAI-Responses-shaped:

```jsonc
{
  "id": "resp_<conversationId>",
  "object": "response",
  "model": "<agentKey>",
  "status": "completed",            // or "incomplete" (a limit stopped the run) — see §4
  "output": [ /* OpenAI item array: reasoning + assistant "message" items with output_text */ ],
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 },
  "created_at": 1718409600,
  "previous_response_id": null,
  "version": 3,
  "output_parsed": { },             // ONLY when structured output is enabled and valid — §4
  "output_error": "…"               // ONLY when structured output is enabled and failed — §4
}
```

Sync calls have a hard server-side ceiling; if exceeded the call returns **`504`** with no run record.
**Diagno must use background mode** for Jira analysis (long-running, retriable, callback-driven).

Error shapes: run-related errors use `{ "error": { "type", "message", "code" } }`; some older errors use
`{ "error": "message" }`. Parse both.

---

## 2. Background run contract

### 2.1 Submit

```
POST /api/client/v1/agents/responses
Authorization: Bearer <token>
X-Cognipeer-Background: true            (or body "background": true)
Idempotency-Key: jira:<issueKey>:<revisionId>:attempt-<n>
```

| Status | Meaning | Diagno action |
|---|---|---|
| `202` | New run accepted, `status: "queued"`. | Persist `id` (`run_…`) and `conversation_id` **now**. |
| `200` | **Idempotent replay**: same `Idempotency-Key` and same request → the *existing* run is returned. | Treat as the same run; do not create a second job. |
| `409` `agent_run_conflict` | An active (`queued`/`running`) run already exists for this conversation (one active run per conversation). Only possible when `previous_response_id` is sent. | Do not retry blindly; reuse/poll the existing run or wait. |
| `409` `idempotency_key_conflict` | The same key was reused with a **different** request. | Bug in key construction. Generate a new attempt key. |
| `429` `rate_limit_error` / `agent_run_concurrency_limit` | Tenant or project concurrent-run cap (env caps `backgroundMaxConcurrentRunsPerTenant`/`PerProject`, or tenant quota `maxConcurrentAgentRuns`). | Bounded backoff with jitter; keep the Jira job `pending`. Do not spin. |
| `400` | Invalid body. Specific codes: `idempotency_key_sync_not_supported` (key sent without background), key > 255 chars, background disabled for the agent, invalid callback (incl. callback host not allowed — §7), agent not active. | Fix request; not retriable as-is. |
| `404` | Agent key not found in the token's project. | Configuration error. |

202/200 body (`agent.run`):

```jsonc
{
  "id": "run_<id>",
  "object": "agent.run",
  "status": "queued",
  "agent": "<agentKey>",
  "conversation_id": "<conversationId>",
  "created_at": 1718409600
  // plus callback { url, status, attempts, signed } when a callback was supplied
}
```

### 2.2 Idempotency — attempt-aware keys (required reading)

- A key is unique per tenant+project. The server stores `sha256({agentKey, conversationScope, userMessage, version})`.
- **Same key + same request → `200` with the old run, even if that run `failed`.** A retry that reuses the key
  therefore does *not* re-run anything.
- **Same key + different request → `409 idempotency_key_conflict`.**
- Therefore Diagno must build keys as `jira:<issueKey>:<revision>:attempt-<n>` and **increment `n` for every
  deliberate re-submission** (after a terminal `failed`/`canceled`, a `worker_lost`, or an `output_error` you decide
  to retry). Reuse the **same** key only to safely re-send the *same* submission after a network timeout where you do
  not know whether Console received it (that is exactly what makes the submit retry-safe).
- Persist the Jira job row *before* the submit (state `submitting`, with the key). After the response, store `runId`
  and `conversationId` in the same row.
- Replay is detected before a conversation is created, so replays leave no orphan conversations.

### 2.3 Poll (fallback)

`GET /api/client/v1/agents/runs/:runId` — accepts `run_<id>`, `resp_<id>` or the bare id. Scoped to the token's project.

```jsonc
{
  "id": "run_<id>",
  "object": "agent.run",
  "status": "queued | running | succeeded | failed | canceled",
  "agent": "<agentKey>",
  "conversation_id": "<conversationId>",
  "result": { /* present only when succeeded — same payload as the sync response, id "resp_<runId>" */ },
  "error": { "type": "…", "message": "…" },     // present when failed or canceled
  "created_at": 1718409600, "started_at": 1718409601, "completed_at": 1718409700,
  "cancel_requested_at": null,
  "max_duration_ms": 900000,
  "callback": { "url": "…", "status": "pending|delivered|failed", "attempts": 1, "signed": true }
}
```

- Terminal states: `succeeded`, `failed`, `canceled`. Poll with backoff (e.g. 5 s → 30 s) and stop at terminal.
- `failed` reasons (`errorReason` is visible in the callback data; the polled `error.message` carries the text):
  `precondition_failed` (agent deactivated/deleted or token revoked/expired after submit), `max_duration_exceeded`,
  `agent_error`, `worker_lost` (worker died; Console's reconciler failed it), `canceled_by_caller`.
- **`succeeded` ≠ usable.** A run can be `succeeded` with `result.output_error` (structured output failed) or
  `result.status = "incomplete"` (a step/token/time limit stopped the agent). Check both (§4).
- Run results are kept for a retention window (`runRetentionDays`); persist what you need on receipt.

### 2.4 Cancel

`POST /api/client/v1/agents/runs/:runId/cancel` → `200` (run object), `409 agent_run_already_terminal`, or `404`.
Canceling a `queued` run finalizes it at once and fires its `canceled` callback.

### 2.5 Timeouts

Effective background ceiling = `min(env AGENT_BACKGROUND_MAX_DURATION_MS, tenant quota, agent setting
execution.backgroundMaxDurationMinutes)`, reported as `max_duration_ms` on the run. When it elapses the run is
`failed` / `max_duration_exceeded`.

---

## 3. Callback contract

Console POSTs to `callback_url` (per request) — or the agent's default `execution.callbackUrl` when the request
has none — when a background run reaches a terminal state.

### 3.1 Request

```
POST <callback_url>
content-type: application/json
user-agent: cognipeer-agent-runs/1.0
x-cognipeer-event: agent_run.succeeded | agent_run.failed | agent_run.canceled
x-cognipeer-event-id: evt_<runId>_<event>          (stable across retries — use for dedupe)
x-cognipeer-signature: t=<unix-seconds>,v1=<hex>   (only when a secret is configured)
```

Body (the **raw bytes** are what is signed):

```jsonc
{
  "id": "evt_<runId>_<event>",
  "event": "succeeded | failed | canceled",
  "createdAt": "2026-06-14T10:00:00.000Z",
  "runId": "run_<id>",
  "conversationId": "<conversationId>",
  "data": { }
}
```

`data` by event:

| event | `data` |
|---|---|
| `succeeded` | `{ "result": <same object as GET run → result>, includes output_parsed/output_error }` — the callback **contains the full result**; no extra fetch needed. |
| `failed` | `{ "errorReason": "agent_error|worker_lost|precondition_failed|max_duration_exceeded", "message": "…" }` (`max_duration_exceeded` has `errorReason` only) |
| `canceled` | `{}` |

### 3.2 Signature verification (HMAC-SHA256)

`x-cognipeer-signature = "t=" + t + ",v1=" + hex(HMAC_SHA256(secret, t + "." + rawBody))`

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyConsoleSignature(
  rawBody: Buffer,            // the exact bytes received — register a raw-body parser in Fastify
  header: string | undefined,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;            // timestamp / replay window
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Rules:

- Verify against the **raw** body, never re-serialized JSON.
- The timestamp `t` is **regenerated on every retry attempt**, so a fixed tolerance (recommended 300 s) is safe even
  for the last retry.
- Replay protection: besides the window, dedupe on `x-cognipeer-event-id` (unique per run+event) — store it with the
  Jira job; a repeat is acknowledged `2xx` and ignored.
- If `callback_secret` was supplied at submit, **reject unsigned callbacks**.
- The secret is stored sealed in Console and never returned by any API; keep your own copy per run (or one per
  environment). 16–256 chars.

### 3.3 Delivery semantics

- Any `2xx` = delivered. **Any other final status, or a timeout, is a failure and is retried.** Redirects are followed with the same host checks per hop, so do not rely on them; answer directly.
- Console waits **10 s** per attempt, then retries. **5 attempts**, exponential backoff 2 s → 4 → 8 → 16 → 32 s.
  After that `callback.status = "failed"` — polling (§2.3) is the fallback, so keep a reconciler for runs that
  stay non-terminal in Diagno.
- Respond fast: validate signature, persist, `2xx`, process asynchronously.
- Delivery is at-least-once and may race with your polling. Make the transition **conditional and idempotent**:
  `UPDATE jira_jobs SET status=…, result=… WHERE id=$1 AND status IN ('submitted','running')`; zero rows updated
  means another path already finalized it — ack and stop.
- Callback URL must be reachable *from Console* and pass the outbound guard (§7).

---

## 4. Structured output contract

Configured on the agent: `config.structuredOutput = { enabled: true, name?, schema, strict? }`
(JSON-Schema draft-07 subset; a bare "any" schema counts as not configured; `strict` forbids extra properties and
requires all declared ones).

### 4.1 Field names — decision

The Responses body's top-level `output` is already the OpenAI **item array** and cannot carry a parsed object
without breaking existing clients. The agreed external names are therefore:

| Concept | Field | Location |
|---|---|---|
| Validated parsed object | **`output_parsed`** | `result.output_parsed` (run) · sync response top level · callback `data.result.output_parsed` |
| Parse/validation failure | **`output_error`** (string) | same three places |

(Internally these are the SDK's `result.output` / `result.outputError`; Console reuses the SDK validation and has no
second validation system.) Both fields are **additive and optional**; plain-text agents never carry them and
`output` (item array) / the assistant text are unchanged.

### 4.2 Semantics

| Situation | `output_parsed` | `output_error` | run `status` |
|---|---|---|---|
| Structured output enabled, valid | the object | absent | `succeeded` |
| Enabled, parse/validation/no-output/retries-exhausted | absent | message string | **`succeeded`** (check the field!) |
| Not enabled (plain text) | absent | absent | `succeeded` |
| Guardrail blocked the answer | absent | absent | `failed` (`agent_error`) |
| Limit hit before finishing | usually absent | possibly | `succeeded` with `result.status = "incomplete"` |

Diagno acceptance rule: `run.status === "succeeded"` **and** `result.status === "completed"` **and**
`output_error` absent **and** `output_parsed` present **and** it passes Diagno's own contract check (e.g. the same
JSON schema / zod/ajv in Diagno — a cheap second guard on the agreed contract, but *Console* is the primary
validator). Otherwise treat as a failed attempt → retry with `attempt-<n+1>` or mark the job failed. Do **not** fall
back to `JSON.parse` of the text answer as a primary path.

### 4.3 Caveats

- **Redaction:** the SDK warns that content redaction by `output.pre`/`preFinalAnswer` hooks does not rewrite the
  parsed object. If PII redaction applies to this agent, do not assume `output_parsed` was redacted.
- **DocumentDB:** run results are stored as JSON documents. Keep schema **property names free of `.` and a leading
  `$`**, which Mongo-compatible stores handle poorly in field names.
- A model-visible `schema` should include every field Diagno needs; `output_error` text is for logs, not for parsing.

---

## 5. Knowledge API contract (Knowledge Engine / RAG)

Base: `/api/client/v1/rag/...`. Console owns **chunking, embedding, vector upsert/search and optional reranking**
(`ragService.ts`). There is **no Confluence connector in Console**; Diagno sends clean text/Markdown.

### 5.1 One-time setup (a module per knowledge base)

A *module* must exist before ingest. Create once (by Diagno bootstrap or a human):

`POST /api/client/v1/rag/modules` → `201 { "module": {...} }`

Required: `name`, `embeddingModelKey`, `vectorProviderKey`, `vectorIndexKey`, `chunkConfig`.
Optional: `key`, `description`, `rerankerKey`, `rerankerOversample`, `defaultTopK`, `defaultMinScore`, `defaultFilter`,
`filterableFields`, `responseDetail` (`full|text`), `hybrid`, `isolateByModule`, `fileBucketKey`, `fileProviderKey`,
`metadata`.
Also: `GET /rag/modules`, `GET /rag/modules/:key`, `PATCH /rag/modules/:key` (+ `status: active|disabled`),
`DELETE /rag/modules/:key`.

**Vector index / S3 Vectors:** the client RAG API does **not** create vector providers or indexes;
`vectorIndexKey` must reference an existing vector index. For the new Knowledge Engine create a **new
Console-managed S3 Vectors index** (provider driver `aws-s3-vectors`; credentials `accessKeyId`/`secretAccessKey`;
settings `region` and `bucketName` or `bucketArn`) via Console's vector-provider management (dashboard, or the
`/api/client/v1/vector/providers/...` endpoints), and reference it from the module. **Do not point the module at the
legacy Diagno index.** Index dimension must match the embedding model.

### 5.2 Ingest — new page

`POST /api/client/v1/rag/modules/:key/ingest`

```jsonc
{
  "fileName": "confluence-<pageId>.md",   // REQUIRED, even for text. See dedupe note
  "content": "# Title\n…markdown…",       // text/Markdown; OR "data": "<base64>" for file bytes
  "contentType": "text/markdown",
  "metadata": { "source": "confluence", "pageId": "123", "version": 7, "spaceKey": "OPS", "url": "https://…" },
  "chunkConfig": { },                      // optional per-document override
  "async": true,                           // optional — recommended for Confluence batches
  "force": false                           // optional — bypass dedupe
}
```

- Sync (default): `201` after chunk+embed+upsert; document `status: "indexed"`.
- `async: true`: `202` immediately; status `pending` → `processing` → `indexed` | `failed`
  (queue `rag-ingest`, consumer concurrency `RAG_INGEST_CONCURRENCY`, default 2; one attempt — failure sets
  `failed` + `errorMessage`). **Accepted submit is not completion.**
- Response: `{ "document": { "_id": "<documentId>", "fileName", "status", "chunkCount", "errorMessage?", "metadata",
  "sourceHash", "createdAt", "updatedAt", "lastIndexedAt", … } }` (source text is omitted). **The document id is
  `document._id`.**
- No caller-supplied external/document id exists. Diagno stores `pageId → document._id`.
- **Dedupe:** the same `fileName` + same content hash + existing document already `indexed` returns the **existing**
  document untouched (no re-embed) unless `force: true`. Same `fileName` with **different** content creates a
  **new, additional** document — it does *not* replace the old one. So never use ingest to update a changed page;
  use §5.3.
- Errors: `400` missing `fileName` or both `content`/`data`; `500` for service errors — **including module not
  found or not `active`** (surfaced as a generic 500 error message, not 404).

### 5.3 Update — changed page

`POST /api/client/v1/rag/modules/:key/documents/:documentId` → `200 { "document": {...} }`

Body (all optional): `content` | `data`/`base64`, `fileName`, `contentType`, `metadata`, `chunkConfig`.
Re-chunks and re-embeds in place, keeping the same `documentId`. **Synchronous only** (no `async` flag): the call
can take as long as embedding the page, so use a generous client timeout and a bounded worker concurrency.
`404` if the document is not in this module/project; `400` invalid chunk config.

### 5.4 Delete — deleted page

`DELETE /api/client/v1/rag/modules/:key/documents/:documentId` → `200 { "success": true }`; `404` when missing
(treat `404` as "already deleted" for idempotency).

### 5.5 Status

- `GET /api/client/v1/rag/modules/:key/documents/:documentId` → `{ "document": {...} }`
- `GET /api/client/v1/rag/modules/:key/documents` → `{ "documents": [...] }`
- Status values (exact): `pending | processing | indexed | failed`. `failed` carries `errorMessage`.
- Also: `GET …/documents/:documentId/content` and `…/lines?offset&limit` (stored source text; `404` if unavailable).

Polling guidance: for `async` ingest, poll the single-document endpoint with backoff (e.g. 2 s → 30 s, cap the total
wait) until `indexed` or `failed`; record both in `confluence_documents.status`. A document stuck in
`pending`/`processing` beyond your cap should be re-checked on the next sync run rather than re-ingested blindly
(re-ingest of the same name+hash is deduped once indexed).

### 5.6 Query (optional for Diagno; the Agent normally retrieves itself)

`POST /api/client/v1/rag/modules/:key/query` `{ "query", "topK?", "minScore?", "filter?" }` →
`{ "result": { "matches": [{ "id", "score", "content", "metadata", "documentId", "fileName", "chunkIndex", … }],
"query", "ragModuleKey", "latencyMs" } }`. There is **no per-request rerank flag**; reranking follows the module's
`rerankerKey`.

### 5.7 Limits

No RAG-specific rate limit, quota or max document size was found in Console code. Reverse-proxy/body limits and
embedding-provider limits were **not verified** — keep each Markdown payload reasonable and let Console chunk it.

### 5.8 Binding the knowledge module to the Agent

Set `config.knowledgeEngineKey = "<module key>"` on the agent (see §6.4). The agent then gets a retrieval tool.

---

## 6. MCP registration / binding contract

Diagno hosts **one** remote MCP server exposing `elk_search` and `conviva_search`. Console registers it and binds
those tools to the Jira Analysis Agent. (Console contains no ELK/Conviva client.)

### 6.1 Transport & wire behavior

- Register with `transport: "streamable-http"`. Console's client is **stateless JSON-RPC over HTTP POST** to the
  single URL: `initialize` (failure tolerated), `tools/list`, `tools/call`. Request header
  `Accept: application/json, text/event-stream`; Diagno may answer with plain JSON or a single SSE-framed response.
- Do **not** require MCP session ids / `Mcp-Session-Id` handshakes, server-initiated messages, or the legacy
  two-endpoint SSE protocol — they are not implemented. (`sse` is accepted as a value but behaves as plain POST.)
- Console identifies as `clientInfo { name: "cognipeer-mcp-gateway", version: "1.0.0" }`; no custom `User-Agent`.
- Diagno's tool result: return normal MCP `content`; `isError: true` is surfaced to the agent as a tool error.
  HTTP errors reach the agent with status + up to 500 chars of body — never put secrets in error bodies.

### 6.2 Auth to the remote MCP

`upstreamAuth.type` ∈ `none | token | header | basic` (OAuth is **not** supported).

| type | Sent as |
|---|---|
| `token` | `Authorization: Bearer <token>` |
| `header` | the configured header name/value verbatim |
| `basic` | `Authorization: Basic base64(user:pass)` |

Secrets are sealed (AES-256-GCM) at rest in Console. Use `token` or `header` with a Diagno-issued service secret;
Diagno must validate it on every MCP request.

### 6.3 Registration API (token-authenticated)

| Op | Request |
|---|---|
| Create | `POST /api/client/v1/mcp` → `201 { "server": {...} }` |
| Update | `PATCH /api/client/v1/mcp/:serverKey` → `200 { "server" }` |
| Delete | `DELETE /api/client/v1/mcp/:serverKey` → `200 { "success": true }` |
| Refresh tools | `POST /api/client/v1/mcp/:serverKey/refresh-tools` → `200 { "server" }` |

Create body:

```json
{
  "name": "Diagno",
  "key": "diagno",
  "sourceType": "remote",
  "remoteConfig": { "url": "https://<diagno-internal-host>/mcp", "transport": "streamable-http" },
  "upstreamAuth": { "type": "token", "token": "<secret>" }
}
```

Required: `name`, `sourceType: "remote"`, `remoteConfig.url`, `upstreamAuth.type`. Optional: `key`, `description`,
`exposure`, guardrail fields. Update also accepts `status`, `runtimeHeaders`, `disabledTools`, `toolAnnotations`,
`toolDescriptions`. There is no token-authenticated *list* endpoint for MCP servers (dashboard `GET /api/mcp` is
session-authenticated); `GET /api/client/v1/mcp/:serverKey/execute` lists the tools of one server through the
gateway.

### 6.4 Discovery / refresh

- Tool discovery = `initialize` + `tools/list`, run on create and on `POST …/refresh-tools`. Results are stored on
  the server record (`tools`, `toolsDiscoveredAt`). **There is no periodic refresh** — whenever Diagno's MCP tool
  list or schemas change, call `refresh-tools`.
- Tool names are stored and exposed to the model **verbatim** (`elk_search`, `conviva_search`); no prefix is
  added for a single server (prefixing happens only for composite servers).
- A tool bound to an agent but absent from the stored `tools` list is **silently skipped** (log warning only). Always
  `refresh-tools` and verify before binding/publishing.

### 6.5 Binding to the Agent

Via `POST/PATCH /api/client/v1/agents[/:agentKey]` → `config.toolBindings`:

```json
{
  "config": {
    "modelKey": "<llm model key>",
    "systemPrompt": "…",
    "knowledgeEngineKey": "<rag module key>",
    "toolBindings": [
      { "source": "mcp", "sourceKey": "diagno", "toolNames": ["elk_search", "conviva_search"] }
    ],
    "structuredOutput": { "enabled": true, "name": "jira_analysis", "strict": true, "schema": { } },
    "execution": { "backgroundEnabled": true, "defaultMode": "background", "backgroundMaxDurationMinutes": 15 }
  }
}
```

`toolNames` is a per-tool allow-list. The agent must be **published** to be invoked through
`/agents/responses`: `POST /api/client/v1/agents/:agentKey/publish` → `201 { "version": n }`, and `status: active`.
A `tool_access` guardrail on the agent or server can deny MCP calls; if one is configured, allow
`diagno/elk_search` and `diagno/conviva_search`.

### 6.6 Call timeout, retries, headers

- Per-call HTTP timeout = `OUTBOUND_HTTP_DEFAULT_TIMEOUT_MS` (default **30 s**, global — not MCP-specific).
  Diagno's tools must answer within it (ELK/Conviva queries need their own tighter internal timeouts and bounded
  result sizes).
- No MCP-specific retry loop or circuit breaker was found in the remote MCP client. Tool calls are not
  automatically retried by the MCP client; make tools idempotent/read-only.
- No max response-size constant was verified: cap tool output size on the Diagno side.
- Forwarding of run `runtime_context` headers to the MCP server is opt-in per server
  (`runtimeHeaders: { allow: true, allowedNames: [...] }`) and applied **after** the static auth headers, so a
  forwarded header can override them — do not allow `authorization`.

### 6.7 Observability

MCP requests are logged per server (dashboard MCP monitor/audit; aggregate error rate/latency). Agent tracing
records the tool names used per run. Whether raw tool arguments/results are always persisted in tracing was not
verified — do not assume it. Token/cost/trace data lives in Console only (Diagno must not rebuild it).

---

## 7. Network / outbound restrictions (for SCM)

Console's outbound calls to tenant-configured URLs (**agent callbacks, remote MCP, rerankers, tools, connected agents,
webhooks**) go through an SSRF guard (`safeFetch` / `assertPublicUrl`). By default it **rejects** hosts that resolve
to loopback, RFC1918 private, link-local, CGNAT or metadata ranges, hosts ending in `.local`/`.internal`, and
hosts whose DNS fails; it re-checks every redirect hop. `http://` is permitted by the guard, but use `https://`.

The callback URL is checked **at submit** (`400`) and again at delivery; the MCP URL at call time.

| Env var (Console) | Meaning | Default |
|---|---|---|
| `OUTBOUND_HTTP_ALLOWED_HOSTS` | Comma-separated **hostnames** exempt from the private-network block. Exact name (`diagno.internal.digiturk.net`) or leading-dot suffix (`.digiturk.net`). **No CIDR, no ports.** | empty |
| `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK` | Master switch. Prefer the allow-list; do not disable globally. | `true` |
| `OUTBOUND_HTTP_DEFAULT_TIMEOUT_MS` | Timeout for guarded outbound calls (MCP calls). | `30000` |

**SCM requirements (do not edit Helm from application work; request via `scm-devops`):**

1. Add the Diagno callback host and the Diagno MCP host to `OUTBOUND_HTTP_ALLOWED_HOSTS` on the Console deployment
   (they are private/internal Digiturk hosts).
2. Network path: Console pods → Diagno callback + MCP endpoints (HTTPS port in use); Diagno → Console
   `console.aws-eks-prod.devops.digiturk.net` (HTTPS, via the internal load balancer).
3. Console pods → DocumentDB on TCP 27017 (Console persistence; **separate** from Diagno's PostgreSQL).
4. Diagno's TLS chain must be trusted by Console's Node runtime (private CA → `NODE_EXTRA_CA_CERTS` on Console) —
   needs confirmation by SCM.

DocumentDB notes (code evidence, not a live test): connection is configured purely through `MONGODB_URI` +
`MONGODB_*` pool/timeouts, with `DB_PROVIDER=mongodb`. TLS/CA/`replicaSet`/`retryWrites` options therefore belong in
the URI; DocumentDB does not support retryable writes, so the URI is expected to carry `retryWrites=false` (AWS
DocumentDB requirement — **verify with SCM**; Console code does not set it). The AgentRun path was written to avoid
depending on partial unique indexes (it uses lock documents; the partial index is a best-effort extra and failure to
create it only logs a warning), which is the relevant Mongo-compatibility risk and is handled.

---

## 8. IDs Diagno must persist

| ID | From | Store in | Used for |
|---|---|---|---|
| `runId` (`run_<id>`) | 202/200 submit `id`; callback `runId` | `jira_jobs.console_run_id` | poll, cancel, correlate callbacks; unique per attempt |
| `conversationId` | submit `conversation_id`; callback `conversationId` | `jira_jobs.console_conversation_id` | Console tracing correlation; optional follow-ups via `previous_response_id: "resp_<conversationId>"` |
| `Idempotency-Key` | built by Diagno | `jira_jobs.idempotency_key` (+ `attempt`) | safe re-submit; never reuse for a deliberate re-run |
| callback `x-cognipeer-event-id` | callback header/body `id` | `jira_jobs.last_callback_event_id` | replay/duplicate protection |
| `documentId` (`document._id`) | ingest response | `confluence_documents.console_document_id` | update/delete/status |
| RAG module `key` | Console setup | config | all knowledge calls |
| Agent key + published `version` | Console setup / `result.version` | config / `jira_jobs` | audit which agent version analyzed the issue |
| Confluence page version/hash, ingest `status`, `errorMessage` | Diagno / document | `confluence_documents` | change detection, state tracking |

Persist the job row in state `submitting` **before** calling Console, then `submitted` with `runId` +
`conversationId`; only then count the run as in flight.

---

## 9. Doc/code mismatches and open items

1. **`output` / `outputError` naming (brief) vs. API:** top-level `output` is the OpenAI item array, so the parsed
   result is exposed as `output_parsed` / `output_error` (agreed with the product owner).
2. **Structured output was dropped by `executeAgentChatLocal`** (live path); the playground path already handled it.
   Fixed in `agentService.ts`; background `run.result`, status, sync body and callback now carry the fields.
3. `docs/guide/agent-background-execution.md` is a design document; the "Status response shape (draft)" there is
   simplified. The runtime shape is the one in §2.3 (code wins).
4. Ingest/re-ingest report "module not found / not active" as **500**, not 404/409.
5. Ingest dedupes by `fileName`+hash; a changed page under the same `fileName` becomes a *second* document unless
   Diagno calls the update endpoint (§5.3).
6. Not verified: global request body limits, RAG size limits, MCP response-size limits, whether tracing stores raw
   MCP arguments/results, Console trust of Diagno's private CA, DocumentDB `retryWrites`/TLS URI in the Digiturk
   deployment.
7. `x-cognipeer-signature` carries no key id; rotate the secret by supplying a new `callback_secret` on new runs
   (in-flight runs keep their sealed secret).

---

## 10. Source references (Console repo)

- Agent responses / runs routes: `src/server/api/plugins/client-agents.ts`, `client-agent-runs.ts`
- Run lifecycle, idempotency, callback signing/delivery: `src/lib/services/agents/agentRunService.ts`
- Response shape and structured output: `src/lib/services/agents/agentService.ts`
  (`AgentChatResponse`, `toAgentChatResponse`, `executeAgentChatLocal`)
- Structured output config: `src/lib/services/agents/agentRuntimeConfig.ts` (`resolveStructuredOutputSchema`)
- Knowledge: `src/server/api/plugins/client-rag.ts`, `src/lib/services/rag/ragService.ts`, `ragIngestJob.ts`
- S3 Vectors provider: `src/lib/providers/contracts/awsS3Vectors.contract.ts`
- MCP: `src/server/api/plugins/client-mcp.ts`, `src/lib/services/mcp/remoteMcpClient.ts`,
  `src/lib/database/provider/types.extended.ts` (`IMcpServer`)
- Agent config / bindings: `src/lib/database/provider/types.domain.ts` (`IAgentConfig`, `IAgentToolBinding`)
- Outbound guard: `src/lib/security/outboundFetch.ts`, `src/lib/core/config.ts`, `docs/guide/configuration.md`
- Tests: `src/__tests__/unit/agent-structured-output-response.test.ts`,
  `src/__tests__/integration/agent-run-background-execution.test.ts`
