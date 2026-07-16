# Real End-to-End & Load Testing

The real end-to-end + load test suite lives in a dedicated, standalone test
application: **`cognipeer-console-test`** (a sibling repo at
`../cognipeer-console-test`). It complements the in-process [Smoke suite](./smoke-testing.md):
smoke proves a freshly-booted API is wired correctly with zero external
dependencies; `cognipeer-console-test` proves the **whole product works for a
real user against real infrastructure and a real LLM**, and includes a load
test.

## What it is

A Vitest + Docker harness that, with one command, brings up a full stack —
MongoDB, Redis, Mailpit, LocalStack, a deterministic mock LLM, and the console
itself — and drives every domain over real HTTP like a client. Every domain has
at least a happy path + a failure-mode test.

It additionally has an **opt-in real-LLM layer** (Azure OpenAI or any
OpenAI-compatible endpoint) that asserts genuine **semantic** outcomes rather
than just wiring:

- **chat** — answers "4" / "Paris"; SSE streaming; token usage.
- **embeddings** — correct dimensionality, batching, semantic distance.
- **Knowledge Engine** — ingest a fact → vector retrieval → grounded answer that cites it.
- **guardrails** — an llm-judge guardrail blocks an unsafe prompt, passes a benign one.
- **memory** — semantic recall returns the right memory.
- **agents / evaluations / analysis / reranker** — real agent chat, an
  llm-judge evaluation suite that runs async to completion with scores, LLM
  field extraction, and llm-judge reranking.
- **load test** — concurrent real traffic with p50/p90/p95/p99 latency,
  throughput and error rate.

## Run it

```bash
cd ../cognipeer-console-test
npm install

# mock-LLM run (no key, no internet) — build → up → vitest → down:
npm run test:e2e

# real-LLM + load (opt-in): set credentials, then:
cp .env.example .env            # set AZURE_OPENAI_URL + AZURE_PROJECT_API_KEY
npm run stack:up
npm run test:real-llm
npm run test:load
```

The console image used by the stack is built with `E2E_BUILD=1`, which relaxes
the strict build-time type/lint gate (see `next.config.ts`); normal
`npm run build` stays fully strict.

See `cognipeer-console-test/README.md` for the full reference: every spec, the
stack wiring, real-LLM mode, and how to add new specs.
