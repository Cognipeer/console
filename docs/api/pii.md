# PII API

The PII service detects, redacts, and masks personally identifiable information. **License-free** — every endpoint here works on every plan.

All endpoints sit under the dashboard API surface (cookie / session authenticated):

```
POST/GET/PATCH/DELETE  /api/pii/*
```

There is no separate `/api/client/v1/pii/*` namespace today — token-authenticated callers should use the dashboard endpoints with the appropriate session context.

## Categories Catalog

```http
GET /api/pii/categories?locale=tr&languages=tr,en
```

Returns the built-in PII category list (localized), the default policy categories, and the full list of supported languages.

#### Response

```json
{
  "categories": [
    { "key": "email", "label": "E-posta", "description": "...", "languages": ["global", "en", "tr"] },
    { "key": "phone", "label": "Telefon", ... }
  ],
  "defaults": { "email": true, "phone": true, "creditCard": true, ... },
  "supportedLanguages": ["global", "en", "tr", "de", "fr", "es", "it", "pt", "ar", "ja", "zh"]
}
```

## Policies

### List

```http
GET /api/pii/policies?enabled=true&search=invoice
```

### Create

```http
POST /api/pii/policies
```

```json
{
  "name": "Customer support intake",
  "description": "Redact PII from inbound tickets",
  "defaultAction": "redact",
  "categories": { "email": true, "phone": true, "creditCard": true },
  "customPatterns": [
    { "name": "internal-ticket", "pattern": "TCKT-\\d{6}", "category": "custom", "action": "mask" }
  ],
  "languages": ["en", "tr"],
  "enabled": true
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Display name. |
| `defaultAction` | `detect \| redact \| mask \| block` | no (default `detect`) | Action applied when a category fires. |
| `categories` | `Record<string, boolean>` | no | Defaults to `buildDefaultPolicyCategories()`. |
| `customPatterns` | array | no | Caller-defined regex rules. |
| `languages` | string[] | no | Subset of supported languages; omit to fall back to global + request locale. |
| `enabled` | boolean | no (default `true`) | |
| `metadata` | object | no | Free-form. |

### Get / Update / Delete

```
GET    /api/pii/policies/:id
PATCH  /api/pii/policies/:id
DELETE /api/pii/policies/:id
```

## Ad-hoc detection

Three stateless endpoints; no policy required.

### Detect

```http
POST /api/pii/detect
```

```json
{
  "text": "Email me at alice@example.com",
  "categories": { "email": true },
  "languages": ["en"],
  "locale": "en"
}
```

#### Response

```json
{
  "findings": [
    { "category": "email", "value": "alice@example.com", "start": 12, "end": 29 }
  ]
}
```

### Redact

```http
POST /api/pii/redact
```

Same body as `detect`. Returns `{ findings, text }` where `text` has each match replaced with `[REDACTED_<CATEGORY>]`.

### Mask

```http
POST /api/pii/mask
```

Same body as `detect`. Returns `{ findings, text }` where each match is partially obfuscated (preserving first/last characters where applicable).

## Scan with stored policy

```http
POST /api/pii/scan
```

```json
{
  "policy_key": "customer-support-intake",
  "text": "User said: Email me at alice@example.com",
  "action": "redact",
  "locale": "en"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `policy_key` (or `policyKey`) | string | yes | Stored policy key. |
| `text` | string | yes | Body to scan. |
| `action` | `detect \| redact \| mask \| block` | no | Override the policy's default action. |
| `locale` | string | no | Detection locale. |

#### Response

```json
{
  "policyKey": "customer-support-intake",
  "action": "redact",
  "findings": [...],
  "text": "User said: Email me at [REDACTED_EMAIL]",
  "blocked": false
}
```

`blocked: true` is set when the effective action is `block` and at least one finding fired — callers should treat that as a refusal.

## Errors

| Status | Cause |
|---|---|
| 400 | Missing/invalid body — e.g. `text` not a string, `defaultAction` out of range. |
| 404 | Unknown policy id or `policy_key`. |
| 500 | Internal error. |
