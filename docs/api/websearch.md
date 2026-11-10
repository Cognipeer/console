# Web Search API

Run web searches through the project's Web Search instances. See the
[feature guide](/guide/websearch) for instance management, engines and AI
answers.

All client endpoints require a Bearer API token and are gated by the
`websearch` RBAC service.

## Instances and providers

Web search has two layers. A **provider** record holds the connection
(credentials, endpoint or base URL). An **instance** holds the search behavior
(depth, language, country, safe search, engines, AI answers, semantic cache) and
points at a provider by key. Searches, quotas, logs and usage are keyed by the
instance.

Existing keys keep working: a provider that had no instance yet is still
accepted wherever an instance key is, and providers that existed before
instances were introduced get an instance with the same key.

## List instances

```
GET /api/client/v1/websearch/instances
GET /api/client/v1/websearch/providers     # same content (older name)
```

```json
{
  "instances": [
    {
      "key": "brave-main",
      "driver": "brave-search",
      "label": "Brave Web",
      "status": "active",
      "aiAnswer": true,
      "kind": "instance",
      "providerKey": "brave-connection"
    },
    {
      "key": "legacy-tavily",
      "driver": "tavily",
      "label": "Tavily",
      "status": "active",
      "aiAnswer": false,
      "kind": "provider"
    }
  ]
}
```

`/providers` answers the same rows under the `providers` field. `aiAnswer`
reports whether AI answers are enabled. `kind` is `instance` for an instance
and `provider` for a provider record that has no instance with its key yet;
both kinds can be used as the search key. Keys never repeat in the list.

## Search

```
POST /api/client/v1/websearch/:key/search   # named instance (a provider key also works)
POST /api/client/v1/websearch/search        # single active instance, or `instance` in body
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
| `instance` | string | Instance key (generic endpoint only). Optional when the project has exactly one active instance; with multiple instances the request must name one |
| `provider` | string | Alias of `instance`; `instance` wins when both are sent |
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
  "cached": false,
  "latency_ms": 412
}
```

- `answer` is present when the AI interpretation ran (`include_answer: true`)
  or when the engine returns a native answer (Tavily, Serper answer box).
- `answer_model` is set only for AI-interpreted answers.
- `source` is the origin engine for metasearch instances (SearxNG).
- `cached` is `true` when the results came from the instance's semantic cache
  instead of the search engine. `cache` (`{ "status": "hit" | "miss" | "error",
  "similarity"? }`) appears only on instances with caching enabled. On `error`
  the cache could not be consulted, the search ran uncached and `warnings`
  says why.

Errors follow the standard `{ "error": "…" }` envelope with status 400 — e.g.
a missing query, an unknown instance key, or `include_answer` against an
instance without AI answers enabled.

## Dashboard endpoints

Session-authenticated equivalents used by the UI:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/websearch/providers/drivers` | Available engine drivers + form schemas |
| `GET` | `/api/websearch/instances` | Instances visible in the active project, each with a provider summary (key, label, driver, status, platform flag; never credentials or connection settings) |
| `POST` | `/api/websearch/instances` | Create an instance |
| `GET` | `/api/websearch/instances/:key` | One instance |
| `PATCH` | `/api/websearch/instances/:key` | Update an instance (the key does not change) |
| `DELETE` | `/api/websearch/instances/:key` | Delete an instance |
| `GET` | `/api/websearch/instances/:key/logs?limit&skip&from&to` | Run logs (results + answer included) |
| `POST` | `/api/websearch/search` | Run a search (playground); `instance`, or `provider` as an alias |

Create body: `{ key, name, description?, providerKey, settings?, status?, tenantWide? }`.
An instance belongs to the active project unless `tenantWide: true`, which
needs an owner or admin. `settings` holds behavior only; endpoint and base URL
belong to the provider. A platform-provided instance is read-only.

| Status | Meaning |
|---|---|
| 400 | Invalid settings or cache configuration, or a missing field |
| 403 | Not an owner or admin, or a platform or managed record |
| 404 | No such instance in the project |
| 409 | The key already exists |

Provider records (connections) are managed through the generic
`/api/providers` routes with `type=websearch`.

### Compatibility routes

Kept for one release so existing callers keep working:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/websearch/providers` | Visible instances in the older row shape (`key`, `label`, `driver`, `status`, `settings`, `platform`, `hasCredentials`, plus `kind: "instance"`, `providerKey`, `provider`), then every visible provider that has no instance with its key, marked `kind: "provider"` and `legacy: true` |
| `GET` | `/api/websearch/providers/:key` | Resolves an instance by key first, then a provider |
| `GET` | `/api/websearch/providers/:key/logs` | Same resolution |

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
