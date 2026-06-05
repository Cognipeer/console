# End-to-End Smoke Suite

Boots the **real** Cognipeer Console API over HTTP, signs up a fresh tenant, and
exercises every module end to end. This is the **L8 / Smoke** layer from
[`TESTING.md`](../../TESTING.md).

```bash
npm run test:smoke
```

No `.env`, no external services, no database setup required — the runner points
the process at a throwaway SQLite directory (in-memory cache + rate limiter),
boots the server on an ephemeral port, runs the suites, writes reports, and
cleans up. Exits non-zero if any step fails.

## Files

| File | Responsibility |
|---|---|
| `server.ts` | Builds and starts the production Fastify API (`fastifyApiPlugin` under `/api`) on a real HTTP listener — same plugin as `src/server/app.ts`, minus the Next.js handler. |
| `client.ts` | `fetch` wrapper with a cookie jar (so the session + active-project cookies propagate), plus `step()`/`skip()` result recording. |
| `suites.ts` | Per-module test definitions. The bulk of the coverage. |
| `run.ts` | Orchestrator: env isolation → boot → sign up → run suites → summarize → write reports. |

## Reports

Written after each run (git-ignored) to `scripts/smoke/reports/`:

- `latest.json` — full structured results.
- `latest.md` — Markdown table + Failures section.

## Adding a module

See the "Adding coverage for a new module" section in
[`docs/guide/smoke-testing.md`](../../docs/guide/smoke-testing.md). In short: add
an entry to the `suites` array in `suites.ts` with at least one read step; add a
create → read → delete lifecycle when the operation is fully self-contained.

## How it relates to the other test layers

- **L2 Unit / L3 API plugin** mount pieces of the app in isolation with mocked
  dependencies — fast, focused contracts.
- **L8 Smoke** (this) boots the whole server and a real database and asks: *does
  a freshly-started instance actually work for a brand-new user, across every
  module?* It catches wiring/integration regressions that mocked layers can't.
