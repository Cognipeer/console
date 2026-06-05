'use client';

/**
 * Red-team client API usage panel — shows the token-authenticated endpoints a
 * CI pipeline uses to trigger a scan and gate on the result.
 */

import { useState } from 'react';
import { Button, Card, Code, Group, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';

interface CalibrationResult {
  total: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  reviewRate: number;
  confusion: { tp: number; fp: number; tn: number; fn: number };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default function RedTeamApiUsage({ campaignKey }: { campaignKey?: string }) {
  const key = campaignKey ?? 'YOUR_CAMPAIGN_KEY';
  const base = '/api/client/v1/redteam';

  const [cal, setCal] = useState<CalibrationResult | null>(null);
  const [calibrating, setCalibrating] = useState(false);

  const runCalibration = async () => {
    setCalibrating(true);
    try {
      const res = await fetch('/api/redteam/calibration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Calibration failed');
      setCal(data.calibration ?? null);
      notifications.show({ title: 'Calibration complete', message: `Accuracy ${pct(data.calibration?.accuracy ?? 0)}`, color: 'teal' });
    } catch (err) {
      notifications.show({ title: 'Calibration failed', message: err instanceof Error ? err.message : 'failed', color: 'red' });
    } finally {
      setCalibrating(false);
    }
  };

  const endpoints: { method: string; path: string; note: string }[] = [
    { method: 'GET', path: `${base}/probes`, note: 'List the built-in probe catalog.' },
    { method: 'GET', path: `${base}/campaigns`, note: 'List configured campaigns for the token’s project.' },
    { method: 'POST', path: `${base}/campaigns/${key}/scan`, note: 'Trigger a scan (async). Returns a pending run.' },
    { method: 'GET', path: `${base}/runs?campaign_key=${key}`, note: 'List scan runs (newest first).' },
    { method: 'GET', path: `${base}/runs/{id}`, note: 'Fetch one run with per-attempt verdicts + aggregate.' },
  ];

  const curl = `# 1. Kick off a scan
curl -X POST "$CONSOLE_URL${base}/campaigns/${key}/scan" \\
  -H "Authorization: Bearer $API_TOKEN"

# 2. Poll the run until status is "completed"
curl "$CONSOLE_URL${base}/runs/$RUN_ID" \\
  -H "Authorization: Bearer $API_TOKEN"

# 3. Fail the pipeline if any vulnerability was confirmed
#    (jq: .run.aggregate.vulnerable)`;

  return (
    <Stack gap="md">
      <Card withBorder padding="md" radius="md">
        <Title order={5} mb="xs">Client API</Title>
        <Text size="sm" c="dimmed" mb="md">
          Token-authenticated, snake_case surface for CI/automation. Authoring stays on the dashboard.
        </Text>
        <Stack gap="xs">
          {endpoints.map((e) => (
            <div key={`${e.method} ${e.path}`} className="ds-row" style={{ gap: 10, alignItems: 'baseline' }}>
              <span className="ds-badge ds-badge-info" style={{ minWidth: 48, textAlign: 'center' }}>{e.method}</span>
              <Code>{e.path}</Code>
              <Text size="xs" c="dimmed">{e.note}</Text>
            </div>
          ))}
        </Stack>
      </Card>

      <Card withBorder padding="md" radius="md">
        <Title order={5} mb="xs">Gate a pipeline on safety</Title>
        <Code block>{curl}</Code>
      </Card>

      <Card withBorder padding="md" radius="md">
        <Group justify="space-between" mb="xs">
          <div>
            <Title order={5}>Detector calibration</Title>
            <Text size="sm" c="dimmed">Run the golden set through the live decision engine to measure precision / recall.</Text>
          </div>
          <Button size="sm" variant="light" loading={calibrating} onClick={runCalibration}>Run calibration</Button>
        </Group>
        {cal ? (
          <Group gap="lg" mt="sm">
            <Text size="sm">Accuracy <strong>{pct(cal.accuracy)}</strong></Text>
            <Text size="sm">Precision <strong>{pct(cal.precision)}</strong></Text>
            <Text size="sm">Recall <strong>{pct(cal.recall)}</strong></Text>
            <Text size="sm">F1 <strong>{pct(cal.f1)}</strong></Text>
            <Text size="sm" c="dimmed">Review rate {pct(cal.reviewRate)}</Text>
            <Text size="sm" c="dimmed">
              TP {cal.confusion.tp} · FP {cal.confusion.fp} · TN {cal.confusion.tn} · FN {cal.confusion.fn}
            </Text>
          </Group>
        ) : (
          <Text size="xs" c="dimmed" mt="sm">No calibration run yet.</Text>
        )}
      </Card>
    </Stack>
  );
}
