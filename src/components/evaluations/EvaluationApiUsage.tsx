'use client';

/**
 * API Usage panel for the Evaluations dashboard.
 *
 * Mirrors the "API Usage" convention of the other modules (pii, guardrails,
 * rag): a stack of copyable, real-world snippets against the token-authenticated
 * client surface (`/api/client/v1/evaluation/*`). The flow is CI-oriented —
 * discover a suite, trigger a run, poll the result — since suite/target/dataset
 * authoring lives on this dashboard.
 */

import {
  Box,
  Button,
  Code,
  CopyButton,
  Paper,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';

const BASE = 'https://your-cognipeer-host';

interface Props {
  /** A real suite key from the project, used to make the snippets runnable. */
  suiteKey?: string;
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

export default function EvaluationApiUsage({ suiteKey }: Props) {
  const key = suiteKey || 'my-suite';

  const listCurl = `curl ${BASE}/api/client/v1/evaluation/suites \\
  -H "Authorization: Bearer YOUR_API_TOKEN"
# → { "suites": [ { "key": "${key}", "target_key": "...", "dataset_key": "...", "scorers": [...] } ] }`;

  const runCurl = `curl -X POST ${BASE}/api/client/v1/evaluation/suites/${key}/run \\
  -H "Authorization: Bearer YOUR_API_TOKEN"`;

  const runResponse = `{
  "run": {
    "id": "run_abc123",
    "suite_key": "${key}",
    "target_key": "gpt-target",
    "dataset_key": "smoke-data",
    "status": "completed",
    "aggregate": {
      "total": 24, "completed": 24, "failed": 0, "passed": 22,
      "pass_rate": 0.9167, "avg_score": 0.94, "avg_latency_ms": 812
    },
    "items": [
      {
        "item_id": "q1", "passed": true, "score": 1, "latency_ms": 640,
        "output_text": "…", "scores": [ { "scorer_type": "assertion", "score": 1, "passed": true } ]
      }
    ],
    "started_at": "…", "finished_at": "…"
  }
}`;

  const listRunsCurl = `# List recent runs (summary only — no per-item scores)
curl "${BASE}/api/client/v1/evaluation/runs?suite_key=${key}&limit=20" \\
  -H "Authorization: Bearer YOUR_API_TOKEN"

# Fetch one run with its full per-item breakdown
curl ${BASE}/api/client/v1/evaluation/runs/run_abc123 \\
  -H "Authorization: Bearer YOUR_API_TOKEN"`;

  const ciExample = `// CI gate: run a suite and fail the build if the pass-rate regresses.
const BASE = '${BASE}';
const headers = { Authorization: \`Bearer \${process.env.COGNIPEER_API_TOKEN}\` };

const { run } = await fetch(
  \`\${BASE}/api/client/v1/evaluation/suites/${key}/run\`,
  { method: 'POST', headers },
).then((r) => r.json());

const passRate = run.aggregate?.pass_rate ?? 0;
console.log(\`pass rate: \${(passRate * 100).toFixed(1)}% (\${run.aggregate.passed}/\${run.aggregate.total})\`);

if (passRate < 0.9) {
  console.error('Evaluation gate failed — pass rate below 90%');
  process.exit(1);
}`;

  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">Client API</Text>
        <Text size="xs" c="dimmed">
          Token-authenticated endpoints live under <Code fz="xs">/api/client/v1/evaluation/*</Code> and
          are scoped to the token&apos;s project. They are read- and trigger-oriented — discover a suite,
          run it, and read results — ideal for CI. Authoring targets, datasets and suites stays on this
          dashboard. Replace <Code fz="xs">YOUR_API_TOKEN</Code> with a token from Settings → API Tokens.
        </Text>
      </Paper>

      <Snippet
        title="1 · List suites"
        description="Discover the suites configured for your project and their keys."
        code={listCurl}
      />

      <Snippet
        title="2 · Run a suite"
        description="Trigger a synchronous run over the suite's dataset. Returns the scored result once it completes."
        code={runCurl}
      />

      <Snippet
        title="Run response"
        description="The aggregate reports pass_rate, avg_score and avg_latency_ms; items carry per-case scores."
        code={runResponse}
      />

      <Snippet
        title="3 · Read results"
        description="List recent runs (summaries) or fetch a single run by id for the full per-item breakdown."
        code={listRunsCurl}
      />

      <Snippet
        title="CI example (gate on pass-rate)"
        code={ciExample}
      />
    </Stack>
  );
}
