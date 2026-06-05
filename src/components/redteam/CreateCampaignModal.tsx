'use client';

/**
 * Create / edit a red-team campaign in the app-wide full-page form shell
 * (FormShell overlay), matching the rest of the console's create screens.
 */

import { useEffect, useMemo, useState } from 'react';
import { MultiSelect, SegmentedControl, Select, Switch, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconShield } from '@tabler/icons-react';
import FormShell, {
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { ProbeCatalogView, RedTeamCampaignView, RedTeamTargetKind, SelectOption } from './types';

interface Props {
  opened: boolean;
  editing?: RedTeamCampaignView | null;
  onClose: () => void;
  agents: SelectOption[];
  models: SelectOption[];
  probes: ProbeCatalogView[];
  onSaved: (campaign?: RedTeamCampaignView) => void;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export default function CreateCampaignModal({ opened, editing, onClose, agents, models, probes, onSaved }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetKind, setTargetKind] = useState<RedTeamTargetKind>('agent');
  const [agentKey, setAgentKey] = useState<string | null>(null);
  const [modelKey, setModelKey] = useState<string | null>(null);
  const [probeKeys, setProbeKeys] = useState<string[]>([]);
  const [judgeModelKey, setJudgeModelKey] = useState<string | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [cron, setCron] = useState('0 3 * * *');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setName(editing?.name ?? '');
    setDescription(editing?.description ?? '');
    setTargetKind(editing?.targetKind ?? 'agent');
    setAgentKey(editing?.agentKey ?? null);
    setModelKey(editing?.modelKey ?? null);
    setProbeKeys(editing?.probeKeys ?? []);
    setJudgeModelKey(editing?.judgeModelKey ?? null);
    setScheduleEnabled(editing?.schedule?.enabled ?? false);
    setCron(editing?.schedule?.cron ?? '0 3 * * *');
  }, [opened, editing]);

  const probeOptions = useMemo(
    () =>
      [...probes]
        .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
        .map((p) => ({ value: p.key, label: `${p.key} · ${p.severity} · ${p.category}` })),
    [probes],
  );

  const targetRef = targetKind === 'agent' ? agentKey : modelKey;
  const validIdentity = name.trim().length > 0;
  const validTarget = Boolean(targetRef);
  const canSubmit = validIdentity && validTarget && !saving;

  const submit = async () => {
    if (!validIdentity) {
      notifications.show({ title: 'Name required', message: 'Give the campaign a name', color: 'red' });
      return;
    }
    if (!validTarget) {
      notifications.show({ title: 'Target required', message: `Pick ${targetKind === 'agent' ? 'an agent' : 'a model'} to attack`, color: 'red' });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        targetKind,
        agentKey: targetKind === 'agent' ? agentKey : undefined,
        modelKey: targetKind === 'model' ? modelKey : undefined,
        probeKeys,
        judgeModelKey: judgeModelKey || undefined,
        schedule: scheduleEnabled && cron.trim() ? { cron: cron.trim(), enabled: true } : undefined,
      };
      const url = editing ? `/api/redteam/campaigns/${editing.id}` : '/api/redteam/campaigns';
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');
      notifications.show({ title: editing ? 'Campaign updated' : 'Campaign created', message: name, color: 'teal' });
      onSaved(data.campaign as RedTeamCampaignView | undefined);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Save failed', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  const summary = (
    <SummaryGroup title="Campaign">
      <SummaryKV label="Name" value={name.trim() || '—'} />
      <SummaryKV label="Target" value={`${targetKind} · ${targetRef ?? '—'}`} mono />
      <SummaryKV label="Probes" value={probeKeys.length === 0 ? 'all built-in' : `${probeKeys.length} selected`} />
      <SummaryKV label="Judge" value={judgeModelKey ?? 'none'} mono />
      <SummaryKV label="Schedule" value={scheduleEnabled ? cron : 'manual'} mono />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconShield size={16} />}
      title={editing ? 'Edit campaign' : 'New red-team campaign'}
      subtitle="Point adversarial probes at an agent or model and judge each verdict."
      summary={summary}
      footerStatus={canSubmit ? 'ready' : 'fill required fields'}
      primaryAction={{ label: editing ? 'Save campaign' : 'Create campaign', loading: saving, disabled: !canSubmit, onClick: submit }}
    >
      <FormSection number={1} title="Identity" done={validIdentity}>
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Nightly safety scan" />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea value={description} onChange={(e) => setDescription(e.currentTarget.value)} autosize minRows={2} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={2} title="Target" done={validTarget} description="What gets attacked. Agent targets exercise the full agent (guardrails, RAG, tools).">
        <FormField label="Target type" required>
          <SegmentedControl
            value={targetKind}
            onChange={(v) => setTargetKind(v as RedTeamTargetKind)}
            data={[{ label: 'Agent', value: 'agent' }, { label: 'Model', value: 'model' }]}
          />
        </FormField>
        {targetKind === 'agent' ? (
          <FormField label="Agent under test" required>
            <Select searchable data={agents} value={agentKey} onChange={setAgentKey} placeholder="Select an agent" nothingFoundMessage="No agents" />
          </FormField>
        ) : (
          <FormField label="Model under test" required>
            <Select searchable data={models} value={modelKey} onChange={setModelKey} placeholder="Select a model" nothingFoundMessage="No models" />
          </FormField>
        )}
      </FormSection>

      <FormSection number={3} title="Probes & judge" done={probeKeys.length > 0 || Boolean(judgeModelKey)}>
        <FormField label="Probes" optional hint="Leave empty to run the entire built-in catalog.">
          <MultiSelect searchable data={probeOptions} value={probeKeys} onChange={setProbeKeys} placeholder="All probes" />
        </FormField>
        <FormField label="Judge / attacker model" optional hint="Powers the LLM-judge detectors AND the adaptive multi-turn attacker that escalates across turns. Strongly recommended.">
          <Select searchable clearable data={models} value={judgeModelKey} onChange={setJudgeModelKey} placeholder="Select a judge model" />
        </FormField>
      </FormSection>

      <FormSection number={4} title="Schedule" description="Run automatically on a cron schedule for unattended regression testing.">
        <Switch
          label="Scheduled scan"
          checked={scheduleEnabled}
          onChange={(e) => setScheduleEnabled(e.currentTarget.checked)}
        />
        {scheduleEnabled ? (
          <FormField label="Cron expression (UTC)" hint="Default: every day at 03:00 UTC">
            <TextInput value={cron} onChange={(e) => setCron(e.currentTarget.value)} placeholder="0 3 * * *" />
          </FormField>
        ) : null}
      </FormSection>
    </FormShell>
  );
}
