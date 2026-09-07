# Browser Automation

The Browser module wraps Playwright behind a managed surface: reusable **browser profiles**, ephemeral **sessions** that own a real Chromium tab, and a per-browser **MCP endpoint** so agents (and any MCP-aware client) can drive the same toolset.

It replaces the previous standalone "Browser Agent" feature. Console-managed agents now browse by attaching the `Browser Use` system tool to a project agent; everything else (external runtimes, custom orchestrators) talks to the browser session API or per-browser MCP directly.

Operators manage browsers under **Operate → Browser**.

![Browsers list](/screenshots/browser/01-browsers-list.jpg)

The landing page lists browser profiles with their active/disabled state and live-session counts. **Browsers**, **Sessions**, **Flows** and **Playground** are peers in the left nav — each is its own screen, not a tab buried inside another.

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

The response is the run record: per-step status and attempt count, the JSON
the flow returns, and — on a failure — the index of the step that broke plus
a screenshot of the page it gave up on.

### What a run returns

A step with `captureAs` stores its result under that name. Left alone, a run
hands those captures back verbatim — which changes the moment someone renames
one. Declare `outputs` to make the return value a contract instead:

```json
{
  "outputs": [
    { "name": "receiptCode", "source": "{{step.receipt}}" },
    { "name": "amount", "source": "{{step.amountText}}", "type": "number" },
    { "name": "summary", "source": "{{input.reference}} → {{step.amountText}}" }
  ]
}
```

| Field | Effect |
|---|---|
| `name` | the key in the returned JSON |
| `source` | a template over `{{step.x}}` and `{{input.y}}`; a lone placeholder passes the captured value through untouched, so an `extract` with `multiple` stays an array |
| `type` | `string`, `number`, `boolean` or `json`. Omitted, the value is returned exactly as captured; a cast that fails leaves the field out rather than emitting `NaN` |
| `required` | a run that cannot resolve the field **fails**, even when every step passed |

The raw captures stay on the run as `captures`, so a field that resolved to
nothing can be debugged against what the steps actually collected. Declared
outputs also appear in `browser_list_flows`, so an agent can pick a flow for
the value it returns rather than running it to find out.

Changing `steps` or `outputs` bumps the flow's `version`, and a run pins the
version it executed — renaming the flow does not.

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

### The flow editor

Flows live at **Operate → Browser → Flows**, and opening one opens the
editor: the playground's three panes with the flow attached.

![A flow's steps and run history](/screenshots/browser/13-flow-detail-run-history.jpg)

The left rail answers four questions about the flow.

- **Steps** — the ordered ledger. Every step shows the durable target it was
  recorded with, never a `ref`. The ⚡ on a row lifts a literal out of the step
  into an input; the marker between rows is where the next recorded step lands.
- **Inputs** — what a run supplies. It flags both disagreements that otherwise
  fail silently: a `{{input.x}}` no input declares, and an input no step uses.
- **Output** — the JSON declared above, shown beside what the selected run
  actually returned. **From page** reads a field straight off the live page:
  click it in the Elements list and it becomes a read step, a capture, and an
  output field in one move, with the value it just read shown to confirm you
  picked the right thing.
- **Runs** — history. Selecting a run puts its outcome on the step list, its
  JSON on the output tab, and its session in the preview.

**Author live** opens a session against the flow's browser and turns the
editor into a recorder: pick an element, run the action, and it lands in the
flow at the insertion point — ref stripped, and (unless you turn that off)
anything you typed lifted into an input rather than baked in. A read is given
a capture name automatically, so an output has something to point at.

#### Running steps while you build

The next step is built by clicking something on the page, so the page has to
be at the point where that something exists. **▶ on a step row** puts the live
session exactly there:

- **Forwards** it is a continuation — only the steps between where the session
  already is and the one you clicked, so a form is not submitted twice on the
  way.
- **Backwards** it restarts the session and replays from the top, because a
  browser cannot be rewound. ▶ on step 1 is therefore "start over".
- **Replay all** runs the whole flow into the session and *leaves it open* at
  the end, which is the difference between this and a test run.

The session's position is shown on the step list (a green edge on everything
it has passed) and the insertion marker follows it, so a recorded action lands
after the last step that ran rather than at the end of the list.

The **Elements** list keeps itself current whether or not it is the tab on
screen, so a page that moves on its own — a login redirect, a client-side
route change, a modal that renders a second later — is already reflected when
you switch to it. Each row is two columns: on the left how a step will address
the element (its role and accessible name), on the right what is in it right
now (a field's value or placeholder, a link's target). The filter searches
both, which is how you find one textbox among six. An element with no
accessible name shows where it sits instead — `generic › generic › button` —
and picking one asks the page for a real handle (a `data-testid` if the app
has one, otherwise a CSS path), because a step that stored only `role:
button` would match the first button on the page. (Turn the **Live** switch
off to freeze the list and the preview.)

Values for `{{input.x}}` while authoring come from the **Inputs** tab — each
declared input gets a field there. They stay in the browser and are never
saved to the flow; a run from the API or an agent supplies its own. An input
nobody has filled in yet does not block a replay: the placeholder is typed
literally, exactly as it would be in a run.

**Test run** is the check, not the build loop: it replays the flow in its own
fresh session, shows it landing one step at a time, and closes that session at
the end (a failed one is kept open so you can see the page it broke on).

The playground (`/dashboard/browser/playground`) stays what it is: a place to
drive a browser and find out what a page does. It builds nothing — its one
hand-off is **Record as flow**, which freezes the session into a draft and
opens it here.

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

![Browser overview: activity, flows, profile and session defaults](/screenshots/browser/05-browser-overview.jpg)

The overview leads with what the browser is DOING — live sessions, a 7-day
sparkline, recent runs, the flows recorded against it — rather than a static
list of its own fields. The signed-in profile and default session settings
sit below it, still one scroll away.

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

`/dashboard/browser/[browserId]` shows the profile's activity, its flows, and its signed-in profile and session defaults. `/dashboard/browser/[browserId]/sessions` lists every session for *that* profile.

**Sessions** in the left nav (`/dashboard/browser/sessions`) is the project-wide view: every session across every browser, with filters for browser, status and a **time range** (last hour / 24h / 7 days / 30 days / a custom range) — the question this page answers is "what ran last night and what is still open", which needs a time axis a single-browser list doesn't.

![Every session in the project, with time-range and status filters](/screenshots/browser/09-sessions-global.jpg)

The **Started by** column names where a session came from — an agent, a recorded flow, MCP, or a person driving it by hand — which is the first thing worth knowing when a session misbehaves.

### Playground

**Playground** (`/dashboard/browser/playground`) drives a session interactively: controls on the left, the live page on the right, so acting on an element never means losing sight of it.

![The playground: action composer on the left, live preview on the right](/screenshots/browser/16-playground-live-preview.jpg)

The right pane's **Elements** tab lists the page's interactive elements — clicking one fills the action composer with its durable target (the same `role` + `name` a recorded flow step stores), so discovering a step and recording it use the same gesture. **Console** surfaces the page's own console messages and failed requests, for when an action succeeded but the page didn't do what you expected.

Once a session has run a few steps, **Record as flow** freezes them into a flow — this is the fastest path from "I drove it once by hand" to "it runs every night".

## Distributed execution

Browser is one of the entity types the [Cluster](./cluster.md) layer can pin to a specific node. The `browserConsumer` registers a queue handler; when a profile is assigned to a node, all of its sessions and actions route through that node's queue. This matters when only some nodes have a real browser binary installed.

## Concurrency

Each profile has a concurrency ceiling defined by its `defaultSessionConfig` and the worker pool in `browserManager.ts`. When the ceiling is hit, new `createSession` calls are queued — the session starts as soon as a slot frees.

See the [Browser API reference](../api/browser.md) for the full endpoint list.
