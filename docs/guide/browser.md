# Browser Automation

The Browser module wraps Playwright behind a managed surface: reusable **browser profiles**, ephemeral **sessions** that own a real Chromium tab, and a per-browser **MCP endpoint** so agents (and any MCP-aware client) can drive the same toolset.

It replaces the previous standalone "Browser Agent" feature. Console-managed agents now browse by attaching the `Browser Use` system tool to a project agent; everything else (external runtimes, custom orchestrators) talks to the browser session API or per-browser MCP directly.

Operators manage browsers under **Operate → Browser**.

![Browser profiles](/screenshots/browser/01-browser-sessions.png)

The landing page lists browser profiles with their active/disabled and live-session counts. From a new tenant it shows the empty state above — **Create browser** registers the first profile, after which sessions and per-browser MCP endpoints become available.

## Concepts

- **Browser profile** — long-lived container with defaults for session config, the artifact bucket where screenshots/PDFs land, and a default model (used by extract/LLM-driven actions). Persisted in `browsers`.
- **Session** — a live Playwright context. Created from a profile, carries its own status (`starting | ready | closed | error`), receives actions, and records every event (navigation, click, extract, screenshot) to `browser_session_events`. Auto-closes after `idleTimeoutMs`.
- **Action** — a single operation against a session: `goto`, `click`, `hover`, `type`, `press`, `select`, `check`, `upload`, `drag`, `scroll`, `wait`, `tab`, `back`/`forward`/`reload`. The full schema lives in `browserActionSchema`.
- **Target** — how an action names the element it acts on. See [Addressing elements](#addressing-elements); this is the difference between an automation that works once and one that keeps working.
- **Flow** — a recorded, replayable step list. See [Flows](#flows).
- **Extract** — a target + mode (`text | html | attr | value`), optionally over every match.
- **Artifacts** — screenshots and PDFs are stored in the configured file bucket; the response carries the bucket key.

## Addressing elements

An action can name its element two ways, and only one of them survives being
saved.

`browser_snapshot` returns the page's accessibility tree with `[ref=e4]`
markers. A **ref** is the cheapest, least ambiguous handle for the turn you
are in — and it is valid only until the next snapshot, because the browser
renumbers them every time. Stored in a flow, a ref looks like a working
target and then spends the step's entire timeout resolving to nothing.

Everything else is **durable**: it describes the element the way a person
would, so it still resolves after a re-render and usually after a deploy.

| Field | Use when |
|---|---|
| `testId` | the app sets `data-testid` — the most stable target there is |
| `role` + `name` | almost always: `{ "role": "button", "name": "Sign in" }` |
| `label` | a form field with a `<label>` |
| `placeholder` | an input with placeholder text and no label |
| `text` | a link or element identified by its visible text |
| `selector` | last resort — CSS encodes markup nobody promised to keep |
| `nth` | disambiguates when the chosen strategy matches several elements |
| `frame` | CSS selector of an iframe to look inside |

Every action result carries **`resolvedTarget`**: the durable description of
whatever the action actually hit. That is what you save.

```jsonc
// Request — a live agent uses the ref it just saw
{ "type": "click", "ref": "e12" }

// Response — the durable form, safe to keep
{ "ok": true, "targetStrategy": "ref",
  "resolvedTarget": { "role": "button", "name": "Sign in" } }
```

A stale ref does not stall: when a durable target is supplied alongside it,
the ref is probed briefly and then abandoned in favour of the durable one.

## Flows

Driving a browser with a model is **discovery** — it reads the page,
guesses, backtracks, and bills tokens for every step. Replaying a flow is
**execution**: no model, no guessing, the same steps every time.

A flow is an ordered list of steps with durable targets, declared inputs, and
per-step retry policy. Record one from a session you already drove — by hand
in the live preview, or with an agent:

```bash
curl -X POST /api/client/v1/browser/flows/record \
  -d '{ "sessionId": "…", "name": "Submit expense", "status": "active" }'
```

Recording substitutes durable targets for refs, and turns **every typed value
into a declared input** rather than a literal — the recorder cannot tell a
search term from a password, and only one of those mistakes is recoverable.
Steps reference them as <span v-pre>`{{input.name}}`</span>.

Replay it with different values, as often as you like:

```bash
curl -X POST /api/client/v1/browser/flows/<key>/run \
  -d '{ "inputs": { "reference": "EXP-2002", "amount": "999" } }'
```

The response is the run record: per-step status and attempt count, whatever
`captureAs` collected, and — on a failure — the index of the step that broke
plus a screenshot of the page it gave up on.

Step policy:

| Field | Effect |
|---|---|
| `policy.retries` | attempts beyond the first; the delay doubles |
| `policy.timeoutMs` | per-step bound, overriding the session default |
| `policy.optional` | a failing step is recorded and skipped instead of aborting |
| `when` | skip the step unless the expression is truthy |
| `captureAs` | store the step's output for later steps and the run's outputs |

A run **aborts at the first non-optional failure**: a half-finished form is
usually worse than an untouched one.

Agents reach flows through `browser_list_flows` and `browser_run_flow` —
check for an existing flow before working a task out step by step.

Flows live at **Operate → Browser → Flows**.

## Signed-in profiles

An unattended run should not push credentials through a login form every
time. A browser profile can carry a Playwright `storageState` — cookies plus
origin storage — so every session it opens starts already authenticated:

```bash
curl -X PUT /api/client/v1/browser/browsers/<idOrKey>/profile \
  -d '{ "storageState": <contents of profile.json> }'
```

Get that file either from Playwright (`context.storageState()`) or from a
session you signed into by hand — the session list has a **save as profile**
action, and `GET …/sessions/<key>/profile` returns the same JSON.

The payload is encrypted at rest and is **never readable back**; the API
returns only a summary (cookie count, origins, earliest expiry) so the
dashboard can warn you before a profile goes stale.

## Quick start

```bash
# 1. Create a profile (one-time)
curl -X POST /api/browser/browsers \
  -d '{
    "name": "research-browser",
    "defaultSessionConfig": { "headless": true, "viewport": { "width": 1440, "height": 900 }, "idleTimeoutMs": 120000 }
  }'

# 2. Open a session
curl -X POST /api/browser/sessions \
  -d '{ "browserId": "brw_…", "name": "akbank-research" }'

# 3. Drive it
curl -X POST /api/browser/sessions/<sessionKey>/actions \
  -d '{ "type": "goto", "url": "https://www.akbank.com", "waitUntil": "networkidle" }'

curl -X POST /api/browser/sessions/<sessionKey>/extract \
  -d '{ "selector": "h1", "mode": "text", "multiple": true }'

# 4. Capture artifacts
curl -X POST /api/browser/sessions/<sessionKey>/screenshot \
  -d '{ "fullPage": true }'

curl -X DELETE /api/browser/sessions/<sessionKey>
```

The live screenshot endpoint (`GET …/screenshot/live`) returns an inline PNG/JPEG with `cache-control: no-store` — use it to drive a preview pane in the dashboard.

## Per-browser MCP

Every profile exposes its own MCP server at `/api/client/v1/browser/:browserKey/mcp/*`. The toolset mirrors the action API but follows the Model Context Protocol:

```
browser_navigate · browser_history · browser_click · browser_hover ·
browser_type · browser_press · browser_select · browser_check ·
browser_upload · browser_scroll · browser_wait · browser_tabs ·
browser_snapshot · browser_find · browser_extract · browser_diagnostics ·
browser_screenshot · browser_pdf · browser_list_flows · browser_run_flow ·
browser_close
```

The list is derived from the same tool definitions the `Browser Use` system
tool binds, so the two surfaces cannot drift apart.

Open the SSE stream first:

```http
GET /api/client/v1/browser/:browserKey/mcp/sse
```

The response carries an `X-Mcp-Session-Id` header and an `endpoint` SSE event with the message URL. Subsequent calls go to:

```http
POST /api/client/v1/browser/:browserKey/mcp/message?sessionId=<id>
```

…with the standard JSON-RPC payload (`initialize`, `tools/list`, `tools/call`, etc.). This is what the **Browser Use** system tool uses under the hood, so any MCP-compatible agent runtime can connect the same way.

## Sessions in the dashboard

`/dashboard/browser/[browserId]` shows the profile config, recent sessions, and aggregate counters. `/dashboard/browser/[browserId]/sessions` lists every session for the profile with filterable status and a quick deep-link to event history and stored artifacts.

## Distributed execution

Browser is one of the entity types the [Cluster](./cluster.md) layer can pin to a specific node. The `browserConsumer` registers a queue handler; when a profile is assigned to a node, all of its sessions and actions route through that node's queue. This matters when only some nodes have a real browser binary installed.

## Concurrency

Each profile has a concurrency ceiling defined by its `defaultSessionConfig` and the worker pool in `browserManager.ts`. When the ceiling is hit, new `createSession` calls are queued — the session starts as soon as a slot frees.

See the [Browser API reference](../api/browser.md) for the full endpoint list.
