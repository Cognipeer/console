'use client';

import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import {
  IconPlayerPlay,
  IconShieldCheck,
  IconShieldX,
  IconAlertTriangle,
} from '@tabler/icons-react';
import type { GuardrailFinding } from '@/lib/services/guardrail/constants';

interface GuardrailEvaluatePanelProps {
  guardrailKey: string;
  guardrailName: string;
}

interface EvalResult {
  passed: boolean;
  action: string;
  findings: GuardrailFinding[];
  message: string | null;
  disabled?: boolean;
  redacted_text?: string | null;
}

const SEVERITY_COLORS: Record<string, string> = {
  high: 'red',
  medium: 'orange',
  low: 'yellow',
};

const FINDING_TYPE_LABELS: Record<string, string> = {
  pii: 'PII',
  word_filter: 'Word Filter',
  moderation: 'Moderation',
  prompt_shield: 'Prompt Shield',
  custom: 'Custom Rule',
};

export default function GuardrailEvaluatePanel({
  guardrailKey,
  guardrailName,
}: GuardrailEvaluatePanelProps) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EvalResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleEvaluate = async () => {
    if (!text.trim()) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/guardrails/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guardrail_key: guardrailKey, text }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Evaluation failed');
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Evaluation failed');
    } finally {
      setLoading(false);
    }
  };

  // "evaluation_error" findings mean a check could not run (e.g. the moderation
  // model's provider credentials failed to decrypt). Surfaced distinctly so a
  // fail-open PASS isn't mistaken for "safe".
  const errorFindings = result?.findings.filter((f) => f.category === 'evaluation_error') ?? [];

  return (
    <Stack gap="md">
      <Textarea
        label="Test message"
        description={`Enter text to evaluate against guardrail "${guardrailName}"`}
        placeholder="Type a message to test…"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        minRows={4}
        autosize
        maxRows={10}
      />

      <Group>
        <Button
          leftSection={<IconPlayerPlay size={15} />}
          onClick={handleEvaluate}
          loading={loading}
          disabled={!text.trim()}
        >
          Evaluate
        </Button>
        {result && (
          <Button variant="subtle" color="gray" size="xs" onClick={() => setResult(null)}>
            Clear
          </Button>
        )}
      </Group>

      {error && (
        <Alert color="red" title="Error" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
      )}

      {result?.disabled && (
        <Alert color="yellow" title="Guardrail is disabled" icon={<IconAlertTriangle size={16} />}>
          This guardrail is turned off, so no checks ran and the result is a vacuous PASS. It is
          also not enforced on live traffic. Enable it (Configure tab → Enabled) to test the policy.
        </Alert>
      )}

      {errorFindings.length > 0 && (
        <Alert color="orange" title="A check could not run" icon={<IconAlertTriangle size={16} />}>
          {errorFindings.map((f, i) => (
            <Text key={i} size="xs">
              {FINDING_TYPE_LABELS[f.type] ?? f.type}: {f.message}
            </Text>
          ))}
          <Text size="xs" mt={4} c="dimmed">
            The content passed without this check actually running. Fix the underlying model /
            provider, or set the guardrail to fail closed if these checks are mandatory.
          </Text>
        </Alert>
      )}

      {result && (
        <Card withBorder p="md">
          <Stack gap="sm">
            <Group gap="sm">
              <ThemeIcon
                size={36}
                radius="md"
                variant="light"
                color={result.disabled ? 'gray' : result.passed ? 'teal' : 'red'}
              >
                {result.passed ? <IconShieldCheck size={18} /> : <IconShieldX size={18} />}
              </ThemeIcon>
              <div>
                <Text fw={600} size="sm">
                  {result.disabled ? 'Not evaluated (disabled)' : result.passed ? 'Passed' : 'Failed'}
                </Text>
                <Text size="xs" c="dimmed">
                  Action: <Code>{result.action}</Code> &middot; {result.findings.length} finding
                  {result.findings.length !== 1 ? 's' : ''}
                </Text>
              </div>
              <Badge
                color={result.disabled ? 'gray' : result.passed ? 'teal' : 'red'}
                variant="light"
                ml="auto"
              >
                {result.disabled ? 'DISABLED' : result.passed ? 'PASS' : 'FAIL'}
              </Badge>
            </Group>

            {result.findings.length > 0 && (
              <Stack gap="xs" mt="xs">
                {result.findings.map((finding, idx) => (
                  <Card key={idx} withBorder p="xs" bg="gray.0">
                    <Group justify="space-between" wrap="nowrap">
                      <Group gap="xs" wrap="nowrap">
                        <Badge size="xs" color={FINDING_TYPE_LABELS[finding.type] ? 'blue' : 'gray'} variant="light">
                          {FINDING_TYPE_LABELS[finding.type] ?? finding.type}
                        </Badge>
                        <Badge size="xs" color={SEVERITY_COLORS[finding.severity] ?? 'gray'}>
                          {finding.severity}
                        </Badge>
                        <Text size="xs" fw={500}>
                          {finding.category.replace(/[_/-]+/g, ' ').replace(/(^|\s)\w/g, (c) => c.toUpperCase())}
                        </Text>
                      </Group>
                      <Badge size="xs" variant="light" color={finding.block ? 'red' : 'orange'}>
                        {finding.block ? 'blocked' : finding.action}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed" mt={4}>
                      {finding.message}
                    </Text>
                    {finding.value && (
                      <Code block mt={4} style={{ fontSize: 11 }}>
                        {finding.value}
                      </Code>
                    )}
                  </Card>
                ))}
              </Stack>
            )}

            {result.redacted_text && (
              <div>
                <Text size="xs" fw={500} mb={4}>Redacted output</Text>
                <Code block style={{ fontSize: 11 }}>
                  {result.redacted_text}
                </Code>
              </div>
            )}

            {result.message && (
              <Alert
                color={result.passed ? 'teal' : 'red'}
                p="xs"
                mt="xs"
                style={{ fontSize: 12, whiteSpace: 'pre-line' }}
              >
                {result.message}
              </Alert>
            )}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
