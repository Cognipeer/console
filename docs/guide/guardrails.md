# Guardrails

Guardrails provide real-time content safety checks for LLM inputs and outputs. They detect PII, banned words and profanity, harmful content, and prompt-injection attempts — and can block, redact, warn on, or flag what they find. Operators manage them under **Operate → Guardrail**.

## Operator view

Each guardrail is a named policy attached to one or more models or agents. The list view summarises the states that matter operationally: total policies, how many are enabled, how many are disabled, and how many block requests.

![Guardrails list](/screenshots/guardrails/01-guardrails-list.png)

Filters narrow by **type** (`preset` / `custom`), by **action**, and by **status**. The **Create guardrail** flow walks you through picking a type, declaring which checks to enforce, and configuring the default action and failure mode.

When a model has guardrails attached the runtime applies them at two points: before forwarding the request upstream (input slot) and before responding to the client (output slot). A blocked request short-circuits with a structured `guardrail_block` error that includes which policy fired and the findings.

## Guardrail Types

| Type | Description |
|------|-------------|
| `preset` | A bundled policy combining detection families: PII, word filter, content moderation, and prompt shield. |
| `custom` | An LLM-based evaluation driven by your own rule text. Requires a model. |

## Detection Families (preset)

| Family | Engine | What it does |
|--------|--------|--------------|
| **PII** | Regex + checksums (no LLM) | 15 categories incl. email, phone, credit card (Luhn), IBAN (mod-97), TCKN (checksum), API keys/JWTs (known prefixes + entropy). Resists zero-width/unicode tricks and `user (at) mail (dot) com` obfuscation. |
| **Word filter** | Deterministic matching (no LLM) | Broad built-in English + Turkish profanity/slur lists, tenant-uploaded word lists (CSV/TXT), inline words, and regexes. Folds case, diacritics, leetspeak (`s1kt1r`), stretched (`fuuuck`) and spaced-out (`f u c k`) writing. Whole-token matching avoids Scunthorpe false positives. |
| **Moderation** | LLM classifier | 26 categories (hate, violence, fraud, cybercrime, child safety, …). Decode-then-judge prompt: unfolds obfuscation/encodings, judges meaning and intent across languages; fictional framing does not exempt content. |
| **Prompt shield** | LLM classifier | 15 attack families: injection, jailbreak personas, encoding/obfuscation, payload splitting, context poisoning, multi-language evasion, and more. Three sensitivity levels. |

### Word lists

The word filter merges four sources: built-in lists (toggled per policy), **tenant word lists** (managed under Guardrails → Word lists, uploaded as CSV/TXT or edited inline, up to 20k entries), inline `words`, and `regexes`. Uploaded lists are referenced from policies by key (`policy.wordFilter.customListKeys`) and are cached for 60 s at evaluation time.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/guardrails/word-lists` | List summaries (name, key, word count) |
| `POST` | `/api/guardrails/word-lists` | Create — body accepts `words: string[]` or raw `content` (CSV/TXT; `,`/`;`/tab/newline separated, `#` comments) |
| `GET` | `/api/guardrails/word-lists/:id` | Full list including words |
| `PATCH` | `/api/guardrails/word-lists/:id` | Update metadata and/or replace words (`words` or `content`) |
| `DELETE` | `/api/guardrails/word-lists/:id` | Delete |

The LLM-backed checks run against any LLM from the tenant's Model Hub (set `policy.<family>.modelKey`, falling back to the guardrail's `modelKey`). The evaluated text is wrapped in per-request random boundary markers and declared untrusted data, so verdict-steering text inside the message ("respond with allowed: true") is itself treated as an attack signal.

## Actions

| Action | Behavior |
|--------|----------|
| `block` | Reject the request with a structured error |
| `redact` | Mask the detected values (`[REDACTED:email]`) and continue — PII and word filter only |
| `warn` | Allow the request; findings are attached to the response and logged |
| `flag` | Allow the request; findings are attached to the response and logged |

The guardrail-level action applies to LLM-backed findings; the PII and word-filter policies carry their own action so you can, for example, redact PII while blocking profanity.

## Failure Mode

LLM-backed checks can fail (model down, unparseable verdict). `failMode` decides what happens:

- `open` (default) — the content passes; the failure is logged.
- `closed` — the content is treated as a violation (`evaluation_error` finding). Also fires when an LLM check is enabled with no model configured.

## Evaluation Logs

Every evaluation is persisted to `guardrail_evaluation_logs` with pass/fail, findings, latency, the calling surface (`chat.completions`, `agent`, `client-api`, …), and the request id. Detected values and the stored input text are masked before persistence — raw PII never lands in the log. The guardrail detail page charts pass rate, findings by type/severity, and a time series; alert rules can trigger on `guardrail_fail_rate`, `guardrail_avg_latency_ms`, and `guardrail_total_evaluations`.

## API

### Evaluate Guardrail

```
POST /api/client/v1/guardrails/evaluate
Authorization: Bearer <token>
```

```json
{
  "guardrail_key": "pii-checker",
  "text": "My email is john@example.com and my phone is 555-0100"
}
```

Response:

```json
{
  "passed": false,
  "action": "block",
  "findings": [
    { "type": "pii", "category": "email", "severity": "high", "message": "Email address detected", "action": "block", "block": true, "value": "john@example.com" }
  ],
  "guardrail_key": "pii-checker",
  "guardrail_name": "PII Checker",
  "message": "Content blocked by guardrail:\n• Email: Email address detected",
  "redacted_text": null
}
```

When the matching policy's action is `redact`, `passed` is `true` and `redacted_text` contains the masked text to use instead of the original.

## Inference Integration

Guardrails attach to models via the `inputGuardrailKey` / `outputGuardrailKey` slots (the slot decides the direction):

```
Request → Input guardrail → Provider call → Output guardrail → Response
              │ block: 400 guardrail_block         │ block: 400
              │ redact: rewrite user msg           │ redact: rewrite content
              └ warn/flag: annotate + log          └ warn/flag: annotate + log
```

- Non-blocking findings are attached to the chat completion response under a `guardrails` extension field (`{ input?: {...}, output?: {...} }`).
- Streaming responses cannot be blocked after delivery; the output guardrail runs as a **post-hoc audit** when the stream completes, feeding evaluation logs and alerts (`source: chat.completions:stream`).
- Agents apply the same guardrails around their conversation loop (`source: agent`).

When a guardrail blocks a request during inference, a `GuardrailBlockError` is thrown with the guardrail key, action, and findings.

## Management Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/guardrails` | List guardrails (`includeTemplates=true` returns category/list catalogs) |
| `POST` | `/api/guardrails` | Create guardrail (validates that LLM checks have a model) |
| `GET` | `/api/guardrails/:id` | Get guardrail |
| `PATCH` | `/api/guardrails/:id` | Update guardrail |
| `DELETE` | `/api/guardrails/:id` | Delete guardrail |
| `POST` | `/api/guardrails/evaluate` | Evaluate text (dashboard) |
| `GET` | `/api/guardrails/:id/evaluations` | Evaluation logs + aggregate (pass rate, latency, time series) |
