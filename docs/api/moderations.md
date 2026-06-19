# Moderations API

OpenAI-compatible moderation endpoint for classifying text against a console guardrail.

The `model` field selects which console guardrail to evaluate against (any enabled guardrail key). When omitted, the tenant's first enabled preset guardrail with an active moderation policy is used, so an OpenAI client pointed at the console works without code changes once such a guardrail exists.

## Endpoint

```
POST /api/client/v1/moderations
```

## Request

```json
{
  "input": "Text to classify",
  "model": "default-moderation"
}
```

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `input` | string \| string[] | Yes | Text to classify. May be a single string, an array of strings, or an array of content-part objects with a `text` field. Image inputs are not supported. |
| `model` | string | No | Guardrail key to evaluate against. When omitted, falls back to the first enabled preset guardrail with the moderation policy active. |

## Response

Each input produces one entry in `results`, indexed by input position. `model` echoes the resolved guardrail key.

```json
{
  "id": "modr_2f1c8e7a-9b3d-4a21-8c0e-7d5f6a1b2c3d",
  "model": "default-moderation",
  "results": [
    {
      "flagged": true,
      "categories": {
        "harassment": true,
        "hate": false,
        "violence": false
      },
      "category_scores": {
        "harassment": 0.9,
        "hate": 0,
        "violence": 0
      },
      "findings": [
        {
          "type": "moderation",
          "category": "harassment",
          "severity": "high",
          "message": "Detected harassing content",
          "action": "block",
          "block": true
        }
      ]
    }
  ]
}
```

### Result fields

| Field | Type | Description |
|-------|------|-------------|
| `flagged` | boolean | `true` when any finding was produced (including PII or prompt-shield findings when those policies are enabled). |
| `categories` | object | Map of every moderation category to a boolean indicating whether it was triggered. |
| `category_scores` | object | Map of every moderation category to a score derived from finding severity: `low` → `0.3`, `medium` → `0.6`, `high` → `0.9`. Untriggered categories are `0`. |
| `findings` | array | Console extension: the raw guardrail findings, including PII and prompt-shield findings when those policies are enabled (these are not folded into the fixed category map). |

Each `findings` entry has the shape:

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | One of `pii`, `moderation`, `prompt_shield`, `custom`. |
| `category` | string | Category identifier within the finding type. |
| `severity` | string | `low`, `medium`, or `high`. |
| `message` | string | Human-readable description of the finding. |
| `action` | string | Guardrail action applied. |
| `block` | boolean | Whether the finding blocks the content. |
| `value` | string | Optional matched value (e.g. the detected PII substring). |

### Moderation categories

The fixed `categories` / `category_scores` maps always include every moderation category below:

| Category | Label |
|----------|-------|
| `harassment` | Harassment |
| `harassment/threatening` | Harassment (Threatening) |
| `hate` | Hate speech |
| `hate/threatening` | Hate (Threatening) |
| `illicit` | Illicit Activity |
| `illicit/violent` | Illicit (Violent) |
| `self-harm` | Self Harm |
| `self-harm/intent` | Self Harm (Intent) |
| `self-harm/instructions` | Self Harm (Instructions) |
| `sexual` | Sexual Content |
| `sexual/minors` | Sexual Content (Minors) |
| `violence` | Violence |
| `violence/graphic` | Graphic Violence |
| `terrorism` | Terrorism & Extremism |
| `weapons` | Weapons & Weapon Crafting |
| `fraud` | Fraud & Scams |
| `drugs` | Illegal Drugs |
| `cybercrime` | Cybercrime & Malware |
| `child_safety` | Child Safety & Grooming |
| `misinformation` | Medical/Health Misinformation |
| `privacy_violation` | Privacy Violations & Doxxing |
| `impersonation` | Identity Impersonation |
| `manipulation` | Psychological Manipulation |
| `radicalization` | Radicalization Content |
| `financial_advice` | Unauthorized Financial Advice |
| `animal_cruelty` | Animal Abuse & Cruelty |

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing `input`; `model` is not a string; `input` is empty or an unsupported type (e.g. image inputs); or the requested guardrail key was not found / no moderation guardrail is configured |
| 401 | Invalid API token |
| 500 | Internal moderation error |

## Example

```bash
curl -X POST https://gateway.example.com/api/client/v1/moderations \
  -H "Authorization: Bearer cgt_your_token" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Text to classify",
    "model": "default-moderation"
  }'
```
