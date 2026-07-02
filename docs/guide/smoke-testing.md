# Smoke Testing (End-to-End)

The smoke suite is the **L8** layer described in [`TESTING.md`](https://github.com/Cognipeer/cognipeer-console/blob/main/TESTING.md): it boots the **real** application server over HTTP, signs up a brand-new tenant the same way the UI sign-up form does, and then drives every module's API end to end — auth hook → RBAC → service layer → SQLite — exactly as a real client would.

Where the unit (L2) and API-plugin (L3) layers mount pieces of the app in isolation with mocked dependencies, the smoke layer answers a different question: **"does a freshly-started server actually work for a brand-new user across every module?"**

## Running it

```bash
npm run test:smoke
```

That's it. No external services, no `.env` setup, no database to provision. The runner:

1. Creates a throwaway SQLite data directory under the OS temp folder and points the process at it (`SQLITE_DATA_DIR`), with in-memory cache + rate limiting. **Your dev data is never touched.**
2. Boots the real Fastify API (`fastifyApiPlugin`, mounted under `/api`) on an ephemeral port.
3. Registers a tenant + owner via `POST /api/auth/register` and proves the session cookie works.
4. Runs every per-module suite against the live server.
5. Prints a grouped summary, writes reports to `scripts/smoke/reports/latest.{json,md}`, and exits non-zero on any failure.
6. Deletes the temp data directory.

A successful run looks like:

```
────────────────────────────────────────────
  TOTAL 127  |  PASS 127  FAIL 0  SKIP 0
────────────────────────────────────────────
```

## What it covers

The suite exercises the full dashboard (cookie-session) API surface plus the OpenAI-compatible client API:

| Area | Coverage |
|---|---|
| **Auth** | register, session, login, wrong-password rejection, forgot-password, unauthenticated → 401 |
| **Health** | `/api/health/live`, `/api/health/ready` |
| **CRUD lifecycles** | projects, prompts, guardrails, PII policies, evaluation datasets, analysis definitions, rerankers, alert rules, config groups/items, vector providers+indexes (+upsert/query against the built-in SQLite vector store), users (invite/delete), API tokens |
| **Read paths** | models, providers, memory, RAG, tracing, redteam, audit, automations, cluster, crawler, browser, files, inference-monitoring, license, MCP, OCR jobs, quota, sandbox, tools |
| **Client API** | Bearer-token auth enforcement, `GET /api/client/v1/prompts`, policy-based `POST /api/client/v1/pii/detect` |
| **Metrics** | Prometheus `/api/metrics` with an API token |

Each step asserts a specific set of acceptable HTTP status codes. Fully self-contained operations (no external provider/credentials, no network egress) run a complete create → read → delete lifecycle; operations that require external infrastructure are verified at the read + validation-contract level.

## Reports

After every run, two machine- and human-readable reports are written (git-ignored):

- `scripts/smoke/reports/latest.json` — full structured results (per-step method, path, expected vs. actual status, duration).
- `scripts/smoke/reports/latest.md` — the same as a Markdown table, with a Failures section when applicable.

## How it's structured

```
scripts/smoke/
├── server.ts    # Boots the real Fastify API over HTTP (no Next.js)
├── client.ts    # fetch wrapper + cookie jar + step/skip recording
├── suites.ts    # Per-module test definitions (the bulk of the coverage)
└── run.ts       # Orchestrator: env isolation → boot → signup → suites → report
```

## Adding coverage for a new module

When you add a new API plugin, add a suite entry in `scripts/smoke/suites.ts`:

```ts
{
  module: 'my-feature',
  run: async (c, ctx) => {
    // Read path — proves the full stack works for this module.
    await c.step('list things', 'GET', '/api/my-feature/things', [200]);

    // Optional lifecycle when the create path is self-contained.
    const created = await c.step('create thing', 'POST', '/api/my-feature/things', [200, 201], {
      body: { name: `Smoke Thing ${ctx.stamp}` },
    });
    const id = idOf(created?.body);
    if (id) {
      await c.step('delete thing', 'DELETE', `/api/my-feature/things/${id}`, [200]);
    } else {
      c.skip('thing lifecycle', 'no id returned');
    }
  },
}
```

Guidelines:

- Use `ctx.stamp` in any unique keys/emails so repeated runs never collide.
- `c.step(name, method, path, expectedStatuses, { body, headers })` records the result and returns the response (or `null` if it failed) so you can chain.
- Prefer real create → read → delete lifecycles when the operation needs nothing external. Otherwise assert the read path + the validation contract (e.g. empty body → `400`).
- Clean up anything you create. The temp database is destroyed at the end of every run, so cleanup is mostly about keeping a single run's state tidy.

## When to run it

- Locally before opening a PR that touches API plugins, services, auth, or the database layer.
- In CI as the L8 stage (see the CI/CD sequence in `TESTING.md`). It needs no secrets and runs fully self-contained, so it's safe in any environment with Node.js 20+.
