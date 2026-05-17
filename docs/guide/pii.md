# PII Service

The PII service detects, redacts, masks, and (optionally) blocks personally identifiable information across 11 languages. Unlike the rest of the platform, it is **license-free** — every endpoint under `/api/pii/*` is available on every plan and is never gated by a license feature flag.

Operators manage policies under **Operate → PII**. Agents and external clients consume it either through stored policies or through ad-hoc detect/redact/mask calls.

## Concepts

- **Category** — a built-in PII class (`email`, `phone`, `creditCard`, `iban`, `nationalId`, `passport`, `address`, `ipAddress`, `url`, `socialHandle`, `apiKey`, `cryptoWallet`, `birthDate`, `swift`). Each category ships with multi-language detectors.
- **Policy** — a named, project-scoped configuration that picks which categories are enabled, which languages to scan, a default action (`detect | redact | mask | block`), and any custom regex patterns.
- **Action**
  - `detect` — return findings only (no transformation)
  - `redact` — replace matches with `[REDACTED_<CATEGORY>]`
  - `mask` — partially obfuscate the match (preserve first/last characters where applicable)
  - `block` — surface a structured rejection that callers (e.g. inference) can short-circuit on

## Supported Languages

`global`, `en`, `tr`, `de`, `fr`, `es`, `it`, `pt`, `ar`, `ja`, `zh`. A policy can pick a subset; if none is set, the detector falls back to `global` + the request locale.

## Policies

Policies are stored in the tenant database (`pii_policies`) and scoped to a project. Create them in the dashboard or via API:

```bash
curl -X POST https://console.example.com/api/pii/policies \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Customer support intake",
    "defaultAction": "redact",
    "categories": { "email": true, "phone": true, "creditCard": true },
    "languages": ["en", "tr"],
    "customPatterns": [
      { "name": "internal-ticket", "pattern": "TCKT-\\d{6}", "category": "custom", "action": "mask" }
    ]
  }'
```

Once stored, the policy can be applied to any text via `POST /api/pii/scan` using its `policy_key`.

## Ad-hoc usage

For one-off requests the service exposes three stateless endpoints — no policy needed:

```bash
# Detect only
curl -X POST https://console.example.com/api/pii/detect \
  -d '{ "text": "Email me at alice@example.com", "locale": "en" }'

# Redact in place
curl -X POST https://console.example.com/api/pii/redact \
  -d '{ "text": "Card 4111 1111 1111 1111", "categories": { "creditCard": true } }'

# Partial mask
curl -X POST https://console.example.com/api/pii/mask \
  -d '{ "text": "+90 532 555 22 33" }'
```

The dashboard playground (under **Operate → PII**) uses these endpoints to give an instant preview while editing a policy.

## Relationship to Guardrails

The [Guardrails](./guardrails.md) PII type wraps this service. When a guardrail of type `pii` is attached to a model:

1. On every inference request the runtime calls `scanWithPolicy()` against the configured PII policy.
2. If the policy's effective action is `block`, the request is short-circuited with a `guardrail_violation` error containing the findings.
3. If the action is `redact` or `mask`, the runtime substitutes the transformed text before forwarding to the provider.

Use a **guardrail** when you want PII enforcement inside the inference pipeline. Use the **PII service directly** when you need detect/redact/mask outside an LLM call (ingestion pipelines, audit jobs, ETL).

## Service catalog

In the dashboard nav the PII service lives under **Operate**. It carries a `new` badge in the launcher and is keyword-searchable by `pii`, `redact`, `mask`, `kvkk`, `gdpr`, `kişisel veri`.

See the [PII API reference](../api/pii.md) for the full request/response schema.
