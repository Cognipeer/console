# Route requests with a Dynamic LLM

A Dynamic LLM is a Model Hub entry that has no provider behind it. It carries a routing
configuration instead, and at call time it resolves to one of your real models — either by evaluating
ordered rules against signals taken from the request, or by asking a decider model to classify the
request into a label.

Callers address it like any other model: same base URL, same `model` field, one key. Nothing changes
on the client side when you later re-point the router at different models.

::: tip Who this is for
The click-paths are written so an operations lead can build a router without touching code. Each
section then gives the engineer the payload, the exact signal semantics and the trap.
:::

## What you get

- One model key — say `smart-router` — that callers put in `model` instead of choosing a model per
  request.
- A recorded decision for every request: which rule or label fired, which model actually ran, and the
  signals that produced the choice. Readable on the model's **Routing** tab.
- An optional fallback model that runs when the chosen model throws.

| Strategy | How the target is chosen | Extra cost per request |
|---|---|---|
| **Rule-based** | Ordered rules evaluated against signals computed from the request body. First match wins. | None — the rules are arithmetic on the request. |
| **Model-based (decider)** | A classifier model reads the latest user message and returns one of your labels; the label picks the target. | One extra model call, billed to the decider model. |

Rule-based routing is deterministic and free. Reach for the decider only when the split you need
depends on meaning rather than on shape — "is this a support question or a code question" — and accept
that you are paying a model call and adding its latency to every request.

## Before you start

| You need | Where |
|---|---|
| At least two LLM models in the active project | [Create your first model](/how-to/first-model) |
| Pricing filled in on the default model, if you want to route on cost | Model Hub → the model → **Edit model** |
| An API token to call the router with | **Settings → API Tokens** → **Create Token** |

Routing targets are drawn from LLM models in the active project only. Models of any other category —
embedding, rerank, speech-to-text, text-to-speech, OCR — are not offered, and neither are other
Dynamic LLMs. If the project has no LLM models, the form says so and there is nothing to select.

## Create the router

Open **Model Hub** in the left nav, then **Dynamic LLM** in the sub-nav. That item is a shortcut: it
opens the model list at `?create=dynamic` with the **Create Dynamic LLM** form on top of it —
"Route each request to a different model by rules or by a decider model." Closing the form drops the
`create` parameter and leaves you on the list.

The form has four sections and a footer that reads **3 of 3 ready** once the checklist — **Name set**,
**Default model chosen**, **Rules configured** (or **Decider & labels configured**) — is complete.

### 1. Identity

| Field | Notes |
|---|---|
| **Display name** | Required. |
| **Key** | Leave blank to auto-generate from the display name. This is the value callers put in `model`. The form locks the field once the router exists — its hint reads "Key is immutable after creation." |
| **Description** | Optional. |

### 2. Strategy

Pick **Rule-based** or **Model-based (decider)**. The choice decides whether section 4 is **Rules** or
**Decider**; everything else is identical.

### 3. Default & fallback

| Field | When it runs |
|---|---|
| **Default model** | Required. Runs when no rule matches, and whenever the decider fails or returns something that does not map to a label. |
| **Fallback model** | Optional. Runs only when the chosen model **throws**. |

Both selects list your LLM models as `Display name · key`.

### 4a. Rules (rule-based)

Each rule card has a **Label** (free text, used in the decision badge and the reason line), a
**Route to** target model, a **Match** control set to **All conditions** or **Any condition**, and one
or more conditions. **Add condition** and **Add rule** extend the form.

Rules are evaluated top to bottom and the first match wins. Order them from most specific to least.

These are the eight signals, exactly as the form lists them:

| Signal | Type | How it is computed |
|---|---|---|
| **Estimated input tokens** | number | Total characters of the text content across **all** messages, divided by 4 and rounded up. No tokenizer is involved. Image parts and tool definitions contribute nothing. |
| **Message count** | number | Number of entries in `messages`, all roles included. |
| **Last user message length** | number | Character count of the most recent `user` message. |
| **Estimated cost in USD (at default model pricing)** | number | Estimated input tokens priced at the **default model's** input rate, plus `max_tokens` × its output rate when the caller sent `max_tokens`. Output size is unknowable before the call, so without a cap the estimate is input-only. |
| **Request uses tools** | boolean | `tools` is a non-empty array, **or** `tool_choice` is present and not `"none"`. |
| **Structured output requested** | boolean | `response_format` is present and not null. |
| **Request has images** | boolean | Any message part typed `image_url`, `image` or `input_image`, or carrying an `image_url` key. |
| **Keyword in last user message** | text | Substring or regular-expression match against the most recent `user` message. Both are case-insensitive. |

And the operators. The form offers only the ones valid for the selected signal; changing the signal
resets the operator and clears the value.

| Operator | Applies to |
|---|---|
| **> greater than**, **≥ at least**, **< less than**, **≤ at most**, **= equals**, **≠ not equals** | the four numeric signals |
| **is true**, **is false** | the three boolean signals |
| **contains**, **matches (regex)** | **Keyword in last user message** |

A typical two-rule router: send anything with images or tools to the capable model, send short
conversations to the cheap one, and let everything else fall through to the default.

::: warning The cost signal is conditional
**Estimated cost in USD** is computed only when a rule actually references it, and only under the
rule-based strategy. If the lookup of the default model fails, or the default model has no pricing,
the signal stays unset — and an unset signal never satisfies a condition, whichever operator you used.
A default model left on the create form's zero pricing makes every estimate exactly `0`, so
`> 0.01` never fires and `< 0.05` always does.
:::

### 4b. Decider (model-based)

| Field | Notes |
|---|---|
| **Decider model** | Required. Any LLM model in the project. It is called once per request, at temperature 1 with a 256-token cap. |
| **Prompt override** | Optional. Replaces the built-in classification system prompt in full. |
| **Label** | Required per card. The exact string the decider is expected to return. |
| **Route to** | Required per card. The model that label routes to. |
| **Description** | Free text that "Helps the decider tell labels apart" — it is injected into the built-in prompt next to the label. |

**Add label** adds cards; two are present by default.

The built-in prompt sends the decider a system message listing every `"label": description` pair and
instructing it to answer with the label alone, plus one user message containing the latest user
message text (or `(empty request)` when there is none). The answer is matched back to a label
case-insensitively: an exact match first, then a substring match, so `Category: simple` still resolves
to `simple`.

::: danger A prompt override replaces the label list too
The override is used instead of the whole built-in system prompt, not merged with it. If you supply
one, you must list your labels in it yourself. Leave it blank unless you have a concrete reason —
an override that omits the labels leaves the decider with no vocabulary, so every answer fails to
match and every request lands on the default model.
:::

The decider sees the latest user message and nothing else. Not the system prompt, not earlier turns,
not tools, not images. Route on those with rules instead.

Press **Create Dynamic LLM**. The router appears in the model list with a teal `dynamic` badge in the
**Type** column instead of a category badge.

## Watch the decisions

Open the router from the model list. A Dynamic LLM's detail page carries a **Routing** tab that
regular models do not have, and no **Playground** tab — there is no provider runtime to play against.

The tab's left pane lists recent routing decisions:

| Column | Contents |
|---|---|
| **When** | Relative timestamp. |
| **Routed to** | The model key that actually ran. |
| **Decision** | `rule`, `model`, `default` or `fallback`, with the matched rule label or decider label appended. `fallback` renders as a warning badge. |
| **Reason** | The full sentence explaining the choice — this is the column that matters. |
| **Latency** | Round-trip for the router row. |

Rows are clickable and open the full log entry, which carries the signals that were computed. The
right pane restates the live configuration: strategy, default, fallback, and every rule or label with
its target. Before any traffic arrives the tab reads "No routing decisions recorded yet. Send a
request to this model key to see how it routes."

Router decisions are also visible on the **Logs** tab, recorded under the route
`chat.completions.router`.

::: danger Read the reason column, not the error rate
When the decider call fails, or returns a label you do not recognise, the router does not error. It
routes to the default model and writes the explanation into `reason` —
`Decider failed (…); used default model` or
`Decider returned an unrecognized label "…"; used default model`. The request succeeds, the caller
sees nothing unusual, and your error rate stays flat while every request quietly runs on the default
model. A router whose decisions are overwhelmingly `default` is a broken router, not a quiet one.
:::

## The same thing over the API

### Calling the router

Nothing special — it is a model key on the standard OpenAI-compatible endpoint:

```bash
curl -s https://<host>/api/client/v1/chat/completions \
  -H "Authorization: Bearer cpeer_…" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "smart-router",
    "messages": [{ "role": "user", "content": "Summarise this ticket in one line." }]
  }'
```

The response body is the child model's response, passed through untouched. Its `model` field is
therefore the **child** key, not the router key — that is how a caller learns which model answered.
The same holds for streaming chunks.

`GET /api/client/v1/models` lists routers alongside real models, with `owned_by` set to `dynamic`.

Passing your own `request_id` in the request body makes the router's decision row and the child's
usage row share one id, which is the easiest way to correlate them. Without it the router row records
the child's id in `childRequestId`.

### Creating a router

```
POST /api/client/v1/models/dynamic     # Bearer cpeer_… token
POST /api/models/dynamic               # browser session (what the form uses)
```

::: warning Two endpoints, one body
Both take the body below and return `201 {"model": …}`. The client endpoint authenticates with
`Authorization: Bearer cpeer_…` and creates the router in the token's project. `/api/models/*`
authenticates with a browser session and the `active_project_id` cookie — a `cpeer_` token cannot
drive it. Only the dashboard endpoint checks the project's model quota, returning `429` when it is
full.
:::

Body — rule-based:

```json
{
  "name": "Smart router",
  "key": "smart-router",
  "description": "Cheap by default, capable when the request needs it",
  "dynamic": {
    "strategy": "rule-based",
    "defaultModelKey": "gpt-4o-mini",
    "fallbackModelKey": "claude-haiku",
    "rules": [
      {
        "label": "complex",
        "targetModelKey": "gpt-4o",
        "matchType": "all",
        "conditions": [
          { "signal": "inputTokensEst", "operator": "gt", "value": 4000 },
          { "signal": "hasTools", "operator": "isTrue" }
        ]
      },
      {
        "label": "vision",
        "targetModelKey": "gpt-4o",
        "matchType": "any",
        "conditions": [{ "signal": "hasImages", "operator": "isTrue" }]
      }
    ]
  }
}
```

Body — model-based:

```json
{
  "name": "Intent router",
  "dynamic": {
    "strategy": "model-based",
    "defaultModelKey": "gpt-4o-mini",
    "decider": {
      "modelKey": "gpt-4o-mini",
      "labels": [
        { "label": "simple", "description": "Small talk, short factual questions", "targetModelKey": "gpt-4o-mini" },
        { "label": "complex", "description": "Multi-step reasoning, code, analysis", "targetModelKey": "gpt-4o" }
      ]
    }
  }
}
```

Config fields:

| Field | Required | Notes |
|---|---|---|
| `strategy` | yes | `rule-based` or `model-based`. |
| `defaultModelKey` | yes | Model key, not an id. |
| `fallbackModelKey` | no | Model key. |
| `rules[]` | rule-based | At least one. Each needs `targetModelKey` and at least one condition. `matchType` defaults to `all`. |
| `decider.modelKey` | model-based | Required. |
| `decider.labels[]` | model-based | At least one; each needs `label` and `targetModelKey`. |
| `decider.promptOverride` | no | Replaces the whole classification prompt. |

Rejections come back as `400` with the failing rule stated —
`rule-based routing requires at least one rule`, `every rule needs a targetModelKey`,
`the decider needs at least one label`, and so on.

Boolean conditions carry no `value`; a numeric condition's `value` is coerced with `Number()`, so
anything that does not parse as a number never matches; a `keyword` condition's `value` is the
substring or pattern.

### Editing a router

```
PUT /api/client/v1/models/:id     { "settings": { "dynamic": { … } } }
PUT /api/models/:id               { "settings": { "dynamic": { … } } }
```

`settings` is merged shallowly, so `dynamic` is replaced wholesale — send the complete object, not a
patch. Neither path re-runs the create-time validator, so a malformed config written here is accepted
and only surfaces at call time. The **Edit model** action on a router opens the same
**Edit Dynamic LLM** form rather than the standard model edit page, which is the safe way to do it.

## Chaining and the depth cap

Routing recurses, with a hard cap of **3**. A router resolving to another router increments the depth,
and the fourth level throws `Dynamic routing depth exceeded (3) resolving model "…"`. The decider call
consumes one level of that depth too.

The form never lets you build a chain — routers are excluded from the target lists — so this only
happens through the API. A router that resolves to itself is caught separately: the target is rewritten
to the default model, and if the default *is* the router, the request fails unless a fallback model is
configured.

## What will bite you

::: danger A router prices at zero
A Dynamic LLM is created with `inputTokenPer1M`, `outputTokenPer1M` and `cachedTokenPer1M` all set to
`0`, and there is no pricing form for it. The cost of a routed request is attributed to the **child**
model, which logs its own usage row at its own prices. Two consequences:

- The router's row mirrors the child's **token counts** for traffic accounting. Tokens therefore appear
  twice across the usage rollups — once against the router at zero cost, once against the child at real
  cost. Cost never doubles; token totals summed across all models do. Filter by model key.
- Budget consumption is priced from the model key the **caller addressed**. Because that is the router,
  and the router prices at zero, requests sent to a router do not draw down a budget. Budgets are still
  checked before the call; they simply are not incremented by this traffic.
:::

::: danger The fallback model only catches throws
`fallbackModelKey` fires when the chosen child model raises an error — provider outage, bad
credentials, unknown model key. A slow answer does not trigger it. A truncated, low-quality or
off-topic answer does not trigger it. There is no latency budget and no quality check. If the fallback
also throws, the error is logged against the router and propagated to the caller.
:::

| | |
|---|---|
| Guardrails bound to the router never run | Routing resolves before any guardrail work, so only the **child** model's input and output guardrails apply. Bind them there. |
| Semantic cache on the router never runs | Same reason. Enable it on the child models. |
| Agents cannot use a router as their model | Agents build a provider runtime directly from the model's provider, and a router has none. Point agents at real models. |
| No Playground tab | There is nothing to invoke locally; exercise the router over the gateway. |
| Streaming rows carry no tokens | For a streaming request the router's decision row is logged with empty usage. The child still logs its own. |
| An invalid regex is silently false | A `matches (regex)` condition with a broken pattern evaluates to `false` rather than raising. |
| Rules are ordered | First match wins, and a broad rule placed first makes everything below it dead. |
| Evaluation targets work | An evaluation target pointing at a router runs through the gateway path and routes normally, so you can A/B a router against a fixed model on the same dataset. |

## Where to go next

- [How to optimize token usage](/how-to/optimize-token-usage) — measure first, then decide what to
  split off onto a cheaper model
- [Model Hub](/guide/model-hub) — models, keys and pricing
- [Model Inference](/guide/inference) — the gateway, honoured parameters and error shapes
- [Evaluation & Analysis](/guide/evaluation-and-analysis) — proving the cheap model is good enough
  before you route traffic to it
