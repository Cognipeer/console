# Guardrails

Guardrails provide real-time content moderation and safety checks for LLM inputs and outputs. They can detect PII, evaluate content against custom policies, and block or flag problematic content. Operators manage them under **Operate → Guardrail**.

## Operator view

Each guardrail is a named policy attached to one or more models. The list view summarises the four states that matter operationally: total policies, how many are currently enabled, how many are disabled, and how many are configured to block requests (versus warn or flag).

![Guardrails list](/screenshots/guardrails/01-guardrails-list.png)

Filters at the top of the table narrow by **type** (`preset` / `custom`), by **action** (block / warn / flag), and by **status**. The **Create guardrail** flow walks you through picking a type, declaring which categories or rules to enforce, and pinning the policy to specific models or to the whole project.

When a model has guardrails attached the runtime applies them at two points: before forwarding the request upstream (input guardrails) and before responding to the client (output guardrails). A blocked request short-circuits with a structured `guardrail_violation` error that includes which policy fired.

## Guardrail Types

The `GuardrailType` enum has just two values:

| Type | Description |
|------|-------------|
| `preset` | A bundled policy that combines one or more detection families — PII, content moderation, prompt-shield, and similar checks. |
| `custom` | An LLM-based evaluation driven by your own prompt and rules. |

Detection families (PII, moderation, prompt-shield, etc.) are not themselves types — they are the checks a `preset` policy enables. PII detection delegates to the [PII service](./pii.md), which stays license-free even though guardrails themselves are gated. Configure the detector once as a PII policy, then reference it from a preset guardrail.

## PII Categories

The PII service supports 18 categories (the guardrail UI surfaces a subset). A representative sample:

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
| `warn` | Allow the request but surface a warning |
| `flag` | Allow the request but include findings in the response |

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
  "action": "flag",
  "findings": [
    { "category": "email", "value": "john@example.com", "position": [12, 28] },
    { "category": "phone", "value": "555-0100", "position": [47, 55] }
  ],
  "guardrail_key": "pii-checker",
  "guardrail_name": "PII Checker",
  "message": "PII detected in input"
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
          Return 400 with findings
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
