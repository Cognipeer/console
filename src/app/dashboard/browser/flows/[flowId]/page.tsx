'use client';

/**
 * One browser flow: its steps, its inputs, and what happened when it ran.
 *
 * The step list is the product. It is shown as an ordered ledger rather than
 * a card grid because order is the information — step 4 running before step 3
 * is a different automation — and because an operator debugging a 3am failure
 * needs to find "the step that broke" by position, fast.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronLeft,
  IconPlayerPlay,
  IconPlus,
  IconRoute,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import StatusBadge from '@/components/common/ui/StatusBadge';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type {
  BrowserFlowRunView,
  BrowserFlowView,
} from '@/lib/services/browser';
import type { IBrowserFlowInput, IBrowserFlowStep } from '@/lib/database';

const RUN_STATUS_VARIANT: Record<string, 'active' | 'paused' | 'error'> = {
  succeeded: 'active',
  running: 'paused',
  pending: 'paused',
  failed: 'error',
  cancelled: 'paused',
};

/**
 * The actions a step can be, in the order an operator reaches for them.
 *
 * `upload` and `drag` are absent on purpose: one needs a Files id and the
 * other two targets, so neither is a sensible thing to add from a dropdown.
 * They go through the API.
 */
const STEP_TYPES = [
  { value: 'goto', label: 'Navigate to URL' },
  { value: 'click', label: 'Click' },
  { value: 'type', label: 'Type text' },
  { value: 'select', label: 'Select an option' },
  { value: 'check', label: 'Check / uncheck' },
  { value: 'press', label: 'Press a key' },
  { value: 'hover', label: 'Hover' },
  { value: 'scroll', label: 'Scroll' },
  { value: 'wait', label: 'Wait' },
  { value: 'extract', label: 'Read a value' },
  { value: 'back', label: 'Go back' },
  { value: 'forward', label: 'Go forward' },
  { value: 'reload', label: 'Reload' },
];

/** Which step types take an element target rather than acting on the page. */
const TARGETED = new Set(['click', 'type', 'select', 'check', 'press', 'hover', 'scroll', 'extract']);

interface StepDraft {
  type: string;
  role: string;
  name: string;
  testId: string;
  label: string;
  placeholder: string;
  text: string;
  selector: string;
  nth: string;
  url: string;
  key: string;
  value: string;
  ms: string;
  waitText: string;
  checked: boolean;
  captureAs: string;
  retries: number;
  timeoutMs: string;
  optional: boolean;
}

const EMPTY_STEP: StepDraft = {
  type: 'click',
  role: '', name: '', testId: '', label: '', placeholder: '', text: '', selector: '', nth: '',
  url: '', key: '', value: '', ms: '', waitText: '', checked: true,
  captureAs: '', retries: 0, timeoutMs: '', optional: false,
};

/** Turn the editor's flat draft into the action payload the API accepts. */
function draftToAction(draft: StepDraft): Record<string, unknown> {
  const action: Record<string, unknown> = { type: draft.type };

  if (TARGETED.has(draft.type)) {
    if (draft.role.trim()) action.role = draft.role.trim();
    if (draft.name.trim()) action.name = draft.name.trim();
    if (draft.testId.trim()) action.testId = draft.testId.trim();
    if (draft.label.trim()) action.label = draft.label.trim();
    if (draft.placeholder.trim()) action.placeholder = draft.placeholder.trim();
    if (draft.text.trim() && draft.type !== 'type') action.text = draft.text.trim();
    if (draft.selector.trim()) action.selector = draft.selector.trim();
    if (draft.nth.trim()) action.nth = Number(draft.nth);
  }

  if (draft.type === 'goto') action.url = draft.url.trim();
  if (draft.type === 'press') action.key = draft.key.trim();
  if (draft.type === 'type') action.text = draft.value;
  if (draft.type === 'select') action.labels = [draft.value];
  if (draft.type === 'check') action.checked = draft.checked;
  if (draft.type === 'wait') {
    if (draft.waitText.trim()) action.text = draft.waitText.trim();
    else if (draft.ms.trim()) action.ms = Number(draft.ms);
    else if (draft.selector.trim()) action.selector = draft.selector.trim();
  }
  if (draft.type === 'scroll' && draft.ms.trim()) action.y = Number(draft.ms);

  return action;
}

function describeStep(step: IBrowserFlowStep): string {
  if (step.label) return step.label;
  const action = step.action as Record<string, unknown>;
  return `${action.type ?? 'step'}`;
}

export default function BrowserFlowDetailPage() {
  const router = useRouter();
  const params = useParams<{ flowId: string }>();
  const flowId = params?.flowId ?? '';

  const [flow, setFlow] = useState<BrowserFlowView | null>(null);
  const [runs, setRuns] = useState<BrowserFlowRunView[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const [stepOpen, setStepOpen] = useState(false);
  const [stepDraft, setStepDraft] = useState<StepDraft>(EMPTY_STEP);
  const [inputOpen, setInputOpen] = useState(false);
  const [inputDraft, setInputDraft] = useState<IBrowserFlowInput>({ name: '', type: 'string', required: true });
  const [runOpen, setRunOpen] = useState(false);
  const [runValues, setRunValues] = useState<Record<string, string>>({});
  const [selectedRun, setSelectedRun] = useState<BrowserFlowRunView | null>(null);

  const load = useCallback(async () => {
    try {
      const [flowRes, runsRes] = await Promise.all([
        fetch(`/api/browser/flows/${flowId}`, { cache: 'no-store' }),
        fetch(`/api/browser/flow-runs?flowId=${encodeURIComponent(flowId)}&limit=25`, { cache: 'no-store' }),
      ]);
      if (!flowRes.ok) throw new Error('Flow not found');
      setFlow((await flowRes.json()).flow);
      setRuns(runsRes.ok ? (await runsRes.json()).runs ?? [] : []);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to load flow',
      });
    } finally {
      setLoading(false);
    }
  }, [flowId]);

  useEffect(() => {
    if (flowId) void load();
  }, [flowId, load]);

  const patch = useCallback(async (body: Record<string, unknown>, message?: string) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/browser/flows/${flowId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setFlow(data.flow);
      if (message) notifications.show({ color: 'teal', title: 'Saved', message });
      return true;
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Save failed',
      });
      return false;
    } finally {
      setSaving(false);
    }
  }, [flowId]);

  const saveSteps = useCallback(
    (steps: IBrowserFlowStep[], message?: string) => patch({ steps }, message),
    [patch],
  );

  const moveStep = (index: number, delta: number) => {
    if (!flow) return;
    const next = [...flow.steps];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void saveSteps(next);
  };

  const removeStep = (index: number) => {
    if (!flow) return;
    void saveSteps(flow.steps.filter((_, i) => i !== index), 'Step removed');
  };

  const addStep = () => {
    if (!flow) return;
    const action = draftToAction(stepDraft);
    void saveSteps([...flow.steps, {
      id: '',
      action,
      captureAs: stepDraft.captureAs.trim() || undefined,
      policy: {
        ...(stepDraft.retries ? { retries: stepDraft.retries } : {}),
        ...(stepDraft.timeoutMs.trim() ? { timeoutMs: Number(stepDraft.timeoutMs) } : {}),
        ...(stepDraft.optional ? { optional: true } : {}),
      },
    } as IBrowserFlowStep], 'Step added').then((ok) => {
      if (ok) {
        setStepOpen(false);
        setStepDraft(EMPTY_STEP);
      }
    });
  };

  const addInput = () => {
    if (!flow) return;
    void patch(
      { inputs: [...(flow.inputs ?? []), inputDraft] },
      'Input added',
    ).then((ok) => {
      if (ok) {
        setInputOpen(false);
        setInputDraft({ name: '', type: 'string', required: true });
      }
    });
  };

  const removeInput = (name: string) => {
    if (!flow) return;
    void patch({ inputs: (flow.inputs ?? []).filter((item) => item.name !== name) }, 'Input removed');
  };

  async function executeRun() {
    setRunning(true);
    try {
      const res = await fetch(`/api/browser/flows/${flowId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: runValues }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Run failed to start');

      const run = data.run as BrowserFlowRunView;
      notifications.show({
        color: run.status === 'succeeded' ? 'teal' : 'red',
        title: run.status === 'succeeded' ? 'Flow succeeded' : 'Flow failed',
        message: run.status === 'succeeded'
          ? `${run.stepResults?.length ?? 0} step(s) in ${run.durationMs ?? 0}ms`
          : run.errorMessage ?? 'See the run for details',
      });
      setRunOpen(false);
      setSelectedRun(run);
      await load();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Run failed',
      });
    } finally {
      setRunning(false);
    }
  }

  const stats = useMemo(() => {
    const succeeded = runs.filter((run) => run.status === 'succeeded').length;
    const failed = runs.filter((run) => run.status === 'failed').length;
    const durations = runs.map((run) => run.durationMs ?? 0).filter(Boolean);
    const median = durations.length
      ? [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)]
      : 0;
    return { succeeded, failed, median };
  }, [runs]);

  if (loading) {
    return <PageContainer><Text c="dimmed">Loading…</Text></PageContainer>;
  }
  if (!flow) {
    return <PageContainer><Text c="dimmed">Flow not found.</Text></PageContainer>;
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Browsers · Flows"
        title={flow.name}
        subtitle={flow.description || `${flow.steps.length} step(s) · version ${flow.version}`}
        actions={(
          <Group gap="xs">
            <Button
              variant="default"
              size="sm"
              leftSection={<IconChevronLeft size={14} />}
              onClick={() => router.push('/dashboard/browser/flows')}
            >
              All flows
            </Button>
            <Select
              size="sm"
              w={130}
              value={flow.status}
              data={[
                { value: 'draft', label: 'Draft' },
                { value: 'active', label: 'Active' },
                { value: 'disabled', label: 'Disabled' },
              ]}
              onChange={(value) => value && patch({ status: value }, `Flow is now ${value}`)}
              aria-label="Flow status"
            />
            <Button
              color="teal"
              size="sm"
              loading={running}
              disabled={flow.steps.length === 0}
              leftSection={<IconPlayerPlay size={14} stroke={1.7} />}
              onClick={() => {
                const seed: Record<string, string> = {};
                for (const item of flow.inputs ?? []) {
                  seed[item.name] = item.default === undefined ? '' : String(item.default);
                }
                setRunValues(seed);
                setRunOpen(true);
              }}
            >
              Run flow
            </Button>
          </Group>
        )}
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Steps" icon={<IconRoute size={14} stroke={1.7} />} value={flow.steps.length} />
        <StatTile label="Inputs" value={flow.inputs?.length ?? 0} />
        <StatTile label="Succeeded" value={stats.succeeded} />
        <StatTile label="Failed" value={stats.failed} delta={stats.median ? `${stats.median}ms median` : undefined} />
      </div>

      {/* ── Inputs ─────────────────────────────────────────────── */}
      <section style={{ marginBottom: 24 }}>
        <Group justify="space-between" mb="xs">
          <Text size="sm" fw={600}>Inputs</Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={13} />}
            onClick={() => setInputOpen(true)}
          >
            Add input
          </Button>
        </Group>
        {(flow.inputs?.length ?? 0) === 0 ? (
          <Text size="xs" c="dimmed" fs="italic">
            No inputs. Recording adds one for every value that was typed, so nothing is baked into the steps.
          </Text>
        ) : (
          <Stack gap={4}>
            {flow.inputs?.map((item) => (
              <Group key={item.name} gap="xs" wrap="nowrap">
                <Code>{`{{input.${item.name}}}`}</Code>
                <Badge size="xs" variant="light" color={item.type === 'secret' ? 'orange' : 'gray'}>
                  {item.type}
                </Badge>
                {item.required ? <Badge size="xs" variant="light" color="blue">required</Badge> : null}
                <Text size="xs" c="dimmed" style={{ flex: 1 }}>{item.description ?? item.label ?? ''}</Text>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => removeInput(item.name)}
                >
                  <IconTrash size={13} />
                </ActionIcon>
              </Group>
            ))}
          </Stack>
        )}
      </section>

      {/* ── Steps ──────────────────────────────────────────────── */}
      <section style={{ marginBottom: 24 }}>
        <Group justify="space-between" mb="xs">
          <Text size="sm" fw={600}>Steps</Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={13} />}
            onClick={() => setStepOpen(true)}
          >
            Add step
          </Button>
        </Group>

        {flow.steps.length === 0 ? (
          <Text size="xs" c="dimmed" fs="italic">
            No steps yet. Record a driven session, or add steps by hand.
          </Text>
        ) : (
          <Stack gap={0}>
            {flow.steps.map((step, index) => (
              <Group
                key={step.id}
                wrap="nowrap"
                gap="sm"
                style={{
                  padding: '10px 12px',
                  borderTop: index === 0 ? '1px solid var(--ds-border)' : undefined,
                  borderBottom: '1px solid var(--ds-border)',
                  borderLeft: `3px solid ${
                    selectedRun?.failedStepIndex === index ? 'var(--ds-err)' : 'transparent'
                  }`,
                }}
              >
                <Text size="xs" c="dimmed" ff="monospace" w={24}>{index + 1}</Text>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm">{describeStep(step)}</Text>
                  <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>
                    {JSON.stringify(step.action)}
                  </Text>
                </div>
                {step.captureAs ? (
                  <Badge size="xs" variant="light" color="teal">→ {step.captureAs}</Badge>
                ) : null}
                {step.policy?.optional ? <Badge size="xs" variant="light">optional</Badge> : null}
                {step.policy?.retries ? (
                  <Badge size="xs" variant="light">{step.policy.retries} retries</Badge>
                ) : null}
                <Group gap={2} wrap="nowrap">
                  <Tooltip label="Move up">
                    <ActionIcon size="sm" variant="subtle" disabled={index === 0 || saving} onClick={() => moveStep(index, -1)} aria-label="Move step up">
                      <IconArrowUp size={13} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Move down">
                    <ActionIcon size="sm" variant="subtle" disabled={index === flow.steps.length - 1 || saving} onClick={() => moveStep(index, 1)} aria-label="Move step down">
                      <IconArrowDown size={13} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Remove">
                    <ActionIcon size="sm" variant="subtle" color="red" disabled={saving} onClick={() => removeStep(index)} aria-label="Remove step">
                      <IconTrash size={13} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            ))}
          </Stack>
        )}
      </section>

      {/* ── Run history ────────────────────────────────────────── */}
      <section>
        <Text size="sm" fw={600} mb="xs">Run history</Text>
        {runs.length === 0 ? (
          <Text size="xs" c="dimmed" fs="italic">Never run.</Text>
        ) : (
          <Stack gap={0}>
            {runs.map((run) => (
              <Group
                key={run.id}
                wrap="nowrap"
                gap="sm"
                style={{
                  padding: '9px 12px',
                  borderBottom: '1px solid var(--ds-border)',
                  cursor: 'pointer',
                  background: selectedRun?.id === run.id ? 'var(--ds-surface-sunken)' : undefined,
                }}
                onClick={() => setSelectedRun(run)}
              >
                <StatusBadge status={RUN_STATUS_VARIANT[run.status] ?? 'paused'} label={run.status} />
                <Text size="xs" c="dimmed">{run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}</Text>
                <Badge size="xs" variant="light">{run.trigger}</Badge>
                <Text size="xs" c="dimmed">v{run.flowVersion}</Text>
                <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                  {run.status === 'failed'
                    ? `failed at step ${(run.failedStepIndex ?? 0) + 1}: ${run.errorMessage ?? ''}`
                    : `${run.stepResults?.length ?? 0} step(s)`}
                </Text>
                <Text size="xs" c="dimmed" ff="monospace">{run.durationMs ?? 0}ms</Text>
              </Group>
            ))}
          </Stack>
        )}

        {selectedRun ? (
          <div style={{ marginTop: 16 }}>
            <Text size="xs" fw={600} mb={6}>
              Run {selectedRun.id.slice(0, 8)} · {selectedRun.status}
            </Text>
            <Stack gap={2}>
              {selectedRun.stepResults?.map((result) => (
                <Group key={result.stepId} gap="xs" wrap="nowrap">
                  <Text size="xs" ff="monospace" c="dimmed" w={24}>{result.index + 1}</Text>
                  <Badge
                    size="xs"
                    variant="light"
                    color={result.status === 'succeeded' ? 'teal' : result.status === 'skipped' ? 'gray' : 'red'}
                  >
                    {result.status}
                  </Badge>
                  <Text size="xs" c="dimmed" style={{ flex: 1, wordBreak: 'break-all' }}>
                    {result.errorMessage ?? result.url ?? ''}
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace">{result.attempts}× · {result.durationMs ?? 0}ms</Text>
                </Group>
              ))}
            </Stack>
            {selectedRun.outputs && Object.keys(selectedRun.outputs).length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <Text size="xs" fw={600} mb={4}>Captured</Text>
                <Code block>{JSON.stringify(selectedRun.outputs, null, 2)}</Code>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* ── Add step ───────────────────────────────────────────── */}
      <FormShell
        open={stepOpen}
        onClose={() => setStepOpen(false)}
        title="Add step"
        subtitle="Describe the element the way a person would — role and name survive a redesign, a CSS selector usually does not."
        icon={<IconRoute size={18} stroke={1.7} />}
        primaryAction={{ label: 'Add step', color: 'teal', loading: saving, onClick: addStep }}
        secondaryAction={{ label: 'Cancel', onClick: () => setStepOpen(false) }}
      >
        <FormSection number={1} title="Action">
          <FormRow cols={1}>
            <FormField label="What this step does" required>
              <Select
                data={STEP_TYPES}
                value={stepDraft.type}
                onChange={(value) => value && setStepDraft((draft) => ({ ...draft, type: value }))}
              />
            </FormField>
          </FormRow>

          {stepDraft.type === 'goto' ? (
            <FormRow cols={1}>
              <FormField label="URL" required hint="Supports {{input.name}} placeholders.">
                <TextInput
                  placeholder="https://portal.example.com/expenses"
                  value={stepDraft.url}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, url: event.currentTarget.value }))}
                />
              </FormField>
            </FormRow>
          ) : null}

          {stepDraft.type === 'type' ? (
            <FormRow cols={1}>
              <FormField label="Text to type" required hint="Use {{input.name}} so the value is supplied per run rather than stored here.">
                <TextInput
                  placeholder="{{input.reference}}"
                  value={stepDraft.value}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, value: event.currentTarget.value }))}
                />
              </FormField>
            </FormRow>
          ) : null}

          {stepDraft.type === 'select' ? (
            <FormRow cols={1}>
              <FormField label="Option label" required>
                <TextInput
                  placeholder="Administrator"
                  value={stepDraft.value}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, value: event.currentTarget.value }))}
                />
              </FormField>
            </FormRow>
          ) : null}

          {stepDraft.type === 'press' ? (
            <FormRow cols={1}>
              <FormField label="Key" required>
                <TextInput
                  placeholder="Enter"
                  value={stepDraft.key}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, key: event.currentTarget.value }))}
                />
              </FormField>
            </FormRow>
          ) : null}

          {stepDraft.type === 'check' ? (
            <FormRow cols={1}>
              <FormField label="Target state" hint="Checking is idempotent — replaying will not toggle a box that is already right.">
                <Switch
                  label={stepDraft.checked ? 'Checked' : 'Unchecked'}
                  checked={stepDraft.checked}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, checked: event.currentTarget.checked }))}
                />
              </FormField>
            </FormRow>
          ) : null}

          {stepDraft.type === 'wait' ? (
            <FormRow cols={2}>
              <FormField label="Until this text appears" optional>
                <TextInput
                  placeholder="Payment received"
                  value={stepDraft.waitText}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, waitText: event.currentTarget.value }))}
                />
              </FormField>
              <FormField label="Or a fixed delay (ms)" optional>
                <TextInput
                  placeholder="1000"
                  value={stepDraft.ms}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, ms: event.currentTarget.value }))}
                />
              </FormField>
            </FormRow>
          ) : null}

          {stepDraft.type === 'scroll' ? (
            <FormRow cols={1}>
              <FormField label="Scroll down by (px)" optional hint="Leave empty and give a target below to scroll that element into view.">
                <TextInput
                  placeholder="800"
                  value={stepDraft.ms}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, ms: event.currentTarget.value }))}
                />
              </FormField>
            </FormRow>
          ) : null}
        </FormSection>

        {TARGETED.has(stepDraft.type) ? (
          <FormSection
            number={2}
            title="Which element"
            description="Fill the most durable one you can. Role + name is what a screen reader would say; a test id is even better when the app provides one."
          >
            <FormRow cols={2}>
              <FormField label="Role" hint="button, link, textbox, checkbox, combobox…">
                <TextInput
                  placeholder="button"
                  value={stepDraft.role}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, role: event.currentTarget.value }))}
                />
              </FormField>
              <FormField label="Accessible name">
                <TextInput
                  placeholder="Sign in"
                  value={stepDraft.name}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, name: event.currentTarget.value }))}
                />
              </FormField>
            </FormRow>
            <FormRow cols={2}>
              <FormField label="Test id" optional>
                <TextInput
                  placeholder="submit-btn"
                  value={stepDraft.testId}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, testId: event.currentTarget.value }))}
                />
              </FormField>
              <FormField label="Form label" optional>
                <TextInput
                  placeholder="Username"
                  value={stepDraft.label}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, label: event.currentTarget.value }))}
                />
              </FormField>
            </FormRow>
            <FormRow cols={2}>
              <FormField label="Placeholder" optional>
                <TextInput
                  value={stepDraft.placeholder}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, placeholder: event.currentTarget.value }))}
                />
              </FormField>
              <FormField label="Nth match" optional hint="Only when the target above matches several elements.">
                <TextInput
                  placeholder="0"
                  value={stepDraft.nth}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, nth: event.currentTarget.value }))}
                />
              </FormField>
            </FormRow>
            <FormRow cols={1}>
              <FormField label="CSS selector" optional hint="Last resort — it encodes markup nobody promised to keep.">
                <TextInput
                  placeholder="#submit"
                  value={stepDraft.selector}
                  onChange={(event) => setStepDraft((draft) => ({ ...draft, selector: event.currentTarget.value }))}
                />
              </FormField>
            </FormRow>
          </FormSection>
        ) : null}

        <FormSection
          number={TARGETED.has(stepDraft.type) ? 3 : 2}
          title="When it goes wrong"
          collapsible
          defaultOpen={false}
        >
          <FormRow cols={2}>
            <FormField label="Retries" hint="Delay doubles between attempts.">
              <NumberInput
                min={0}
                max={10}
                value={stepDraft.retries}
                onChange={(value) => setStepDraft((draft) => ({ ...draft, retries: Number(value) || 0 }))}
              />
            </FormField>
            <FormField label="Timeout (ms)" optional>
              <TextInput
                placeholder="15000"
                value={stepDraft.timeoutMs}
                onChange={(event) => setStepDraft((draft) => ({ ...draft, timeoutMs: event.currentTarget.value }))}
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label="Optional" hint="A failing optional step is recorded and skipped instead of aborting the run.">
              <Switch
                checked={stepDraft.optional}
                onChange={(event) => setStepDraft((draft) => ({ ...draft, optional: event.currentTarget.checked }))}
              />
            </FormField>
            <FormField label="Capture result as" optional hint="Makes the value available to later steps and to the run's outputs.">
              <TextInput
                placeholder="receipt"
                value={stepDraft.captureAs}
                onChange={(event) => setStepDraft((draft) => ({ ...draft, captureAs: event.currentTarget.value }))}
              />
            </FormField>
          </FormRow>
        </FormSection>
      </FormShell>

      {/* ── Add input ──────────────────────────────────────────── */}
      <FormShell
        open={inputOpen}
        onClose={() => setInputOpen(false)}
        title="Add flow input"
        subtitle="Inputs are supplied per run and referenced from steps as {{input.name}}."
        primaryAction={{ label: 'Add input', color: 'teal', loading: saving, onClick: addInput }}
        secondaryAction={{ label: 'Cancel', onClick: () => setInputOpen(false) }}
      >
        <FormSection title="Definition">
          <FormRow cols={2}>
            <FormField label="Name" required hint="Used as {{input.name}}. Letters, digits and underscores.">
              <TextInput
                placeholder="reference"
                value={inputDraft.name}
                onChange={(event) => setInputDraft((draft) => ({ ...draft, name: event.currentTarget.value }))}
              />
            </FormField>
            <FormField label="Type" required hint="A secret is never written to the run record.">
              <Select
                data={[
                  { value: 'string', label: 'Text' },
                  { value: 'number', label: 'Number' },
                  { value: 'boolean', label: 'Boolean' },
                  { value: 'secret', label: 'Secret' },
                ]}
                value={inputDraft.type}
                onChange={(value) => value && setInputDraft((draft) => ({
                  ...draft,
                  type: value as IBrowserFlowInput['type'],
                  // A default on a secret would be a credential stored in the
                  // flow document, readable by anyone who can see the flow.
                  default: value === 'secret' ? undefined : draft.default,
                }))}
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label="Required">
              <Switch
                checked={inputDraft.required ?? false}
                onChange={(event) => setInputDraft((draft) => ({ ...draft, required: event.currentTarget.checked }))}
              />
            </FormField>
            <FormField label="Default" optional hint={inputDraft.type === 'secret' ? 'Not available for secrets.' : undefined}>
              <TextInput
                disabled={inputDraft.type === 'secret'}
                value={inputDraft.default === undefined ? '' : String(inputDraft.default)}
                onChange={(event) => setInputDraft((draft) => ({
                  ...draft,
                  default: event.currentTarget.value || undefined,
                }))}
              />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label="Description" optional>
              <Textarea
                autosize
                minRows={2}
                value={inputDraft.description ?? ''}
                onChange={(event) => setInputDraft((draft) => ({ ...draft, description: event.currentTarget.value }))}
              />
            </FormField>
          </FormRow>
        </FormSection>
      </FormShell>

      {/* ── Run ────────────────────────────────────────────────── */}
      <FormShell
        open={runOpen}
        onClose={() => setRunOpen(false)}
        title={`Run ${flow.name}`}
        subtitle={`${flow.steps.length} step(s) will run in a fresh browser session.`}
        icon={<IconPlayerPlay size={18} stroke={1.7} />}
        primaryAction={{ label: 'Run now', color: 'teal', loading: running, onClick: executeRun }}
        secondaryAction={{ label: 'Cancel', onClick: () => setRunOpen(false) }}
      >
        <FormSection title="Inputs">
          {(flow.inputs?.length ?? 0) === 0 ? (
            <Text size="sm" c="dimmed">This flow takes no inputs.</Text>
          ) : (
            flow.inputs?.map((item) => (
              <FormRow key={item.name} cols={1}>
                <FormField
                  label={item.label || item.name}
                  required={item.required}
                  hint={item.description}
                >
                  <TextInput
                    type={item.type === 'secret' ? 'password' : 'text'}
                    placeholder={item.type === 'secret' ? 'Supplied per run, never stored' : undefined}
                    value={runValues[item.name] ?? ''}
                    onChange={(event) => setRunValues((values) => ({
                      ...values,
                      [item.name]: event.currentTarget.value,
                    }))}
                  />
                </FormField>
              </FormRow>
            ))
          )}
        </FormSection>
      </FormShell>
    </PageContainer>
  );
}
