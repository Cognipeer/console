# End-to-End & Load Tests → moved to `cognipeer-console-test`

The real end-to-end + load test suite now lives in the dedicated sibling
repository **[`cognipeer-console-test`](../../cognipeer-console-test)** — a
standalone Vitest + Docker test application that:

- brings up a full stack (MongoDB, Redis, Mailpit, LocalStack, a mock LLM, and
  the console itself) with one command;
- drives every console domain over real HTTP like a client;
- runs an **opt-in real-LLM layer** (Azure OpenAI / OpenAI-compatible) that
  asserts genuine semantic outcomes — chat answers "Paris", RAG retrieves the
  ingested fact, the llm-judge guardrail blocks unsafe prompts, evaluations /
  analysis runs complete with real scores, the reranker ranks the right doc;
- includes **JS sandbox** real execution, **sandbox** management, and a
  **load test** with latency percentiles.

## Run it

```bash
cd ../cognipeer-console-test
npm install
cp .env.example .env          # optional: set AZURE_OPENAI_URL + AZURE_PROJECT_API_KEY for real-LLM specs
npm run test:e2e              # build → up → vitest → down  (mock-LLM, no key needed)

# real-LLM + load (stack already up):
npm run test:real-llm
npm run test:load
```

## Relationship to the in-process smoke suite

`scripts/smoke/` (in this repo) remains the fast **L8** in-process smoke layer
(SQLite, no external deps) — it boots the API in-process and sweeps every module
for status-code/contract coverage. `cognipeer-console-test` is the heavier **L9**
layer: a real dockerized stack driven over HTTP with a real LLM.

> Note: the console's production Docker image used by the test stack is built
> with `E2E_BUILD=1`, which relaxes the strict build-time type/lint gate (see
> `next.config.ts`). Normal `npm run build` stays fully strict.
