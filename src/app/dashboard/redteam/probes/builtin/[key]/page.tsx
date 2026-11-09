'use client';

/**
 * Built-in probe detail (read-only): what the probe tests, the sources behind
 * the technique, how it is detected, what it works with and every attempt it
 * sends. "Clone & edit" copies it into a custom probe; the built-in is never
 * changed.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Badge, Button, Code, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconArrowLeft, IconCopy, IconDownload, IconPlayerPlay } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import CreateCustomProbeModal from '@/components/redteam/CreateCustomProbeModal';
import { downloadText } from '@/components/redteam/download';
import {
  detectionKind,
  detectorInfo,
  exportFileName,
  isHardProofDetector,
  isNewProbe,
  toNativeProbe,
  worksWithLabels,
} from '@/components/redteam/helpers';
import { severityBadgeClass } from '@/components/redteam/severity';
import type { BuiltinProbeDefinitionView, CustomProbeAttemptView } from '@/components/redteam/types';
import { exportNativeProbes } from '@/lib/services/redteam/import';
import { owaspCategoryLabel } from '@/lib/services/redteam/owasp';

type LoadError = 'not-found' | 'forbidden' | 'error' | null;

/** Shows `{{canary}}` in a text as a chip. */
function WithCanaryChip({ text }: { text: string }) {
  const parts = text.split('{{canary}}');
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 ? <Badge component="span" size="xs" variant="light" color="teal" style={{ textTransform: 'none' }}>{'{{canary}}'}</Badge> : null}
        </span>
      ))}
    </>
  );
}

function TextBlock({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: 13,
        padding: '8px 10px',
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 6,
      }}
    >
      {children}
    </div>
  );
}

function AttemptCard({ attempt, index }: { attempt: CustomProbeAttemptView; index: number }) {
  const patterns = attempt.forbiddenPatterns ?? [];
  return (
    <Stack gap={6} p="sm" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }} data-testid="redteam-builtin-attempt">
      <Group gap="xs">
        <Text size="sm" fw={600}>Attempt {index + 1}</Text>
        <Text size="xs" c="dimmed" className="ds-mono">{attempt.id}</Text>
        {attempt.adaptive ? <Badge size="xs" variant="light" color="grape">adaptive</Badge> : null}
      </Group>
      {attempt.system ? (
        <div>
          <Text size="xs" c="dimmed" mb={2}>Planted system prompt</Text>
          <TextBlock><WithCanaryChip text={attempt.system} /></TextBlock>
        </div>
      ) : null}
      {(attempt.history ?? []).length > 0 ? (
        <div>
          <Text size="xs" c="dimmed" mb={2}>Forged history</Text>
          <Stack gap={4}>
            {(attempt.history ?? []).map((m, i) => (
              <TextBlock key={i}>
                <Text span size="xs" fw={600}>{m.role}: </Text>
                {m.content}
              </TextBlock>
            ))}
          </Stack>
        </div>
      ) : null}
      <div>
        <Text size="xs" c="dimmed" mb={2}>{attempt.turns.length > 1 ? 'User turns' : 'User turn'}</Text>
        <Stack gap={4}>
          {attempt.turns.map((t, i) => <TextBlock key={i}>{t}</TextBlock>)}
        </Stack>
      </div>
      {attempt.objective ? (
        <Text size="xs" c="dimmed">Attacker objective: {attempt.objective}</Text>
      ) : null}
      <Group gap="md">
        {attempt.canary ? <Text size="xs" c="dimmed">Canary: <Code>{attempt.canary}</Code></Text> : null}
        {patterns.length > 0 ? <Text size="xs" c="dimmed">Forbidden patterns: {patterns.map((p) => <Code key={p} mr={4}>{p}</Code>)}</Text> : null}
        <Text size="xs" c="dimmed">{attempt.refusalExpected === false ? 'A refusal is not expected' : 'A refusal is the safe outcome'}</Text>
      </Group>
    </Stack>
  );
}

export default function BuiltinProbeDetailPage() {
  const router = useRouter();
  const params = useParams<{ key: string }>();
  const key = params?.key ? decodeURIComponent(params.key) : undefined;
  const [probe, setProbe] = useState<BuiltinProbeDefinitionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError>(null);
  const [cloneOpen, setCloneOpen] = useState(false);

  const load = useCallback(async () => {
    if (!key) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/redteam/probes/builtin/${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (res.status === 404) { setLoadError('not-found'); setProbe(null); return; }
      if (res.status === 403) { setLoadError('forbidden'); setProbe(null); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProbe(data.probe ?? null);
      setLoadError(data.probe ? null : 'not-found');
    } catch {
      setLoadError('error');
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => { void load(); }, [load]);

  const backButton = (
    <Button variant="default" size="sm" leftSection={<IconArrowLeft size={14} />} onClick={() => router.push('/dashboard/redteam/probes')}>
      Back to probes
    </Button>
  );

  if (loading) {
    return <PageContainer><Group justify="center" mt={80}><Loader /></Group></PageContainer>;
  }
  if (loadError === 'not-found' || (!probe && loadError === null)) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Red Team" title="Probe not found" actions={backButton} />
        <Text c="dimmed" size="sm">This built-in probe does not exist.</Text>
      </PageContainer>
    );
  }
  if (loadError === 'forbidden') {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Red Team" title="No access" actions={backButton} />
        <Text c="dimmed" size="sm">You do not have access to red-team probes.</Text>
      </PageContainer>
    );
  }
  if (loadError === 'error' || !probe) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Red Team" title="Could not load the probe" actions={backButton} />
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title="Something went wrong">
          <Group justify="space-between">
            <Text size="sm">The probe could not be loaded.</Text>
            <Button size="xs" variant="default" onClick={() => void load()}>Retry</Button>
          </Group>
        </Alert>
      </PageContainer>
    );
  }

  const detectors = probe.detectors ?? [];
  const kind = detectionKind(detectors);
  const references = probe.references ?? [];
  const works = worksWithLabels(probe);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Red Team · Built-in probe"
        title={probe.name}
        subtitle={
          <span>
            <span className="ds-mono">{probe.key}</span>
            {probe.version ? ` · v${probe.version}` : ''}
            {' · '}{owaspCategoryLabel(probe.category)}
            {' · '}
            {/* The subtitle is a <p>: every badge here renders as a span. */}
            <span className={severityBadgeClass(probe.severity)}>{probe.severity}</span>
            {isNewProbe(probe.addedAt) ? <Badge component="span" size="xs" variant="filled" color="teal" ml={6}>NEW</Badge> : null}
            {probe.polarity === 'over-refusal' ? <Badge component="span" size="xs" variant="light" color="blue" ml={6}>over-refusal</Badge> : null}
          </span>
        }
        actions={
          <Group gap="xs">
            <Button size="sm" color="teal" leftSection={<IconCopy size={14} />} onClick={() => setCloneOpen(true)}>Clone &amp; edit</Button>
            <Button
              size="sm"
              variant="default"
              leftSection={<IconPlayerPlay size={14} />}
              onClick={() => router.push(`/dashboard/redteam?newWithProbe=${encodeURIComponent(probe.key)}`)}
            >
              Use in campaign
            </Button>
            <Button
              size="sm"
              variant="default"
              leftSection={<IconDownload size={14} />}
              onClick={() => downloadText(exportFileName(probe.key), exportNativeProbes([toNativeProbe(probe)]))}
            >
              Export YAML
            </Button>
            {backButton}
          </Group>
        }
      />

      <Stack gap="lg">
        <div className="ds-card ds-card-pad-sm">
          <Stack gap="xs">
            <Text fw={600} size="sm">What it tests</Text>
            <Text size="sm">{probe.description}</Text>
            {probe.technique ? <Text size="sm" c="dimmed">{probe.technique}</Text> : null}
            {references.length > 0 ? (
              <div>
                <Text size="xs" c="dimmed" mb={2}>References</Text>
                <Stack gap={2}>
                  {references.map((r) => (
                    <Text key={r.url} size="sm">
                      <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a>
                    </Text>
                  ))}
                </Stack>
              </div>
            ) : null}
          </Stack>
        </div>

        <div className="ds-card ds-card-pad-sm">
          <Stack gap="xs">
            <Text fw={600} size="sm">Detection</Text>
            {detectors.length === 0 ? (
              <Text size="sm" c="dimmed">This server did not list the detectors.</Text>
            ) : (
              <Stack gap={4}>
                {detectors.map((d) => {
                  const info = detectorInfo(d);
                  return (
                    <Group key={d} gap="xs" wrap="nowrap" align="flex-start">
                      <span className={isHardProofDetector(d) ? 'ds-badge ds-badge-teal' : 'ds-badge'} style={{ flexShrink: 0 }}>{info.label}</span>
                      <Text size="xs" c="dimmed">{info.help}</Text>
                    </Group>
                  );
                })}
              </Stack>
            )}
            {kind === 'judge' || kind === 'both' ? (
              <Text size="xs" c="dimmed">This probe uses a judge: the campaign needs a judge model for the full verdict.</Text>
            ) : kind === 'deterministic' ? (
              <Text size="xs" c="dimmed">The verdict comes from deterministic checks; no judge model is needed.</Text>
            ) : null}
          </Stack>
        </div>

        <div className="ds-card ds-card-pad-sm">
          <Stack gap="xs">
            <Text fw={600} size="sm">Works with</Text>
            <Group gap={6}>
              {works.map((w) => <span key={w} className="ds-badge">{w}</span>)}
            </Group>
            {typeof probe.agentAttemptCount === 'number' && typeof probe.attemptCount === 'number' ? (
              <Text size="xs" c="dimmed">
                {probe.agentAttemptCount} of {probe.attemptCount} attempts run against agents; an agent keeps its own system prompt and takes no forged history.
              </Text>
            ) : null}
          </Stack>
        </div>

        <div>
          <Text fw={600} size="sm" mb="xs">Attempts ({probe.attempts.length})</Text>
          <Stack gap="sm">
            {probe.attempts.map((a, i) => <AttemptCard key={a.id} attempt={a} index={i} />)}
          </Stack>
        </div>
      </Stack>

      <CreateCustomProbeModal
        opened={cloneOpen}
        cloneOf={probe}
        onClose={() => setCloneOpen(false)}
        onSaved={() => router.push('/dashboard/redteam/probes?tab=custom')}
      />
    </PageContainer>
  );
}
