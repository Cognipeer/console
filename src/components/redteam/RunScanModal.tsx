'use client';

/**
 * Start-scan dialog — configure a single red-team run (turns, concurrency,
 * probe subset, judge model, agent version) then enqueue it. The scan runs asynchronously on
 * the queue; the caller navigates to the run detail page, which polls.
 */

import { useEffect, useState } from 'react';
import { Group, NumberInput, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import FormShell, { FormSection } from '@/components/common/ui/FormShell';
import AgentWithVersion from '@/components/agents/AgentWithVersion';
import { configVersionTag } from '@/components/agents/agentVersionTag';
import { AGENT_TEST_ACCESS_HINT, useAgentTestAccess } from '@/components/agents/useAgentTestAccess';
import { useAgentVersionOptions } from '@/components/agents/useAgentVersionOptions';
import { agentRevisionLabel, storedAgentRevision, storedVersionFromPicker } from '@/lib/shared/agentRevision';
import ProbePicker from './ProbePicker';
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

export default function RunScanModal({ opened, campaign, probes, models, onClose, onStarted }: Props) {
  const [maxTurns, setMaxTurns] = useState<number | ''>('');
  const [concurrency, setConcurrency] = useState<number | ''>(4);
  const [probeKeys, setProbeKeys] = useState<string[]>([]);
  const [judgeModelKey, setJudgeModelKey] = useState<string | null>(null);
  /** 'default' follows the campaign; otherwise 'published', 'draft' or a version number as digits. */
  const [agentVersion, setAgentVersion] = useState('default');
  const [starting, setStarting] = useState(false);
  const { canRunAgentTests } = useAgentTestAccess();
  const isAgent = campaign?.targetKind === 'agent';
  // Scanning an agent needs Write on Agents; the server refuses it otherwise.
  const blocked = isAgent && !canRunAgentTests;
  const agentVersions = useAgentVersionOptions(campaign?.agentKey, opened && isAgent);
  const defaultLabel = agentRevisionLabel(storedAgentRevision(campaign?.agentVersion));

  useEffect(() => {
    if (!opened || !campaign) return;
    setMaxTurns('');
    setConcurrency(campaign.runConfig?.concurrency ?? 4);
    setProbeKeys(campaign.probeKeys ?? []);
    setJudgeModelKey(campaign.judgeModelKey ?? null);
    setAgentVersion('default');
  }, [opened, campaign]);

  const versionOptions = [
    { value: 'default', label: `Campaign default (${defaultLabel})` },
    { value: 'published', label: 'Published — whatever is live' },
    { value: 'draft', label: 'Draft — the saved, unpublished config' },
    ...agentVersions.versions.map((entry) => ({
      value: String(entry.version),
      label: `v${entry.version}${entry.published ? ' · published' : ''}`,
    })),
  ];
  const chosenTag = configVersionTag(agentVersion === 'default' ? campaign?.agentVersion : storedVersionFromPicker(agentVersion));

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
      // Only sent when it differs from the campaign's own default.
      if (isAgent && agentVersion !== 'default') {
        body.agentVersion = agentVersion === 'published' || agentVersion === 'draft' ? agentVersion : Number(agentVersion);
      }

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
    <FormShell
      open={opened}
      onClose={onClose}
      title="Start scan"
      primaryAction={{
        label: 'Start scan',
        loading: starting,
        disabled: !campaign || blocked,
        disabledReason: blocked ? AGENT_TEST_ACCESS_HINT : undefined,
        onClick: () => {
          void start();
        },
      }}
    >
      {campaign ? (
        <FormSection title="Scan settings">
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              Attacking{' '}
              <strong>
                {isAgent ? <AgentWithVersion name={campaign.agentKey} tag={chosenTag} /> : campaign.modelKey}
              </strong>{' '}
              ({campaign.targetKind}). The scan runs in the background.
            </Text>

            {isAgent ? (
              <Select
                label="Agent version"
                description="Which configuration of the agent this scan attacks. The scan records the version that answered, so results stay comparable."
                data={versionOptions}
                value={agentVersion}
                onChange={(next) => setAgentVersion(next ?? 'default')}
                allowDeselect={false}
                disabled={agentVersions.loading}
              />
            ) : null}

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

            <div>
              <Text size="sm" fw={500}>Probes</Text>
              <Text size="xs" c="dimmed" mb={6}>Which probes to run this scan. Clear all to use the campaign&apos;s default selection.</Text>
              <ProbePicker
                probes={probes}
                value={probeKeys}
                onChange={setProbeKeys}
                emptyHint="No probes selected — the campaign's default selection will run."
              />
            </div>

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
          </Stack>
        </FormSection>
      ) : null}
    </FormShell>
  );
}
