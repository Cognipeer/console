# Web Search

Web Search gives agents and applications a project-scoped search capability over
pluggable engines. Operators create **instances** under **Data → Web Search** —
an instance is a named search engine (Bing, Brave, Serper, Tavily, self-hosted
SearxNG, or keyless DuckDuckGo) with its own credentials, defaults, playground,
usage stats and per-instance search logs. A project can hold several instances,
e.g. a keyless DuckDuckGo for development next to a Brave instance for
production traffic.

![Web Search instances](/screenshots/websearch/01-websearch-list.png)

The landing page tracks instance counts, active status and how many instances
have AI answers enabled. Rows link to the instance detail page.

## Engines

| Driver | Type | Credentials | Notes |
|---|---|---|---|
| `bing` | Commercial | API key | Bing Web Search API v7; Azure regional endpoint override, market (`mkt`) setting |
| `brave-search` | Commercial | API key | Brave's independent index; country + language settings |
| `serper` | Commercial | API key | Google SERP via serper.dev; organic results + answer box |
| `tavily` | Commercial | API key | LLM-optimized search; `searchDepth`, provider-native answers |
| `searxng` | Open source, self-hosted | optional HTTP basic auth | Point at your instance's base URL (JSON format must be enabled); engine list configurable. Outbound requests go through the SSRF guard |
| `duckduckgo` | Keyless | none | Best-effort parse of the DuckDuckGo HTML endpoint; suitable for light usage |

All engines share common settings (language, country/market, safe search) and
normalize results to one shape: `title / url / snippet / position` plus
`publishedAt`, `source` and `score` where available.

## Creating an instance

**Create instance** opens the service picker filtered to web search engines;
the driver's form schema (API key, base URL, safe search, …) renders
dynamically. Credentials are encrypted at rest and never returned to the UI.

![Create instance](/screenshots/websearch/02-create-instance.png)

Instances are strictly project-scoped: they are created in the active project
and are not visible from other projects.

## Instance detail

The detail page follows the standard tabbed layout:

### Playground

Run live queries through the instance; every run — from the API or this page —
is recorded in Logs. The **AI answer** switch requests an AI interpretation of
the results (see below).

![Playground](/screenshots/websearch/03-instance-playground.png)

### Usage

Aggregates recent runs into search counts, success rate, error count, and
average / p95 latency, plus a breakdown by caller source (`api` vs
`dashboard`) and AI-answered searches.

### Logs

Every search with its query, result count, latency, source and status. Filter
by free text (queries, results and answers are searched), date range, and
status. Clicking a row opens the full detail — the returned results and the
synthesized answer are stored with each log entry.

![Search logs](/screenshots/websearch/04-instance-logs.png)

![Log detail](/screenshots/websearch/05-log-detail.png)

### Configuration

Shows the engine settings summary (edit re-opens the driver form) and hosts
the **AI Answer** card and the danger zone.

![Configuration](/screenshots/websearch/06-instance-config.png)

## AI answers

Like Tavily's synthesized answers, any instance can interpret its search
results with a model. Enable it per instance under **Configuration → AI
Answer**: toggle the switch, pick an LLM from the project's Model Hub, and
optionally add extra instructions (tone, output format).

Requests then opt in per call with `include_answer: true`; the top results are
handed to the model, which answers the query citing result numbers (`[1]`,
`[2]`). The response carries `answer` and `answer_model`.

`include_answer` is best-effort. If a request asks for an answer while the
instance has AI answers disabled (or no model selected), or the model call
fails, the search still succeeds: the results come back without an AI `answer`
and a `warnings` array explains why.

## Semantic cache

Repeated or near-identical queries do not have to hit the search engine (and its
quota). Enable **Configuration → Semantic cache → Cache enabled** on an
instance and choose:

- a **vector provider** and **vector index** to hold cache entries — the
  provider must support metadata filters, and the index dimension must match
  the embedding model;
- an **embedding model** from the project's Model Hub;
- a **similarity threshold** from 0 to 1 (default 0.8).

With caching on, every search embeds the query and looks it up in the index
before the engine is called. A cached query whose similarity is **at least** the
threshold returns its saved results without calling the engine. Otherwise the
engine runs and the query embedding, the original query (as a `keyword`) and
the complete result set are written to the index.

- **Isolation** — entries are bound to tenant, project and instance, so an
  index can be shared without one scope ever seeing another's results.
- **Options matter** — `count`, `offset`, `language`, `country` and safe search
  (after falling back to the instance settings) and the instance's own engine
  settings are part of the entry's identity: a 5-result answer is never served
  to a 10-result request. `include_answer` is not: AI answers are always
  generated per request from the (cached or fresh) results.
- **Response** — `cached` says whether the results came from the cache; `cache`
  carries `status` (`hit` / `miss` / `error`) and the hit `similarity`. Logs
  record the outcome per search (`metadata.cache`), shown as a Cache column and
  a badge in the log detail.
- **Failures** — a cache that cannot be reached (embedding, vector search or
  write failure, or a broken configuration) never fails the search: it runs
  uncached and the response carries a `warnings` entry. Warnings and logs name
  the failing stage only, never provider error text or credentials.

Settings are validated when saved: the vector provider/index and embedding
model must exist in the active project, and the threshold must be within 0–1.

## API

Token-authenticated endpoints live under `/api/client/v1/websearch/*`:

```bash
# Search on a named instance
curl -X POST https://console.example.com/api/client/v1/websearch/brave-main/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "query": "fastify v5 changes", "count": 5, "include_answer": true }'
```

When the project has exactly one active instance the generic endpoint may omit
the instance key; with multiple instances the request must name one (via the
`provider` field or the `/:key/search` path).

See the [Web Search API reference](/api/websearch) and the
[Console SDK](https://cognipeer.github.io/console-sdk/api/web-search)
(`client.webSearch.search(...)`, `client.webSearch.searchWith(key, ...)`).

## Access control

Web Search is a first-class RBAC service (`websearch`): grant `read` for
listing/logs and `write` for creating instances and running searches. Instance
credentials are stored on the shared provider record infrastructure
(AES-256-GCM, tenant-scoped).
