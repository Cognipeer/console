# PII API

Detect, redact, mask, and reversibly **tokenize** personally identifiable information. **License-free** — every endpoint works on every plan.

All endpoints are token-authenticated and live under the client surface:

```
POST /api/client/v1/pii/*
```

Send a Bearer token in the `Authorization` header (see [overview](./overview.md)):

```bash
curl -X POST https://gateway.example.com/api/client/v1/pii/tokenize \
  -H "Authorization: Bearer cpeer_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{ "policy_key": "support-intake", "text": "..." }'
```

## Everything is policy-based

Every detection endpoint (`detect`, `redact`, `mask`, `tokenize`, `scan`) **requires a `policy_key`**. The policy — created and managed in the dashboard (**Operate → PII**) — decides *what* is detected: which built-in categories are enabled, which custom regex patterns run, which languages are scanned, and the severities. The endpoint decides *what happens* to matches (the action). This keeps all PII behaviour controllable and auditable per policy.

- Get a policy's key from the dashboard: **Operate → PII → open a policy → API Usage → Policy Key** (or the key shown under the policy title).
- The named endpoints (`detect`/`redact`/`mask`/`tokenize`) pin the action. `scan` applies the policy's default action, or an override.
- `detokenize` is the one exception — it only reverses tokens using the vault, so it needs no policy.

## Common request fields

`detect`, `redact`, `mask`, and `tokenize` share the same body:

| Field | Type | Required | Description |
|---|---|---|---|
| `policy_key` | string | yes | Key of the stored policy to apply. |
| `text` | string | yes | Text to scan. |
| `locale` | string | no | Locale for finding labels/messages (default `en`). |

> Categories, custom regex patterns, and languages are **not** sent per request — they come from the policy. Configure them once in the dashboard.

Common response fields:

| Field | Description |
|---|---|
| `policy_key` / `policy_name` | The applied policy. |
| `action` | The action applied (`detect`, `redact`, `mask`, `tokenize`, `block`). |
| `findings` | Detected occurrences (category, value, offsets, severity, replacement). |
| `output_text` | The transformed text (equals input for `detect`). |
| `input_length` | Character length of the input. |
| `has_blocking` | Whether any finding is blocking. |
| `languages` | Languages used for the scan (from the policy). |
| `vault` | **Only for `tokenize`** — token → original-value map. |

## Detect

```
POST /api/client/v1/pii/detect
```

Return findings without transforming the text, using the policy's configuration.

```json
{ "policy_key": "support-intake", "text": "Wire to IBAN TR33 0006 1005 1978 6457 8413 26 before Friday" }
```

```json
{
  "policy_key": "support-intake",
  "policy_name": "Support Intake",
  "action": "detect",
  "findings": [
    { "category": "iban", "value": "TR33 0006 1005 1978 6457 8413 26", "start": 13, "end": 45, "severity": "high" }
  ],
  "output_text": "Wire to IBAN TR33 0006 1005 1978 6457 8413 26 before Friday",
  "input_length": 58,
  "has_blocking": false,
  "languages": ["global", "tr"]
}
```

## Redact

```
POST /api/client/v1/pii/redact
```

Replace each match with `[REDACTED_<CATEGORY>]`.

```json
{ "policy_key": "support-intake", "text": "Cardholder paid with 4111 1111 1111 1111" }
```
→ `"output_text": "Cardholder paid with [REDACTED_CREDITCARD]"` (if `creditCard` is enabled in the policy)

## Mask

```
POST /api/client/v1/pii/mask
```

Partially obfuscate each match, preserving recognizable edges.

```json
{ "policy_key": "support-intake", "text": "Reach me at jane.doe@acme.com or 0532 111 22 33" }
```
→ `"output_text": "Reach me at j*******@acme.com or 0*** *** ** 33"`

## Tokenize (reversible masking)

```
POST /api/client/v1/pii/tokenize
```

Replace each match with a unique, reversible token (`[EMAIL_1]`, `[IPADDRESS_1]`, …) and return a **vault** that maps every token back to its original value. Identical values share one token (a phone number appearing twice yields a single `[TR_PHONE_1]`).

Use this to round-trip text through an LLM without exposing PII: tokenize the prompt, send the tokenized text to the model, then [`detokenize`](#detokenize-restore-originals) the model's response with the same vault.

```json
{ "policy_key": "support-intake", "text": "User 10000000146 logged in from 192.168.1.42 and emailed ops@acme.com" }
```

```json
{
  "policy_key": "support-intake",
  "policy_name": "Support Intake",
  "action": "tokenize",
  "output_text": "User [TC_KIMLIK_1] logged in from [IPADDRESS_1] and emailed [EMAIL_1]",
  "input_length": 69,
  "has_blocking": false,
  "languages": ["global", "tr"],
  "findings": [ /* … */ ],
  "vault": {
    "[TC_KIMLIK_1]": { "value": "10000000146", "category": "tc_kimlik" },
    "[IPADDRESS_1]": { "value": "192.168.1.42", "category": "ipAddress" },
    "[EMAIL_1]":     { "value": "ops@acme.com", "category": "email" }
  }
}
```

> Only categories enabled in `support-intake` are tokenized. To also capture, say, IP addresses, enable `ipAddress` in the policy.

## Detokenize (restore originals)

```
POST /api/client/v1/pii/detokenize
```

Reverse a prior tokenize call. **No `policy_key`** — the vault fully determines the reversal.

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | Text containing tokens (e.g. an LLM response). |
| `vault` | object | yes | The vault returned by a prior `tokenize` call. |

```json
{
  "text": "Blocked the session for [TC_KIMLIK_1]; flagged the IP [IPADDRESS_1].",
  "vault": {
    "[TC_KIMLIK_1]": { "value": "10000000146", "category": "tc_kimlik" },
    "[IPADDRESS_1]": { "value": "192.168.1.42", "category": "ipAddress" }
  }
}
```
→ `{ "output_text": "Blocked the session for 10000000146; flagged the IP 192.168.1.42." }`

Tokens absent from the vault are left untouched, so a model that drops or rewrites a token simply leaves it in place. The call is **stateless** — no PII is persisted server-side; your application holds the vault for the duration of the round-trip.

### End-to-end LLM round-trip

```bash
# 1) Tokenize the prompt with a policy
TOK=$(curl -s -X POST $BASE/api/client/v1/pii/tokenize \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "policy_key": "support-intake", "text": "Refund the order for sara@acme.com, card 5555 5555 5555 4444" }')
#   → output_text: "Refund the order for [EMAIL_1], card [CREDITCARD_1]"

# 2) Send output_text to the model; it replies echoing the tokens:
#    "I refunded [CREDITCARD_1] and emailed [EMAIL_1] the receipt."

# 3) Detokenize the model reply with the same vault (no policy needed)
curl -s -X POST $BASE/api/client/v1/pii/detokenize \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{ "text": "I refunded [CREDITCARD_1] and emailed [EMAIL_1] the receipt.", "vault": '"$(echo "$TOK" | jq .vault)"' }'
#   → "I refunded 5555 5555 5555 4444 and emailed sara@acme.com the receipt."
```

## Scan (action chosen by the policy)

```
POST /api/client/v1/pii/scan
```

Like the named endpoints, but the action comes from the policy's default — or an explicit override.

```json
{
  "policy_key": "customer-support-intake",
  "text": "Caller +90 532 555 22 33 emailed alice@example.com",
  "action": "tokenize",
  "locale": "en"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `policy_key` | string | yes | Stored policy key. |
| `text` | string | yes | Body to scan. |
| `action` | string | no | Override the policy default: `detect \| redact \| mask \| block \| tokenize`. |
| `locale` | string | no | Detection locale. |

When the effective action is `tokenize`, the response includes a `vault` just like `/tokenize`.

## Errors

| Status | Cause |
|---|---|
| 400 | Missing/invalid body — `policy_key` or `text` not a string, `vault` not an object, invalid `action`. |
| 401 | Invalid or missing API token. |
| 404 | Unknown `policy_key`. |
| 500 | Internal error. |
