'use client';

/**
 * Create / edit a red-team campaign in the app-wide full-page form shell
 * (FormShell overlay), matching the rest of the console's create screens.
 */

import { useEffect, useState } from 'react';
import { Alert, List, NumberInput, SegmentedControl, Select, Switch, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconLock, IconShield } from '@tabler/icons-react';
import FormShell, {
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import AgentWithVersion from '@/components/agents/AgentWithVersion';
import { configVersionTag } from '@/components/agents/agentVersionTag';
import { AGENT_TEST_ACCESS_HINT, useAgentTestAccess } from '@/components/agents/useAgentTestAccess';
import { useAgentVersionOptions } from '@/components/agents/useAgentVersionOptions';
import { storedVersionFromPicker } from '@/lib/shared/agentRevision';
import { RUN_LIMITS } from '@/lib/services/redteam/limits';
import ProbePicker from './ProbePicker';
import { cronError, formatFireTime, nextFireTimes } from './cronPreview';
import type { DisabledProbeView, ProbeCatalogView, RedTeamCampaignView, RedTeamTargetKind, SelectOption } from './types';

interface Props {
  opened: boolean;
  editing?: RedTeamCampaignView | null;
  onClose: () => void;
  agents: SelectOption[];
  models: SelectOption[];
  probes: ProbeCatalogView[];
  disabledProbes?: DisabledProbeView[];
  /** Probes preselected on a new campaign (the "Use in campaign" button of a built-in probe). */
  initialProbeKeys?: string[];
  onSaved: (campaign?: RedTeamCampaignView) => void;
}

const DEFAULT_CRON = '0 3 * * *';
const DEFAULT_CONCURRENCY: number = RUN_LIMITS.concurrency.default;

/** A whole number inside [min, max]; anything else (empty, fractional, out of range) is not a usable value. */
function wholeInRange(value: number | string, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** The Version select holds 'published', 'draft' or a version number as digits. */
function versionSelectValue(stored: RedTeamCampaignView['agentVersion']): string {
  return stored === 'draft' ? 'draft' : typeof stored === 'number' ? String(stored) : 'published';
}

function versionLabel(value: string): string {
  return value === 'draft' ? 'draft' : value === 'published' ? 'published' : `v${value}`;
}

export default function CreateCampaignModal({ opened, editing, onClose, agents, models, probes, disabledProbes, initialProbeKeys, onSaved }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetKind, setTargetKind] = useState<RedTeamTargetKind>('agent');
  const [agentKey, setAgentKey] = useState<string | null>(null);
  const [agentVersion, setAgentVersion] = useState('published');
  const [modelKey, setModelKey] = useState<string | null>(null);
  const [probeKeys, setProbeKeys] = useState<string[]>([]);
  const [judgeModelKey, setJudgeModelKey] = useState<string | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [cron, setCron] = useState(DEFAULT_CRON);
  const [concurrency, setConcurrency] = useState<number | string>(DEFAULT_CONCURRENCY);
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | string>('');
  const [saving, setSaving] = useState(false);
  const { canRunAgentTests } = useAgentTestAccess();
  const agentVersions = useAgentVersionOptions(agentKey, opened && targetKind === 'agent');

  useEffect(() => {
    if (!opened) return;
    setName(editing?.name ?? '');
    setDescription(editing?.description ?? '');
    setTargetKind(editing?.targetKind ?? 'agent');
    setAgentKey(editing?.agentKey ?? null);
    setAgentVersion(versionSelectValue(editing?.agentVersion));
    setModelKey(editing?.modelKey ?? null);
    setProbeKeys(editing?.probeKeys ?? initialProbeKeys ?? []);
    setJudgeModelKey(editing?.judgeModelKey ?? null);
    setScheduleEnabled(editing?.schedule?.enabled ?? false);
    setCron(editing?.schedule?.cron ?? DEFAULT_CRON);
    setConcurrency(editing?.runConfig?.concurrency ?? DEFAULT_CONCURRENCY);
    setMaxOutputTokens(editing?.runConfig?.maxOutputTokens ?? '');
  }, [opened, editing]);

  const targetRef = targetKind === 'agent' ? agentKey : modelKey;
  const validIdentity = name.trim().length > 0;
  const validTarget = Boolean(targetRef);
  // A scheduled scan is the standing guard on what is live; pointing it at an
  // unpublished draft would make that guard test something nobody is using.
  const draftScheduled = targetKind === 'agent' && scheduleEnabled && agentVersion === 'draft';
  // Creating or changing an agent campaign needs Write on Agents, like scanning it (the server refuses it otherwise).
  const agentBlocked = targetKind === 'agent' && !canRunAgentTests;
  const validConcurrency = wholeInRange(concurrency, RUN_LIMITS.concurrency.min, RUN_LIMITS.concurrency.max);
  const validMaxTokens = maxOutputTokens === '' || wholeInRange(maxOutputTokens, 1, RUN_LIMITS.maxOutputTokens.max);
  // An enabled schedule needs a cron the server will accept; the same check runs here so Save says so first.
  const scheduleError = scheduleEnabled ? cronError(cron) : null;
  const fireTimes = scheduleEnabled && !scheduleError ? nextFireTimes(cron.trim(), 3) : [];
  const canSubmit =
    validIdentity && validTarget && !draftScheduled && !agentBlocked && validConcurrency && validMaxTokens && !scheduleError && !saving;

  // What a scan would actually run: with nothing selected it is the default set of built-in probes.
  const effectiveProbes = probeKeys.length > 0
    ? probes.filter((p) => probeKeys.includes(p.key))
    : probes.filter((p) => !p.custom && p.isDefault !== false);
  const needsJudge = effectiveProbes.filter((p) => p.needsJudgeModel);
  const plantsSystemPrompt = targetKind === 'agent' ? effectiveProbes.filter((p) => p.requiresSystemPrompt) : [];

  const versionOptions = [
    { value: 'published', label: 'Published — follows the live version' },
    { value: 'draft', label: 'Draft — the saved, unpublished config' },
    ...agentVersions.versions.map((entry) => ({
      value: String(entry.version),
      label: `v${entry.version}${entry.published ? ' · published' : ''}`,
    })),
  ];
  // A pinned version the list did not return (no access to Agents, or past the
  // list limit) must still show as selected instead of an empty box.
  if (!versionOptions.some((o) => o.value === agentVersion)) {
    versionOptions.push({ value: agentVersion, label: versionLabel(agentVersion) });
  }

  const buildRunConfig = (): { concurrency: number; maxOutputTokens?: number } => ({
    concurrency: concurrency as number,
    ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
  });

  const runConfigChanged = (): boolean =>
    concurrency !== (editing?.runConfig?.concurrency ?? DEFAULT_CONCURRENCY) ||
    (maxOutputTokens === '' ? undefined : maxOutputTokens) !== editing?.runConfig?.maxOutputTokens;

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
      // An absent key leaves the stored value alone on an edit, so a field the form left
      // empty is sent as `null` (`''` for the description) to clear it. A create reads
      // `null` as absent, so the same payload serves both.
      const payload = {
        name: name.trim(),
        description: description.trim() || (editing ? '' : undefined),
        targetKind,
        agentKey: targetKind === 'agent' ? agentKey : undefined,
        agentVersion: targetKind === 'agent' ? storedVersionFromPicker(agentVersion) : undefined,
        modelKey: targetKind === 'model' ? modelKey : undefined,
        probeKeys,
        judgeModelKey: judgeModelKey ?? null,
        // Always sent, also when off: an omitted schedule leaves the stored one
        // untouched, and the server checks draft + schedule on the merged state.
        // Off, it carries a cron the server accepts rather than whatever was
        // typed into the hidden field (the server validates it either way).
        schedule: scheduleEnabled && cron.trim()
          ? { cron: cron.trim(), enabled: true }
          : { cron: editing?.schedule?.cron ?? DEFAULT_CRON, enabled: false },
        // Sent only when the person changed a limit: it replaces the stored run settings as a whole, and an
        // untouched form should leave them alone.
        ...(runConfigChanged() ? { runConfig: buildRunConfig() } : {}),
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
      <SummaryKV
        label="Target"
        value={targetKind === 'agent' && agentKey
          ? <>agent · <AgentWithVersion name={agentKey} tag={configVersionTag(storedVersionFromPicker(agentVersion))} /></>
          : `${targetKind} · ${targetRef ?? '—'}`}
        mono
      />
      <SummaryKV label="Probes" value={probeKeys.length === 0 ? 'default set' : `${probeKeys.length} selected`} />
      <SummaryKV label="Judge" value={judgeModelKey ?? 'none'} mono />
      <SummaryKV label="Concurrency" value={validConcurrency ? String(concurrency) : '—'} mono />
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
      footerStatus={agentBlocked ? AGENT_TEST_ACCESS_HINT : draftScheduled ? 'a scheduled scan cannot run on the draft' : scheduleError ? 'fix the cron expression' : !validConcurrency || !validMaxTokens ? 'fix the run limits' : canSubmit ? 'ready' : 'fill required fields'}
      primaryAction={{
        label: editing ? 'Save campaign' : 'Create campaign',
        loading: saving,
        disabled: !canSubmit,
        disabledReason: agentBlocked ? AGENT_TEST_ACCESS_HINT : undefined,
        onClick: submit,
      }}
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

      <FormSection number={2} title="Target" done={validTarget} description="What gets attacked. Agent targets exercise the full agent (guardrails, Knowledge Engine, tools).">
        <FormField label="Target type" required>
          {/* An edit never changes the kind (the server keeps the stored one), so the switch is locked. */}
          <SegmentedControl
            value={targetKind}
            disabled={Boolean(editing)}
            onChange={(v) => setTargetKind(v as RedTeamTargetKind)}
            data={[{ label: 'Agent', value: 'agent' }, { label: 'Model', value: 'model' }]}
          />
        </FormField>
        {targetKind === 'agent' ? (
          <FormField label="Agent under test" required>
            <Select
              searchable
              data={agents}
              value={agentKey}
              onChange={(next) => {
                // A version number only means something for the agent it came from.
                setAgentKey(next);
                setAgentVersion('published');
              }}
              placeholder="Select an agent"
              nothingFoundMessage="No agents"
            />
          </FormField>
        ) : (
          <FormField label="Model under test" required>
            <Select searchable data={models} value={modelKey} onChange={setModelKey} placeholder="Select a model" nothingFoundMessage="No models" />
          </FormField>
        )}
        {targetKind === 'agent' ? (
          <FormField
            label="Version"
            hint="Left on “published”, scans attack whatever is live — the guard. Pin a version to compare releases, or pick the draft to red-team a change before publishing it. A single scan can pick another."
          >
            <Select
              data={versionOptions}
              value={agentVersion}
              onChange={(next) => setAgentVersion(next ?? 'published')}
              allowDeselect={false}
              disabled={!agentKey || agentVersions.loading}
              error={draftScheduled ? 'A scheduled scan guards what is published. Turn off the schedule to use the draft, or pick published or a version.' : undefined}
            />
          </FormField>
        ) : null}
        {agentBlocked ? (
          <Alert color="yellow" variant="light" icon={<IconLock size={16} />}>
            {AGENT_TEST_ACCESS_HINT}
          </Alert>
        ) : null}
      </FormSection>

      <FormSection number={3} title="Probes & judge" done={probeKeys.length > 0 || Boolean(judgeModelKey)}>
        <FormField label="Probes" optional hint="Leave empty to run the default set of built-in probes. The other built-in probes and custom probes must be selected explicitly.">
          <ProbePicker
            probes={probes}
            disabledProbes={disabledProbes}
            value={probeKeys}
            onChange={setProbeKeys}
            targetKind={targetKind}
          />
        </FormField>
        {plantsSystemPrompt.length > 0 ? (
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} title="Not run against agents" data-testid="redteam-agent-skip-warning">
            <Text size="sm" mb={4}>
              These probes plant their own system prompt, and an agent keeps its own instructions, so their attempts are skipped:
            </Text>
            <List size="sm" spacing={2}>
              {plantsSystemPrompt.map((p) => <List.Item key={p.key}>{p.name}</List.Item>)}
            </List>
          </Alert>
        ) : null}
        <FormField label="Judge / attacker model" optional hint="Powers the LLM-judge detectors AND the adaptive multi-turn attacker that escalates across turns. Strongly recommended.">
          <Select searchable clearable data={models} value={judgeModelKey} onChange={setJudgeModelKey} placeholder="Select a judge model" />
        </FormField>
        {!judgeModelKey && needsJudge.length > 0 ? (
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} title="No judge model" data-testid="redteam-judge-warning">
            {needsJudge.length === 1 ? '1 selected probe uses' : `${needsJudge.length} selected probes use`} multi-turn or adaptive
            attacks. Without a judge / attacker model they cannot escalate, and their verdicts rest on the cheap detectors alone.
          </Alert>
        ) : null}
      </FormSection>

      <FormSection number={4} title="Run limits" description="How hard a scan pushes the target.">
        <FormRow cols={2}>
          <FormField label="Concurrency" hint={`Attempts run in parallel, ${RUN_LIMITS.concurrency.min} to ${RUN_LIMITS.concurrency.max}.`}>
            <NumberInput
              value={concurrency}
              onChange={setConcurrency}
              min={RUN_LIMITS.concurrency.min}
              max={RUN_LIMITS.concurrency.max}
              allowDecimal={false}
              allowNegative={false}
              error={validConcurrency ? undefined : `Enter a whole number from ${RUN_LIMITS.concurrency.min} to ${RUN_LIMITS.concurrency.max}.`}
            />
          </FormField>
          <FormField
            label="Max output tokens"
            optional
            hint={targetKind === 'agent'
              ? 'Applies to model targets. An agent keeps its own output limit.'
              : `Per reply, up to ${RUN_LIMITS.maxOutputTokens.max}. Leave empty to use the model's default.`}
          >
            <NumberInput
              value={maxOutputTokens}
              onChange={setMaxOutputTokens}
              min={1}
              max={RUN_LIMITS.maxOutputTokens.max}
              allowDecimal={false}
              allowNegative={false}
              placeholder="Model default"
              error={validMaxTokens ? undefined : `Enter a whole number up to ${RUN_LIMITS.maxOutputTokens.max}.`}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={5} title="Schedule" description="Run automatically on a cron schedule for unattended regression testing.">
        <Switch
          label="Scheduled scan"
          checked={scheduleEnabled}
          onChange={(e) => setScheduleEnabled(e.currentTarget.checked)}
        />
        {scheduleEnabled ? (
          <FormField label="Cron expression (UTC)" hint="Default: every day at 03:00 UTC">
            <TextInput
              value={cron}
              onChange={(e) => setCron(e.currentTarget.value)}
              placeholder="0 3 * * *"
              error={scheduleError ?? undefined}
            />
          </FormField>
        ) : null}
        {fireTimes.length > 0 ? (
          <Text size="xs" c="dimmed" data-testid="redteam-cron-preview">
            Next runs: {fireTimes.map(formatFireTime).join(' · ')}
          </Text>
        ) : null}
      </FormSection>
    </FormShell>
  );
}
