# Tracing Eval (Beta)

Console now includes a first-step tracing-based evaluation layer on top of agent tracing data.

## Endpoints

### 1) Generate draft eval cases from tracing sessions

`POST /api/tracing/evals/drafts`

Body:

```json
{
  "agent": "assistant",
  "status": "error",
  "from": "2026-02-01T00:00:00.000Z",
  "to": "2026-02-28T23:59:59.000Z",
  "limit": 50
}
```

Returns candidate cases derived from traced sessions (including risk tags and candidate assertions).

### 2) Score traced sessions as an eval run

`POST /api/tracing/evals/runs/score`

Body:

```json
{
  "sessionIds": ["sess_1", "sess_2"],
  "thresholds": {
    "maxLatencyMs": 6000,
    "maxToolErrorRate": 0.2,
    "minOutputTokens": 16
  },
  "passScore": 0.75
}
```

Returns per-session score + aggregate pass rate.

## Notes

- This is a tracing-first implementation (no persisted eval set entities yet).
- It is designed as a foundation for full eval sets, compare/gate, and CI release checks.
