# API Reference Overview

The Cognipeer Gateway exposes an OpenAI-compatible client API surface under `/api/client/v1/`. All client endpoints use Bearer token authentication.

## Base URL

```
https://your-gateway.example.com/api/client/v1
```

## Authentication

All client API endpoints require a Bearer token in the `Authorization` header:

```bash
curl -X POST https://gateway.example.com/api/client/v1/chat/completions \
  -H "Authorization: Bearer cgt_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]}'
```

Tokens are created in the dashboard under **Settings → API Tokens**.

## Endpoint Map

| Domain | Base Path | Methods |
|--------|-----------|---------|
| [Chat Completions](./chat-completions) | `/chat/completions` | POST |
| [Embeddings](./embeddings) | `/embeddings` | POST |
| [Agents](./agents) | `/agents` | GET |
| [Agent Detail](./agents) | `/agents/:agentKey` | GET |
| [Agent Responses](./agents) | `/responses` | POST |
| [Tools](./tools) | `/tools` | GET |
| [Tool Detail](./tools) | `/tools/:toolKey` | GET |
| [Tool Execute](./tools) | `/tools/:toolKey/actions/:actionKey/execute` | POST |
| [MCP Execute](./mcp) | `/mcp/:serverKey/execute` | GET, POST |
| [MCP SSE](./mcp) | `/mcp/:serverKey/sse` | GET |
| [MCP Message](./mcp) | `/mcp/:serverKey/message` | POST |
| [Vector Providers](./vector) | `/vector/providers` | GET, POST |
| [Vector Indexes](./vector) | `/vector/providers/:key/indexes` | GET, POST, PATCH, DELETE |
| [Tracing (Custom)](./tracing) | `/tracing/sessions` | POST |
| [Tracing (OTLP)](./tracing) | `/traces` | POST |
| [Files](./files) | `/files/buckets` | GET, POST |
| [Guardrails](./guardrails) | `/guardrails/evaluate` | POST |
| [Prompts](./prompts) | `/prompts` | GET, POST |
| [RAG](./rag) | `/rag/modules` | GET, POST, DELETE |
| [Memory](./memory) | `/memory/stores` | GET, POST, PATCH, DELETE |
| [Config Groups](./config) | `/config/groups` | GET, POST |
| [Config Group Items](./config) | `/config/groups/:groupKey/items` | GET, POST |
| [Config Item](./config) | `/config/items/:key` | GET, PATCH, DELETE |
| [Config Resolve](./config) | `/config/resolve` | POST |
| [Config Audit](./config) | `/config/items/:key/audit` | GET |
| [Incidents](./incidents) | `/api/alerts/incidents` | GET, PATCH, POST |
| [Health](./health) | `/api/health` | GET |

## Request Format

- Content-Type: `application/json` (except file uploads)
- Max body size: configurable via `NEXT_BODY_SIZE_LIMIT` (default 10MB)
- Request IDs: Include `request_id` in the body for correlation

## Response Format

All responses follow a consistent JSON structure:

**Success:**

```json
{
  "data": { ... },
  "request_id": "req_abc123"
}
```

**Error:**

```json
{
  "error": "Human-readable error message"
}
```

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad request (missing/invalid parameters) |
| 401 | Invalid or missing API token |
| 403 | Feature not available in license |
| 404 | Resource not found |
| 409 | Conflict (duplicate resource) |
| 422 | Unprocessable (validation failure) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |
| 503 | Service unavailable (circuit breaker open or shutting down) |

## Rate Limiting

Requests are rate-limited per token based on the tenant's plan:

| Plan | Request Limit |
|------|---------------|
| FREE | 1,000/month |
| STARTER | 10,000/month |
| PROFESSIONAL | 100,000/month |
| ENTERPRISE | Unlimited |
| ON_PREMISE | Unlimited |

Rate limit headers are included in responses when applicable.

## Quota System

Beyond rate limits, the gateway enforces resource quotas:

- Token budgets (per-request and monthly)
- Vector count limits
- File storage limits
- Tracing session limits

Quota violations return `429` with a descriptive error message.
