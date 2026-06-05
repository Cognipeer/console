'use client';

/**
 * Start-scan dialog — configure a single red-team run (turns, concurrency,
 * probe subset, judge model) then enqueue it. The scan runs asynchronously on
 * the queue; the caller navigates to the run detail page, which polls.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, Group, Modal, MultiSelect, NumberInput, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ProbeCatalogView, RedTeamCampaignView, SelectOption } from './types';

interface Props {
  opened: boolean;
  campaign: RedTeamCampaignView | null;
  probes: ProbeCatalogView[];
  models: SelectOption[];
  onClose: () => void;
  /** Called with the new run id once the scan is enqueued. */
  onStarted: (runId: string) => void;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export default function RunScanModal({ opened, campaign, probes, models, onClose, onStarted }: Props) {
  const [maxTurns, setMaxTurns] = useState<number | ''>('');
  const [concurrency, setConcurrency] = useState<number | ''>(4);
  const [probeKeys, setProbeKeys] = useState<string[]>([]);
  const [judgeModelKey, setJudgeModelKey] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!opened || !campaign) return;
    setMaxTurns('');
    setConcurrency(campaign.runConfig?.concurrency ?? 4);
    setProbeKeys(campaign.probeKeys ?? []);
    setJudgeModelKey(campaign.judgeModelKey ?? null);
  }, [opened, campaign]);

  const probeOptions = useMemo(
    () =>
      [...probes]
        .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
        .map((p) => ({ value: p.key, label: `${p.key} · ${p.severity}` })),
    [probes],
  );

  const start = async () => {
    if (!campaign) return;
    setStarting(true);
    try {
      const body: Record<string, unknown> = {};
      if (typeof maxTurns === 'number') body.maxTurns = maxTurns;
      if (typeof concurrency === 'number') body.concurrency = concurrency;
      // Only send a probe override when it differs from the campaign default.
      if (probeKeys.length > 0) body.probeKeys = probeKeys;
      if (judgeModelKey) body.judgeModelKey = judgeModelKey;

      const res = await fetch(`/api/redteam/campaigns/${encodeURIComponent(campaign.key)}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to start scan');
      notifications.show({ title: 'Scan started', message: `Scanning "${campaign.name}" in the background`, color: 'teal' });
      onClose();
      if (data.run?.id) onStarted(data.run.id);
    } catch (err) {
      notifications.show({ title: 'Scan failed', message: err instanceof Error ? err.message : 'Failed to start scan', color: 'red' });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Start scan" centered size="lg">
      {campaign ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Attacking <strong>{campaign.targetKind === 'agent' ? campaign.agentKey : campaign.modelKey}</strong>{' '}
            ({campaign.targetKind}). The scan runs in the background.
          </Text>

          <Group grow align="flex-start">
            <NumberInput
              label="Max turns per attempt"
              description="Adaptive attack length: the attacker model escalates over this many turns. Requires a judge model (below); without one, attacks are single-shot."
              min={1}
              max={10}
              value={maxTurns}
              onChange={(v) => setMaxTurns(typeof v === 'number' ? v : '')}
              placeholder="default 4"
            />
            <NumberInput
              label="Concurrency"
              description="Parallel attempts."
              min={1}
              max={16}
              value={concurrency}
              onChange={(v) => setConcurrency(typeof v === 'number' ? v : '')}
            />
          </Group>

          <MultiSelect
            label="Probes"
            description="Which probes to run this scan. Empty runs the campaign's full selection."
            searchable
            data={probeOptions}
            value={probeKeys}
            onChange={setProbeKeys}
            placeholder="Campaign default"
          />

          <Select
            label="Judge / attacker model"
            description="Powers the LLM-judge detectors AND drives the adaptive multi-turn attacker. Strongly recommended — without it attacks are single-shot and many verdicts stay 'needs review'."
            searchable
            clearable
            data={models}
            value={judgeModelKey}
            onChange={setJudgeModelKey}
            placeholder="Select a judge model"
          />

          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button color="teal" loading={starting} onClick={start}>Start scan</Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}
