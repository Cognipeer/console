# Guardrails API

Endpoint for evaluating content against guardrail rules.

## Evaluate

```
POST /api/client/v1/guardrails/evaluate
```

### Request

```json
{
  "guardrail_key": "pii-checker",
  "text": "My email is john@example.com and my phone is 555-0100",
  "target": "input"
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `guardrail_key` | string | Yes | Key of the guardrail to evaluate |
| `text` | string | Yes | Content to evaluate |
| `target` | string | No | `input`, `output`, or `both` (default: `input`) |

### Response

```json
{
  "passed": false,
  "guardrail_key": "pii-checker",
  "guardrail_name": "PII Checker",
  "action": "flag",
  "findings": [
    { "category": "email", "message": "Email address detected", "block": false },
    { "category": "phone", "message": "Phone number detected", "block": false }
  ],
  "message": null
}
```

### Response Fields

| Field | Description |
|-------|-------------|
| `passed` | `true` if no findings triggered, `false` otherwise |
| `guardrail_key` | Key of the evaluated guardrail |
| `guardrail_name` | Display name |
| `action` | Configured action: `block`, `flag`, or `redact` |
| `findings` | Array of detected issues |
| `message` | Optional message for blocked content |

## Guardrail Types

| Type | Evaluation Method |
|------|------------------|
| PII Detection | Regex-based pattern matching (15 categories) |
| Content Moderation | Category-based content evaluation |
| Prompt Shield | Prompt injection detection |
| Custom Prompt | LLM-based evaluation with custom rules |

## Inference Integration

Guardrails can be attached to models and evaluated automatically during chat completions. When a guardrail blocks a request, the chat API returns:

```json
{
  "error": {
    "type": "guardrail_block",
    "guardrail_key": "pii-checker",
    "action": "block",
    "findings": [...]
  }
}
```

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing `guardrail_key` or `text` |
| 401 | Invalid API token |
| 404 | Guardrail not found |
