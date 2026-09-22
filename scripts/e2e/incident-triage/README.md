# Incident-triage E2E

An agent is given a production problem. It must look up the runbook in a
knowledge base built from **Confluence**, investigate **two log sources**,
find the root cause and deliver a comment to the incident. The run compares
three ways of delivering that comment:

| Variant | How the finding leaves the agent |
|---|---|
| **A — tool post** | The agent calls `post_incident_comment` itself. |
| **B — structured** | The agent returns a schema-checked object; the integration formats and posts it. |
| **C — text** | The agent's reply is the comment; the integration posts it verbatim. |

All three variants share the same procedure, tools and knowledge base, so any
difference between them comes from the delivery method alone.

```bash
npm run test:e2e:triage -- --reps 3                 # all scenarios × all variants
npm run test:e2e:triage -- --variants B --scenarios slow-login --reps 5
```

## What is real, what is mocked

| Piece | Real | Mocked |
|---|---|---|
| Console API (Fastify, same plugin as production) | ✅ | |
| Tenant, knowledge engine, embeddings, vector store (SQLite), tools, agents, versions | ✅ (a throwaway tenant, deleted afterwards) | |
| LLM + embedding model | ✅ | |
| Confluence Cloud REST v1 (`/wiki/rest/api/content`, paginated, auth) | | ✅ `mockServers.ts` |
| App logs (Elasticsearch-shaped `GET /logs/_search`) | | ✅ |
| Infra logs (Loki-shaped LogQL `POST /loki/api/v1/query_range`) | | ✅ |
| Incident tracker (`POST /incidents/{id}/comments`) | | ✅ |

The tools are real console tools, imported from OpenAPI specs (`toolSpecs.ts`)
that point at the mocks. The run never touches developer data.

**LLM credentials:** set `E2E_LLM_BASE_URL` and `E2E_LLM_API_KEY`. On a
development machine that has neither, the run decrypts the local dev tenant's
`openai-compatible` provider in a subprocess (`extractLocalLlm.ts`); the key is
never printed. `E2E_LLM_MODEL` / `--model`, `E2E_EMBED_MODEL`,
`E2E_PRICE_IN` / `E2E_PRICE_OUT` (per-1M prices; the defaults are
placeholders) are optional.

## Scenarios

`fixtures.ts` holds four incidents: checkout 502s, slow logins, upload
failures and stale search. In each one:

- The runbook says **where to look**; it never names today's cause.
- The **app log** shows the symptom, and the **infra log** shows why. An agent
  that stops after one source reaches a plausible but wrong answer.
- There is one tempting **red herring**, such as payment-gateway timeouts or
  user-db slow queries.

## How a run is scored (`scoring.ts`)

The score is based on what the agent **did**, not on what it says it did.
Tool order comes from the run's recorded steps and is cross-checked against
the mock servers' own request logs. The root cause is judged on the text that
was actually delivered.

A run **passes** only if all of the following hold:

- it searched the knowledge base first;
- it queried both log sources successfully;
- the root cause is correct;
- the comment was delivered exactly once, to the right incident;
- for B, the schema is valid.

The run also checks:

- the Confluence import;
- that knowledge-base retrieval returns the right runbook;
- the **streaming** path for every variant (live tool events, recorded steps, token counts);
- that **Model Hub** records usage for the agent's model.

Reports are written to `reports/latest.{json,md}` (git-ignored).
