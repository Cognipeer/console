'use client';

/**
 * Red-team OWASP overview — the compliance posture across all completed scans.
 * Rolls every recent scan up by OWASP LLM category, surfaces the riskiest
 * categories first (lowest resilience), and shows a severity breakdown plus a
 * resilience trend so regressions are visible at a glance.
 */

import { useEffect, useState } from 'react';
import { Card, Group, Progress, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconShieldCheck, IconSearch, IconEye } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import type { RedTeamOverviewView } from './types';

const CATEGORY_LABELS: Record<string, string> = {
  'LLM01-prompt-injection': 'LLM01 · Prompt Injection',
  'LLM02-insecure-output-handling': 'LLM02 · Insecure Output Handling',
  'LLM04-model-dos': 'LLM04 · Model Denial of Service',
  'LLM05-supply-chain': 'LLM05 · Supply Chain',
  'LLM06-sensitive-information-disclosure': 'LLM06 · Sensitive Information Disclosure',
  'LLM07-system-prompt-leakage': 'LLM07 · System Prompt Leakage',
  'LLM08-excessive-agency': 'LLM08 · Excessive Agency',
  'LLM09-overreliance': 'LLM09 · Overreliance',
};

const SEVERITY_COLOR: Record<string, string> = { critical: 'red', high: 'orange', medium: 'yellow', low: 'gray' };

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function resilienceColor(r: number): string {
  if (r >= 0.9) return 'teal';
  if (r >= 0.7) return 'yellow';
  if (r >= 0.5) return 'orange';
  return 'red';
}

function fmtDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

export default function RedTeamOverview() {
  const [overview, setOverview] = useState<RedTeamOverviewView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/redteam/overview', { cache: 'no-store' });
        if (res.ok && !cancelled) setOverview((await res.json()).overview ?? null);
      } catch (err) {
        console.error('Failed to load red-team overview', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Red Team"
        title="OWASP Overview"
        subtitle="Compliance posture across all completed scans, rolled up by OWASP LLM risk category. The riskiest categories surface first."
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Completed scans" icon={<IconSearch size={14} stroke={1.7} />} value={overview?.scans ?? (loading ? '…' : 0)} />
        <StatTile label="Overall resilience" icon={<IconShieldCheck size={14} stroke={1.7} />} value={overview ? pct(overview.resilienceScore) : '—'} />
        <StatTile label="Vulnerabilities" icon={<IconAlertTriangle size={14} stroke={1.7} />} value={overview?.vulnerable ?? '—'} />
        <StatTile label="Needs review" icon={<IconEye size={14} stroke={1.7} />} value={overview?.needsReview ?? '—'} />
      </div>

      {overview && overview.scans === 0 ? (
        <Card withBorder padding="xl" radius="md">
          <Text ta="center" c="dimmed">No completed scans yet. Run a campaign to populate the OWASP posture.</Text>
        </Card>
      ) : (
        <Stack gap="lg">
          <Card withBorder padding="md" radius="md">
            <Text fw={600} size="sm" mb="sm">Resilience by OWASP category</Text>
            <Stack gap="md">
              {(overview?.byCategory ?? []).map((c) => (
                <div key={c.category}>
                  <Group justify="space-between" mb={4}>
                    <Text size="sm">{CATEGORY_LABELS[c.category] ?? c.category}</Text>
                    <Group gap="md">
                      {c.vulnerable > 0 ? <Text size="xs" c="red">{c.vulnerable} vulnerable</Text> : null}
                      {c.needsReview > 0 ? <Text size="xs" c="yellow.7">{c.needsReview} review</Text> : null}
                      <Text size="xs" c="dimmed">{c.total} attempts</Text>
                      <Text size="sm" fw={600} c={`${resilienceColor(c.resilience)}.7`}>{pct(c.resilience)}</Text>
                    </Group>
                  </Group>
                  <Progress value={c.resilience * 100} color={resilienceColor(c.resilience)} size="sm" radius="sm" />
                </div>
              ))}
              {(overview?.byCategory.length ?? 0) === 0 && !loading ? (
                <Text size="sm" c="dimmed">No category data yet.</Text>
              ) : null}
            </Stack>
          </Card>

          <Group align="stretch" grow>
            <Card withBorder padding="md" radius="md">
              <Text fw={600} size="sm" mb="sm">Confirmed vulnerabilities by severity</Text>
              <Stack gap="xs">
                {['critical', 'high', 'medium', 'low'].map((sev) => (
                  <Group key={sev} justify="space-between">
                    <Text size="sm" c={`${SEVERITY_COLOR[sev]}.7`} tt="capitalize">{sev}</Text>
                    <Text size="sm" fw={600}>{overview?.bySeverity?.[sev] ?? 0}</Text>
                  </Group>
                ))}
              </Stack>
            </Card>

            <Card withBorder padding="md" radius="md">
              <Text fw={600} size="sm" mb="sm">Recent scans</Text>
              <Stack gap={6}>
                {(overview?.trend ?? []).slice().reverse().map((t) => (
                  <Group key={t.runId} justify="space-between" wrap="nowrap" gap="xs">
                    <Text size="xs" className="ds-mono" truncate style={{ maxWidth: 120 }}>{t.campaignKey}</Text>
                    <Progress value={t.resilienceScore * 100} color={resilienceColor(t.resilienceScore)} size="sm" radius="sm" style={{ flex: 1 }} />
                    <Text size="xs" fw={600} c={`${resilienceColor(t.resilienceScore)}.7`} w={42} ta="right">{pct(t.resilienceScore)}</Text>
                    <Text size="xs" c="dimmed" w={120} ta="right" truncate>{fmtDate(t.finishedAt)}</Text>
                  </Group>
                ))}
                {(overview?.trend.length ?? 0) === 0 && !loading ? (
                  <Text size="sm" c="dimmed">No scans yet.</Text>
                ) : null}
              </Stack>
            </Card>
          </Group>
        </Stack>
      )}
    </PageContainer>
  );
}
