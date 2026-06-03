'use client';

/**
 * API Usage panel for a PII policy detail page.
 *
 * Mirrors the "API Usage" tab convention of the other modules (guardrails, rag):
 * a stack of copyable, real-world snippets against the token-authenticated
 * client surface (`/api/client/v1/pii/*`), with the tokenize → detokenize LLM
 * round-trip front and center and diversified examples across PII categories.
 */

import {
  Box,
  Button,
  Code,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';

const BASE = 'https://your-cognipeer-host';

interface Props {
  policyKey: string;
  policyName: string;
  defaultAction: string;
}

/** A titled, copyable code block. */
function Snippet({ title, description, code }: { title: string; description?: string; code: string }) {
  return (
    <Paper withBorder radius="md" p="md">
      <Text fw={600} mb={description ? 4 : 'xs'}>{title}</Text>
      {description ? <Text size="xs" c="dimmed" mb="sm">{description}</Text> : null}
      <Box style={{ position: 'relative' }}>
        <CopyButton value={code} timeout={2000}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
              <Button
                size="xs"
                variant={copied ? 'filled' : 'outline'}
                color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </Tooltip>
          )}
        </CopyButton>
        <Code block fz="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{code}</Code>
      </Box>
    </Paper>
  );
}

export default function PiiApiUsage({ policyKey, policyName, defaultAction }: Props) {
  const tokenizeCurl = `curl -X POST ${BASE}/api/client/v1/pii/tokenize \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "policy_key": "${policyKey}",
    "text": "Refund order to a@x.com on card 5555 5555 5555 4444; caller +90 532 555 22 33 from 192.168.1.42"
  }'`;

  const tokenizeResponse = `{
  "policy_key": "${policyKey}",
  "policy_name": "${policyName}",
  "action": "tokenize",
  "output_text": "Refund order to [EMAIL_1] on card [CREDITCARD_1]; caller [TR_PHONE_1] from [IPADDRESS_1]",
  "input_length": 93,
  "has_blocking": false,
  "languages": ["global"],
  "vault": {
    "[EMAIL_1]":      { "value": "a@x.com", "category": "email" },
    "[CREDITCARD_1]": { "value": "5555 5555 5555 4444", "category": "creditCard" },
    "[TR_PHONE_1]":   { "value": "+90 532 555 22 33", "category": "tr_phone" },
    "[IPADDRESS_1]":  { "value": "192.168.1.42", "category": "ipAddress" }
  }
}`;

  const detokenizeCurl = `curl -X POST ${BASE}/api/client/v1/pii/detokenize \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "text": "Refunded [CREDITCARD_1], emailed [EMAIL_1], blocked [IPADDRESS_1].",
    "vault": { "...": "the vault returned by /tokenize" }
  }'
# → { "output_text": "Refunded 5555 5555 5555 4444, emailed a@x.com, blocked 192.168.1.42." }`;

  const scanCurl = `curl -X POST ${BASE}/api/client/v1/pii/scan \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "policy_key": "${policyKey}",
    "text": "Caller +90 532 555 22 33 emailed alice@example.com about IBAN TR33 0006 1005 1978 6457 8413 26",
    "action": "${defaultAction}"
  }'`;

  const namedCurl = `# Detect — findings only, no transformation
curl -X POST ${BASE}/api/client/v1/pii/detect \\
  -H "Authorization: Bearer YOUR_API_TOKEN" -H "Content-Type: application/json" \\
  -d '{ "policy_key": "${policyKey}", "text": "Müşteri 10000000146 IBAN TR33 0006 1005 1978 6457 8413 26" }'

# Redact — replace matches with [REDACTED_<CATEGORY>]
curl -X POST ${BASE}/api/client/v1/pii/redact \\
  -H "Authorization: Bearer YOUR_API_TOKEN" -H "Content-Type: application/json" \\
  -d '{ "policy_key": "${policyKey}", "text": "Wire to TR33 0006 1005 1978 6457 8413 26" }'

# Mask — partial obfuscation, keeping recognizable edges
curl -X POST ${BASE}/api/client/v1/pii/mask \\
  -H "Authorization: Bearer YOUR_API_TOKEN" -H "Content-Type: application/json" \\
  -d '{ "policy_key": "${policyKey}", "text": "card 4111 1111 1111 1111" }'`;

  const jsExample = `// LLM round-trip: strip PII before the model, restore it after.
const BASE = '${BASE}';
const headers = {
  Authorization: \`Bearer \${process.env.COGNIPEER_API_TOKEN}\`,
  'Content-Type': 'application/json',
};

// 1) Tokenize the user prompt with a policy
const tok = await fetch(\`\${BASE}/api/client/v1/pii/tokenize\`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ policy_key: '${policyKey}', text: userPrompt }),
}).then((r) => r.json());

// 2) Send tok.output_text to your model (PII-free), get a reply that echoes tokens
const modelReply = await callYourModel(tok.output_text);

// 3) Detokenize the reply with the same vault
const restored = await fetch(\`\${BASE}/api/client/v1/pii/detokenize\`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text: modelReply, vault: tok.vault }),
}).then((r) => r.json());

console.log(restored.output_text); // originals restored`;

  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">Policy Key</Text>
        <Group gap="sm">
          <Code fz="sm" style={{ flex: 1 }}>{policyKey}</Code>
          <CopyButton value={policyKey} timeout={2000}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                <Button
                  size="xs"
                  variant={copied ? 'filled' : 'light'}
                  color={copied ? 'teal' : 'blue'}
                  onClick={copy}
                  leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                >
                  {copied ? 'Copied' : 'Copy key'}
                </Button>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
        <Text size="xs" c="dimmed" mt="sm">
          Token-authenticated endpoints live under <Code fz="xs">/api/client/v1/pii/*</Code> and
          every call requires this <Code fz="xs">policy_key</Code> — the policy decides which
          categories, custom patterns and languages are scanned. Replace{' '}
          <Code fz="xs">YOUR_API_TOKEN</Code> with a token from Settings → API Tokens.
        </Text>
      </Paper>

      <Snippet
        title="1 · Tokenize the prompt (reversible)"
        description="Replace PII with tokens before sending text to a model. Returns output_text plus a vault that maps every token back to its original value. Identical values share one token."
        code={tokenizeCurl}
      />

      <Snippet
        title="Tokenize response"
        description="Hold onto the vault for the round-trip — it is never persisted server-side."
        code={tokenizeResponse}
      />

      <Snippet
        title="2 · Detokenize the model reply"
        description="Restore the originals once the model responds. Tokens missing from the vault are left untouched, so a model that drops or rewrites a token is handled gracefully."
        code={detokenizeCurl}
      />

      <Snippet
        title="Scan (action from the policy)"
        description={`Apply the "${policyName}" policy and use its default action (${defaultAction}), or override it per call with the "action" field.`}
        code={scanCurl}
      />

      <Snippet
        title="Detect / redact / mask"
        description="Same policy, different action. Each endpoint pins its action; categories and patterns come from the policy."
        code={namedCurl}
      />

      <Snippet
        title="JavaScript example (round-trip)"
        code={jsExample}
      />
    </Stack>
  );
}
