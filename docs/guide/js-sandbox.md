# JS Sandbox

The JS Sandbox lets agents and external clients run arbitrary JavaScript in an isolated worker with strict time, memory, and library limits. Use it for data transformation steps, lightweight ETL inside agent runs, structured-output post-processing, or as a "code interpreter" tool.

Operators manage runtimes under **Build → JS Sandbox**. Each runtime is a stored configuration (libraries, limits, network policy); executions reference a runtime by id or key.

![JS Sandbox runtimes](/screenshots/js-sandbox/01-runtimes-list.png)

The list summarises every runtime in the active project: total / active / disabled counts, the library catalog size, and per-runtime cards showing the isolation mode, memory ceiling, default timeout, and enabled libraries. **New Runtime** opens the create form.

## Concepts

- **Runtime** — a project-scoped configuration. Pins the allowed standard libraries, the per-execution timeout, memory ceiling, and network policy. Stored in `js_sandbox_runtimes`.
- **Execution** — a single `code + input` invocation against a runtime. Persisted to `js_sandbox_executions` with status (`success | error | timeout`), output, captured stdout/stderr, and elapsed time.
- **Library** — opt-in standard helpers exposed on `globalThis.libs`. The built-in catalog is small and stable:
  - `std:collections` — `groupBy`, `countBy`, `uniqueBy`, `sortBy`
  - `std:math` — `sum`, `avg`, `min`, `max`, `round`
  - `std:text` — `slugify`, `truncate`, whitespace compaction
- **Caller type** — every execution records who triggered it (`dashboard`, `agent`, `client-token`) so you can split usage in audit logs.

`GET /api/js-sandbox/libraries` returns the live descriptor list — use it when building UIs that need to enumerate the available helpers.

## Creating a runtime

```bash
curl -X POST https://console.example.com/api/js-sandbox/runtimes \
  -H "Content-Type: application/json" \
  -d '{
    "name": "report-shaper",
    "libraries": ["std:collections", "std:math"],
    "limits": {
      "timeoutMs": 3000,
      "memoryLimitMb": 128,
      "maxResultSizeBytes": 65536,
      "maxLogEntries": 200
    }
  }'
```

The response includes the generated `key` and the normalized configuration.

## Executing code

Two endpoints execute code:

- `POST /api/js-sandbox/execute` — body carries the `jsRuntimeId` (id or key).
- `POST /api/js-sandbox/runtimes/:idOrKey/execute` — path-scoped variant. Convenient for SDK clients.

```bash
curl -X POST https://console.example.com/api/js-sandbox/runtimes/report-shaper/execute \
  -d '{
    "code": "return libs.collections.groupBy(input.records, r => r.region);",
    "input": { "records": [{ "region": "EU", "v": 1 }, { "region": "US", "v": 2 }] }
  }'
```

The response is an execution record:

```json
{
  "execution": {
    "id": "exe_…",
    "status": "success",
    "result": { "EU": [{ "region": "EU", "v": 1 }], "US": [{ "region": "US", "v": 2 }] },
    "logs": { "stdout": [], "stderr": [] },
    "durationMs": 12
  }
}
```

A timed-out or aborted run returns `status: "timeout"` (HTTP 200 — failure is a property of the execution, not the request).

## Listing executions

`GET /api/js-sandbox/executions` supports filtering by `runtimeId`, `runtimeKey`, `status`, and date range plus pagination (`limit`, `page` or `skip`). It mirrors what the dashboard executions tab uses.

`GET /api/js-sandbox/executions/:id` returns one execution including captured logs and result payload.

## Distributed execution

JS Sandbox is one of the entity types the [Cluster](./cluster.md) layer can pin to a specific node. The `jsSandboxConsumer` registers a queue handler on the cluster bus; when a runtime is assigned to a node, all of its executions route through that node's queue. Unassigned runtimes execute on the receiving node.

For local single-node deployments nothing changes — the consumer runs in-process and executions complete inline.

## Limits and safety

The worker pool enforces:

- per-execution wall-clock timeout (default capped by `limits.timeoutMs`)
- memory ceiling per worker (`limits.memoryLimitMb`)
- maximum serialized result size (`limits.maxResultSizeBytes`)
- log entry caps (`limits.maxLogEntries`)
- denied `require`/`import` — only the explicitly enabled standard libraries are available
- network policy (`network.allowList`/`denyList`) when libraries that perform IO are added later

Code that throws bubbles up as `status: "error"` with `errorMessage` populated; uncaught promise rejections are awaited and surfaced the same way.

See the [JS Sandbox API reference](../api/js-sandbox.md) for the full request/response schema.
