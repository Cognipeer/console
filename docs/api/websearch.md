# Web Search API

Run web searches through the project's Web Search instances. See the
[feature guide](/guide/websearch) for instance management, engines and AI
answers.

All client endpoints require a Bearer API token and are gated by the
`websearch` RBAC service.

## List instances

```
GET /api/client/v1/websearch/providers
```

```json
{
  "providers": [
    {
      "key": "brave-main",
      "driver": "brave-search",
      "label": "Brave Web",
      "status": "active",
      "aiAnswer": true
    }
  ]
}
```

`aiAnswer` reports whether AI answers are enabled on the instance.

## Search

```
POST /api/client/v1/websearch/:key/search   # named instance
POST /api/client/v1/websearch/search        # single active instance, or `provider` in body
```

Request body:

```json
{
  "query": "fastify v5 changes",
  "count": 5,
  "offset": 0,
  "language": "en",
  "country": "US",
  "safe_search": "moderate",
  "include_answer": true
}
```

| Field | Type | Notes |
|---|---|---|
| `query` | string, required | Search query |
| `provider` | string | Instance key (generic endpoint only). Optional when the project has exactly one active instance; with multiple instances the request must name one |
| `count` | number | Max results, default 10, max 50 |
| `offset` | number | Paging hint where the engine supports it |
| `language` | string | ISO language override |
| `country` | string | Country/market override (e.g. `US`, `en-US`) |
| `safe_search` | `off` \| `moderate` \| `strict` | Safe-search override |
| `include_answer` | boolean | Interpret results with the instance's AI model. Fails when AI answers are disabled on the instance |

Response:

```json
{
  "id": "websearch-mr87slmv",
  "provider": "brave-main",
  "driver": "brave-search",
  "query": "fastify v5 changes",
  "answer": "Fastify v5 drops Node 18 support and … [1][3]",
  "answer_model": "gpt-4o",
  "results": [
    {
      "title": "Fastify v5 release notes",
      "url": "https://fastify.dev/blog/v5",
      "snippet": "…",
      "position": 1,
      "published_at": "2026-01-15",
      "source": "google",
      "score": 0.92
    }
  ],
  "latency_ms": 412
}
```

- `answer` is present when the AI interpretation ran (`include_answer: true`)
  or when the engine returns a native answer (Tavily, Serper answer box).
- `answer_model` is set only for AI-interpreted answers.
- `source` is the origin engine for metasearch instances (SearxNG).

Errors follow the standard `{ "error": "…" }` envelope with status 400 — e.g.
a missing query, an unknown instance key, or `include_answer` against an
instance without AI answers enabled.

## Dashboard endpoints

Session-authenticated equivalents used by the UI:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/websearch/providers/drivers` | Available engine drivers + form schemas |
| `GET` | `/api/websearch/providers` | Instances in the active project |
| `GET` | `/api/websearch/providers/:key` | One instance |
| `GET` | `/api/websearch/providers/:key/logs?limit&skip&from&to` | Run logs (results + answer included) |
| `POST` | `/api/websearch/search` | Run a search (playground) |

Instance CRUD goes through the generic `/api/providers` routes with
`type=websearch`.

## SDK

```ts
import { ConsoleClient } from '@cognipeer/console-sdk';

const client = new ConsoleClient({ apiKey: process.env.CONSOLE_API_KEY! });

const instances = await client.webSearch.providers.list();
const res = await client.webSearch.searchWith('brave-main', {
  query: 'fastify v5 changes',
  include_answer: true,
});
console.log(res.answer, res.results.map((r) => r.url));
```
