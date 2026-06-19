# Crawler API

Save reusable web crawler profiles, manage their seed URLs, trigger runs, and read the resulting pages as Markdown. API-token authenticated.

All endpoints live under `/api/client/v1/crawler/*` and require a Bearer token:

```http
Authorization: Bearer cgt_…
```

A **crawler** is a saved container that holds crawl configuration (engine, depth/page limits, scope filters, HTTP options, RAG binding, webhook, schedule). Running a crawler — or starting an ad-hoc run — enqueues a **job**, and each fetched page or file is stored as a **result** (extracted as Markdown for HTML).

By default the client API runs **async**: a run enqueues the job and returns immediately with `{ "jobId": "…", "status": "queued" }`. Poll the job, or supply a `callbackUrl`/`webhook` to be notified. Pass `"mode": "sync"` to block until the crawl finishes.

### Crawler config fields

These appear on create/update and inside a job's frozen `planSnapshot`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | — | Display name (required on create). |
| `key` | string | from `name` | URL-friendly id, unique per tenant/project. `^[a-z0-9][a-z0-9_-]*$`. |
| `description` | string | — | Up to 2000 chars. |
| `seeds` | string[] (url) | `[]` | Initial URL list. Up to 500. URLs can also be managed via `/urls`. |
| `engine` | `axios \| playwright \| auto` | `auto` | Fetch engine; `playwright` renders JS. |
| `maxDepth` | int 0–3 | `0` | Link-follow depth. `0` = only the given URLs. |
| `maxPages` | int 0–5000 | `50` | Page cap. `0` = unlimited. |
| `autoCrawl` | boolean | `false` | Follow discovered links within scope. |
| `scope` | object | — | `sameDomainOnly` (default `true`), `includeSubdomains` (default `false`), `allowList[]`, `blockList[]` host globs. |
| `http` | object | — | `userAgent`, `acceptLanguage`, `timeoutMs` (1000–120000), `maxConcurrency` (1–16), `retries` (1–5), `headers`, `cookies[]`, `basicAuth`, `bearerToken`, `allowPrivateNetwork`. |
| `downloadableMimes` | string[] | — | MIME types treated as downloadable files. |
| `markdownOptions` | object | — | `{ ocr: { enabled, languages? } }` forwarded to the Markdown extractor. |
| `rag` | object | — | `{ ragModuleKey, enabled }` — ingest crawled pages into a RAG module. |
| `webhook` | object | — | `{ url, secret?, events[] }` where events are `page`, `completed`, `failed`. |
| `schedule` | object | — | `{ mode: interval\|cron, enabled, intervalSeconds?, cron?, startAt?, endAt? }`. Interval mode needs `intervalSeconds` (≥60); cron mode needs `cron`. |
| `metadata` | object | — | Arbitrary key/value bag. |

## Crawlers

### List

```http
GET /api/client/v1/crawler/crawlers?status=active&search=docs
```

| Query | Type | Notes |
|---|---|---|
| `status` | `active \| disabled` | Filter by status. |
| `search` | string | Match on name/key. |

#### Response

```json
{
  "crawlers": [
    {
      "id": "665f…",
      "key": "docs-site",
      "name": "Docs site",
      "status": "active",
      "engine": "auto",
      "maxDepth": 1,
      "maxPages": 200,
      "autoCrawl": true,
      "seeds": ["https://example.com/docs"],
      "scope": { "sameDomainOnly": true, "includeSubdomains": false },
      "createdAt": "2026-06-15T10:00:00.000Z"
    }
  ]
}
```

### Create

```http
POST /api/client/v1/crawler/crawlers
```

```json
{
  "name": "Docs site",
  "key": "docs-site",
  "seeds": ["https://example.com/docs"],
  "engine": "auto",
  "maxDepth": 1,
  "maxPages": 200,
  "autoCrawl": true,
  "scope": { "sameDomainOnly": true },
  "rag": { "ragModuleKey": "support-kb", "enabled": true },
  "webhook": { "url": "https://app.example.com/hooks/crawl", "events": ["completed", "failed"] }
}
```

Returns `201` with `{ "crawler": { … } }`.

### Get

```http
GET /api/client/v1/crawler/crawlers/:idOrKey
```

Accepts either the crawler `id` or its `key`. Returns `{ "crawler": { … } }`, or `404` if not found.

### Update

```http
PATCH /api/client/v1/crawler/crawlers/:idOrKey
```

Partial update. Accepts the same fields as create plus `status` (`active | disabled`). Set `rag`, `webhook`, or `schedule` to `null` to clear them. Returns `{ "crawler": { … } }`.

### Delete

```http
DELETE /api/client/v1/crawler/crawlers/:idOrKey
```

Returns `204` on success, `404` if not found.

### URLs

List, add, or remove the crawler's saved URL list. A crawler is a container, so URLs can be managed independently of runs.

```http
GET    /api/client/v1/crawler/crawlers/:idOrKey/urls
POST   /api/client/v1/crawler/crawlers/:idOrKey/urls
DELETE /api/client/v1/crawler/crawlers/:idOrKey/urls
```

Body for `POST` / `DELETE`:

```json
{ "urls": ["https://example.com/docs", "https://example.com/blog"] }
```

| Field | Type | Notes |
|---|---|---|
| `urls` | string[] (url) | 1–500 URLs to add or remove. |

All three return the updated list: `{ "urls": ["…"] }`.

### Run

Run a saved crawler. Enqueues a job using the crawler's config.

```http
POST /api/client/v1/crawler/crawlers/:idOrKey/run
```

```json
{
  "urls": ["https://example.com/changelog"],
  "callbackUrl": "https://app.example.com/hooks/crawl",
  "mode": "async",
  "metadata": { "source": "ci" }
}
```

| Field | Type | Notes |
|---|---|---|
| `urls` | string[] (url) | Optional. Overrides the saved URL list for this run (max 500). |
| `seeds` | string[] (url) | Legacy alias for `urls`. |
| `callbackUrl` | string (url) | Per-run webhook receiver. |
| `mode` | `sync \| async` | Defaults to `async`. |
| `metadata` | object | Stored on the job. |

#### Response (`202`)

```json
{ "jobId": "6660…", "status": "queued" }
```

### Crawl

Crawl an explicit set of URLs using a saved crawler's config — "give me the Markdown for these URLs". Functionally a `run` with required `urls`.

```http
POST /api/client/v1/crawler/crawlers/:idOrKey/crawl
```

```json
{
  "urls": ["https://example.com/page-1", "https://example.com/page-2"],
  "mode": "sync"
}
```

| Field | Type | Notes |
|---|---|---|
| `urls` | string[] (url) | Required, 1–500 URLs. |
| `callbackUrl` | string (url) | Per-run webhook receiver. |
| `mode` | `sync \| async` | Defaults to `async`. |
| `metadata` | object | Stored on the job. |

Returns `202` with `{ "jobId": "…", "status": "queued" }`.

### Ad-hoc run

Start a one-off crawl without saving a crawler.

```http
POST /api/client/v1/crawler/run
```

```json
{
  "seeds": ["https://example.com/article"],
  "engine": "auto",
  "maxDepth": 0,
  "maxPages": 20,
  "autoCrawl": false,
  "callbackUrl": "https://app.example.com/hooks/crawl",
  "mode": "async"
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `seeds` | string[] (url) | — | Required, 1–50 URLs. |
| `engine` | `axios \| playwright \| auto` | `auto` | |
| `maxDepth` | int 0–3 | `0` | |
| `maxPages` | int 0–5000 | `20` | |
| `autoCrawl` | boolean | `false` | |
| `scope` / `http` / `downloadableMimes` / `markdownOptions` / `rag` / `webhook` / `metadata` | | | Same shapes as crawler config. |
| `callbackUrl` | string (url) | — | Per-run webhook receiver. |
| `mode` | `sync \| async` | `async` | |

Returns `202` with `{ "jobId": "…", "status": "queued" }`. The job has no `crawlerKey`.

## Jobs & Results

A job moves through these statuses:

| Status | Meaning |
|---|---|
| `queued` | Enqueued, not yet started. |
| `running` | Currently crawling. |
| `succeeded` | Finished, no fatal errors. |
| `partial` | Finished but some pages errored. |
| `failed` | No pages processed; the run failed. |
| `canceled` | Stopped via the cancel endpoint. |

### List jobs

```http
GET /api/client/v1/crawler/jobs?crawlerKey=docs-site&status=succeeded&limit=20
```

| Query | Type | Notes |
|---|---|---|
| `crawlerKey` | string | Filter by parent crawler. |
| `status` | job status | Filter by status. |
| `limit` | number | Max jobs to return. |

#### Response

```json
{
  "jobs": [
    {
      "id": "6660…",
      "crawlerKey": "docs-site",
      "trigger": "api",
      "status": "succeeded",
      "pagesDiscovered": 42,
      "pagesProcessed": 40,
      "filesProcessed": 2,
      "errorsCount": 0,
      "limitReached": false,
      "startedAt": "2026-06-15T10:01:00.000Z",
      "endedAt": "2026-06-15T10:02:30.000Z",
      "durationMs": 90000
    }
  ]
}
```

`trigger` is one of `manual`, `api`, `adhoc`, `schedule`.

### Get job

```http
GET /api/client/v1/crawler/jobs/:jobId
```

Returns `{ "job": { … } }` (including counters, `planSnapshot`, `errorMessage`), or `404`.

### List results

```http
GET /api/client/v1/crawler/jobs/:jobId/results?type=html&limit=100&skip=0
```

| Query | Type | Default | Notes |
|---|---|---|---|
| `type` | `html \| file \| error` | — | Filter by result type. |
| `limit` | number | `100` | Page size. |
| `skip` | number | `0` | Offset. |

#### Response

```json
{
  "results": [
    {
      "id": "6661…",
      "jobId": "6660…",
      "url": "https://example.com/docs/intro",
      "parentUrl": "https://example.com/docs",
      "depth": 1,
      "type": "html",
      "httpStatus": 200,
      "contentType": "text/html",
      "title": "Introduction",
      "bodyMarkdown": "# Introduction\n\n…",
      "bytes": 4096,
      "ragDocumentId": "doc_abc",
      "ragStatus": "indexed",
      "fetchedAt": "2026-06-15T10:01:05.000Z"
    }
  ]
}
```

`bodyMarkdown` is present for `html` results. `ragStatus` is one of `pending`, `indexed`, `skipped`, `failed` (only when the crawler has a RAG binding). `error` results carry an `errorMessage`.

### Get result

```http
GET /api/client/v1/crawler/jobs/:jobId/results/:resultId
```

Returns `{ "result": { … } }`, or `404`.

### Cancel job

```http
POST /api/client/v1/crawler/jobs/:jobId/cancel
```

Requests cancellation of a `queued`/`running` job. Returns `{ "ok": true }`, or `404` if the job is missing or not cancelable.

## Errors

| Status | Cause |
|---|---|
| 400 | Invalid body, duplicate key (`already exists`), crawler not active. |
| 401 | Missing/invalid API token. |
| 404 | Crawler, job, or result not found; job not cancelable. |
| 500 | Internal error. |

## Example

```bash
# 1. Create a crawler
curl -X POST https://console.cognipeer.com/api/client/v1/crawler/crawlers \
  -H "Authorization: Bearer cgt_…" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Docs site",
        "key": "docs-site",
        "seeds": ["https://example.com/docs"],
        "maxDepth": 1,
        "maxPages": 200,
        "autoCrawl": true
      }'

# 2. Run it (async)
curl -X POST https://console.cognipeer.com/api/client/v1/crawler/crawlers/docs-site/run \
  -H "Authorization: Bearer cgt_…" \
  -H "Content-Type: application/json" \
  -d '{ "mode": "async" }'
# → { "jobId": "6660…", "status": "queued" }

# 3. Poll the job
curl https://console.cognipeer.com/api/client/v1/crawler/jobs/6660… \
  -H "Authorization: Bearer cgt_…"

# 4. Read the crawled pages as Markdown
curl "https://console.cognipeer.com/api/client/v1/crawler/jobs/6660…/results?type=html" \
  -H "Authorization: Bearer cgt_…"
```
