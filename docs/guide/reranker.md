# Reranker

Rerankers re-order a candidate set of documents by relevance to a query. They sit between an initial retriever (vector search, BM25, hybrid) and the final consumer (LLM, Knowledge Engine pipeline) and dramatically improve precision at low recall depths.

Operators manage rerankers under **Data → Reranker**. Each reranker is project-scoped, has a unique key, and persists usage stats (`totalRuns`, `avgLatencyMs`, `lastUsedAt`) for monitoring.

![Reranker list](/screenshots/reranker/01-reranker.png)

The landing page tracks total / active reranker counts and total runs, with a row per reranker showing its strategy, backing model, run count, and average latency. **Create reranker** opens the form where you pick a strategy (below) and bind the backing model or judge.

## Strategies

The reranker abstraction supports five strategies. Pick one based on latency budget, quality target, and whether you already have a dedicated rerank model.

| Strategy | How it works | When to use |
|---|---|---|
| `dedicated-model` | Calls a hosted cross-encoder (Cohere Rerank, Jina, Voyage, etc.) | Best quality; needs a provider integration |
| `llm-judge` | LLM scores each (query, document) pair one-by-one | High quality without a dedicated model, costs scale with N |
| `llm-listwise` | LLM ranks the whole list in a single call | Cheaper than `llm-judge` for medium N; lower latency |
| `heuristic` | Score-aware rules (BM25 blending, length penalty, freshness boost, etc.) | Zero model dependency; tune for known corpora |
| `fusion` | Reciprocal Rank Fusion across multiple input score lists | Combine vector + lexical scores into one ranking |

The `strategy` plus `config` payload is stored on the reranker — see `src/lib/services/reranker/strategies/` for the per-strategy config shape.

## Creating a reranker

```bash
curl -X POST https://console.example.com/api/reranker \
  -H "Content-Type: application/json" \
  -d '{
    "name": "support-knowledge-rerank",
    "strategy": "dedicated-model",
    "status": "active",
    "config": {
      "providerKey": "cohere",
      "model": "rerank-multilingual-v3.0",
      "topN": 10
    }
  }'
```

The response contains the generated `key` you use for subsequent calls.

## Running a reranker

`POST /api/reranker/:key/run` accepts a query and a list of documents (strings or `{ id, content, score?, metadata? }`) and returns them re-ordered by relevance:

```bash
curl -X POST https://console.example.com/api/reranker/support-knowledge-rerank/run \
  -d '{
    "query": "How do I reset my password?",
    "documents": [
      "Forgot password? Click here to reset.",
      "Our cookie policy explains tracking choices.",
      "Two-factor authentication setup guide."
    ],
    "topN": 3
  }'
```

Each run is persisted to a run-log table; `GET /api/reranker/:key/runs?from=&to=&limit=` returns the recent history for debugging and quality tracking.

## Knowledge Engine integration

The [Knowledge Engine](./rag.md) module accepts an optional `rerankerKey` per module. When set, the retrieval pipeline becomes:

```
Query → Vector store top-K → Reranker (top-N) → LLM context
```

Set the reranker on a Knowledge Engine module to bolt better ranking onto an existing pipeline without changing the embedding model or vector store.

## Dashboard

The reranker page lists every reranker with strategy, status, run counts, and average latency. Each detail page exposes a playground that proxies to `POST /api/reranker/:key/run` so you can validate the behavior with real documents before wiring it into production retrieval.

See the [Reranker API reference](../api/reranker.md) for the full request/response schema.
