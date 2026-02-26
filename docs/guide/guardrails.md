# Guardrails

Guardrails provide real-time content moderation and safety checks for LLM inputs and outputs. They can detect PII, evaluate content against custom policies, and block or flag problematic content.

## Guardrail Types

| Type | Description |
|------|-------------|
| PII Detection | Regex-based detection of 15 PII categories |
| Content Moderation | Evaluates content against moderation categories |
| Prompt Shield | Detects prompt injection attacks |
| Custom Prompt | LLM-based evaluation with custom rules |

## PII Categories

The PII detector supports 15 categories:

| Category | Examples |
|----------|---------|
| `email` | user@example.com |
| `phone` | +1-234-567-8900 |
| `creditCard` | 4111 1111 1111 1111 |
| `iban` | GB29 NWBK 6016 1331 9268 19 |
| `swift` | NWBKGB2L |
| `nationalId` | SSN, national ID numbers |
| `passport` | Passport numbers |
| `birthDate` | 1990-01-15 |
| `address` | Street addresses |
| `ipAddress` | 192.168.1.1, IPv6 |
| `url` | https://example.com |
| `socialHandle` | @username |
| `apiKey` | sk-..., AKIA... |
| `cryptoWallet` | Wallet addresses |

## Actions

When a guardrail triggers, it can take one of these actions:

| Action | Behavior |
|--------|----------|
| `block` | Reject the request with an error |
| `flag` | Allow the request but include findings in the response |
| `redact` | Replace detected content with placeholder text |

## API

### Evaluate Guardrail

```
POST /api/client/v1/guardrails/evaluate
Authorization: Bearer <token>
```

```json
{
  "guardrailKey": "pii-checker",
  "content": "My email is john@example.com and my phone is 555-0100",
  "target": "input"
}
```

Response:

```json
{
  "triggered": true,
  "action": "flag",
  "findings": [
    { "category": "email", "value": "john@example.com", "position": [12, 28] },
    { "category": "phone", "value": "555-0100", "position": [47, 55] }
  ]
}
```

## Service Layer

```typescript
import {
  createGuardrail,
  evaluateGuardrail,
  listGuardrails,
} from '@/lib/services/guardrail';

// Create a guardrail
await createGuardrail(tenantDbName, tenantId, projectId, {
  name: 'PII Checker',
  type: 'pii',
  action: 'flag',
  target: 'input',
  policy: buildDefaultPresetPolicy(),
});

// Evaluate content
const result = await evaluateGuardrail(tenantDbName, guardrailKey, {
  content: userMessage,
  target: 'input',
});
```

## Inference Integration

Guardrails can be attached to models for automatic evaluation:

```
Request → Guardrail Check → Provider Call → Response
                ↓ (if blocked)
          Return 422 with findings
```

When a guardrail blocks a request during inference, a `GuardrailBlockError` is thrown with the guardrail key, action, and findings.

## Management Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/guardrails` | List guardrails |
| `POST` | `/api/guardrails` | Create guardrail |
| `GET` | `/api/guardrails/:id` | Get guardrail |
| `PATCH` | `/api/guardrails/:id` | Update guardrail |
| `DELETE` | `/api/guardrails/:id` | Delete guardrail |
