'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconClipboardText, IconPlus, IconTrash } from '@tabler/icons-react';
import FormShell, {
  ChipPicker,
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import { FIELD_TYPE_LABELS, isDecisionType } from './decisionUi';
import type {
  AnalysisDefinitionView,
  AnalysisFieldType,
  DecisionModelOption,
  ModelOption,
} from './types';

interface CreateDefinitionModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (definition: AnalysisDefinitionView) => void;
  models?: ModelOption[];
  /** When set, the modal edits this definition (PATCH) instead of creating one. */
  editing?: AnalysisDefinitionView | null;
}

type SourceKind = 'conversations' | 'agent_sessions';

interface FieldRow {
  key: string;
  type: AnalysisFieldType;
  required: boolean;
  /** Choice: option keys; Score: level labels (lowest first). Comma-separated. */
  values: string;
  description: string;
  /** Set from the Review quality card; not editable here, but kept on save. */
  reviewBelow?: number;
}

const TYPE_OPTIONS = (Object.keys(FIELD_TYPE_LABELS) as AnalysisFieldType[]).map((value) => ({
  value,
  label: FIELD_TYPE_LABELS[value],
}));

const SOURCE_OPTIONS: Array<{ value: SourceKind; label: string }> = [
  { value: 'conversations', label: 'Imported conversations' },
  { value: 'agent_sessions', label: 'Agent sessions' },
];

const DEFAULT_THRESHOLD = 0.7;
/** Self-reported confidence runs high, so a stricter default keeps review honest. */
const SELF_REPORTED_THRESHOLD = 0.85;
/** One decision call answers every question; past this the answers get unreliable. */
const MAX_COMFORTABLE_QUESTIONS = 16;

const emptyField = (): FieldRow => ({ key: '', type: 'string', required: false, values: '', description: '' });

const splitList = (value: string): string[] => value.split(',').map((v) => v.trim()).filter(Boolean);

interface ApiModel {
  key: string;
  name: string;
  settings?: { decision?: { mode?: string } };
}

export default function CreateDefinitionModal({ opened, onClose, onCreated, models = [], editing = null }: CreateDefinitionModalProps) {
  const isEdit = Boolean(editing);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [fields, setFields] = useState<FieldRow[]>([emptyField()]);
  const [sourceKind, setSourceKind] = useState<SourceKind>('conversations');
  const [agentKeys, setAgentKeys] = useState<string[]>([]);
  const [minMessages, setMinMessages] = useState<number>(2);
  const [idleMinutes, setIdleMinutes] = useState<number>(30);
  const [lookBackDays, setLookBackDays] = useState<number>(7);
  const [extractionModelKey, setExtractionModelKey] = useState('');
  const [decisionModelKey, setDecisionModelKey] = useState('');
  const [threshold, setThreshold] = useState<number>(DEFAULT_THRESHOLD);
  const [thresholdEdited, setThresholdEdited] = useState(false);
  const [spotCheckPct, setSpotCheckPct] = useState<number>(0);
  const [modeStore, setModeStore] = useState(true);
  const [modeAccuracy, setModeAccuracy] = useState(false);
  const [modeJudge, setModeJudge] = useState(false);
  const [judgeRubric, setJudgeRubric] = useState('');
  const [judgeModelKey, setJudgeModelKey] = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleCron, setScheduleCron] = useState('0 2 * * *');
  const [error, setError] = useState<string | null>(null);
  const [decisionModels, setDecisionModels] = useState<DecisionModelOption[]>([]);
  const [agents, setAgents] = useState<ModelOption[]>([]);

  useEffect(() => {
    if (!opened) {
      setName(''); setDescription(''); setInstructions('');
      setFields([emptyField()]); setExtractionModelKey('');
      setSourceKind('conversations'); setAgentKeys([]);
      setMinMessages(2); setIdleMinutes(30); setLookBackDays(7);
      setDecisionModelKey(''); setThreshold(DEFAULT_THRESHOLD); setThresholdEdited(false); setSpotCheckPct(0);
      setModeStore(true); setModeAccuracy(false); setModeJudge(false);
      setJudgeRubric(''); setJudgeModelKey('');
      setScheduleEnabled(false); setScheduleCron('0 2 * * *'); setError(null);
      return;
    }
    if (editing) {
      setName(editing.name ?? '');
      setDescription(editing.description ?? '');
      setInstructions(editing.extractionInstructions ?? '');
      setFields(
        editing.fieldSet.length > 0
          ? editing.fieldSet.map((f) => ({
              key: f.key,
              type: f.type,
              required: Boolean(f.required),
              values: (f.type === 'score' ? f.levels : f.enumValues ?? [])?.join(', ') ?? '',
              description: f.description ?? '',
              reviewBelow: f.reviewBelow,
            }))
          : [emptyField()],
      );
      if (editing.source?.kind === 'agent_sessions') {
        setSourceKind('agent_sessions');
        setAgentKeys(editing.source.agentKeys);
        setMinMessages(editing.source.minMessages ?? 2);
        setIdleMinutes(editing.source.idleMinutes ?? 30);
        setLookBackDays(editing.source.days ?? 7);
      }
      setExtractionModelKey(editing.extractionModelKey ?? '');
      setDecisionModelKey(editing.decisionModelKey ?? '');
      setThreshold(editing.review?.threshold ?? DEFAULT_THRESHOLD);
      setThresholdEdited(editing.review?.threshold !== undefined);
      setSpotCheckPct(editing.review?.spotCheckPct ?? 0);
      setModeStore(Boolean(editing.modes.store));
      setModeAccuracy(Boolean(editing.modes.accuracy));
      setModeJudge(Boolean(editing.modes.judge));
      setJudgeRubric(editing.modes.judge?.rubric ?? '');
      setJudgeModelKey(editing.judgeModelKey ?? '');
      setScheduleEnabled(Boolean(editing.schedule?.enabled));
      setScheduleCron(editing.schedule?.cron || '0 2 * * *');
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  // Decision models and the project's agents are only needed while the editor is open.
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [mRes, aRes] = await Promise.all([
          fetch('/api/models?category=decision', { cache: 'no-store' }),
          fetch('/api/agents', { cache: 'no-store' }),
        ]);
        if (cancelled) return;
        if (mRes.ok) {
          const data = await mRes.json();
          setDecisionModels(((data.models ?? []) as ApiModel[]).map((m) => ({
            value: m.key,
            label: m.name,
            selfReported: m.settings?.decision?.mode !== 'native',
          })));
        }
        if (aRes.ok) {
          const data = await aRes.json();
          setAgents(((data.agents ?? []) as Array<{ key: string; name: string }>).map((a) => ({ value: a.key, label: a.name })));
        }
      } catch (err) {
        console.error('Failed to load decision models / agents', err);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [opened]);

  const updateField = (idx: number, patch: Partial<FieldRow>) => {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };

  const pickDecisionModel = (value: string) => {
    setDecisionModelKey(value);
    const picked = decisionModels.find((m) => m.value === value);
    // Pre-fill a stricter threshold for self-reported confidence until the user sets their own.
    if (!thresholdEdited) setThreshold(picked?.selfReported ? SELF_REPORTED_THRESHOLD : DEFAULT_THRESHOLD);
  };

  const namedFields = useMemo(() => fields.filter((f) => f.key.trim()), [fields]);
  const hasDecisionModel = Boolean(decisionModelKey);
  const decisionQuestionCount = namedFields.filter((f) => isDecisionType(f.type)).length;
  // Text and Number fields always go to extraction; with no decision model everything does.
  const needsExtractionModel = !hasDecisionModel || namedFields.some((f) => !isDecisionType(f.type));
  const selfReported = decisionModels.find((m) => m.value === decisionModelKey)?.selfReported ?? false;

  const agentOptions = useMemo(() => {
    const known = new Set(agents.map((a) => a.value));
    return [...agents, ...agentKeys.filter((k) => !known.has(k)).map((k) => ({ value: k, label: k }))];
  }, [agents, agentKeys]);

  const decisionModelOptions = useMemo(() => {
    if (!decisionModelKey || decisionModels.some((m) => m.value === decisionModelKey)) return decisionModels;
    return [...decisionModels, { value: decisionModelKey, label: decisionModelKey, selfReported: true }];
  }, [decisionModels, decisionModelKey]);

  const validName = name.trim().length > 0;
  const validFields = namedFields.length > 0;
  const validSource = sourceKind === 'conversations' || agentKeys.length > 0;
  const validModel = !needsExtractionModel || Boolean(extractionModelKey);
  const validJudge = !modeJudge || (judgeRubric.trim().length > 0 && Boolean(judgeModelKey));
  const canSubmit = validName && validFields && validSource && validModel && validJudge;

  const handleSubmit = async () => {
    if (!name.trim()) return setError('Name is required');
    if (namedFields.length === 0) return setError('Add at least one field with a key');
    if (!validSource) return setError('Pick at least one agent whose sessions are analyzed');
    if (needsExtractionModel && !extractionModelKey) {
      return setError(hasDecisionModel ? 'An extraction model is required for Text and Number fields' : 'An extraction model is required');
    }
    if (modeJudge && !judgeRubric.trim()) return setError('A judge rubric is required when the judge mode is on');
    if (modeJudge && !judgeModelKey) return setError('A judge model is required when the judge mode is on');
    for (const f of namedFields) {
      const values = splitList(f.values);
      if (f.type === 'enum' && values.length === 0) {
        return setError(`Choice field "${f.key}" needs comma-separated values`);
      }
      if (f.type === 'score' && (values.length < 2 || values.length > 20)) {
        return setError(`Score field "${f.key}" needs 2 to 20 levels, lowest first`);
      }
    }
    setError(null);
    setLoading(true);
    try {
      const fieldSet = namedFields.map((f) => ({
        key: f.key.trim(),
        type: f.type,
        description: f.description.trim() || undefined,
        required: f.required || undefined,
        enumValues: f.type === 'enum' ? splitList(f.values) : undefined,
        levels: f.type === 'score' ? splitList(f.values) : undefined,
        reviewBelow: isDecisionType(f.type) ? f.reviewBelow : undefined,
      }));
      const modes = {
        store: modeStore || undefined,
        accuracy: modeAccuracy || undefined,
        judge: modeJudge ? { rubric: judgeRubric.trim() } : undefined,
      };
      const source = sourceKind === 'agent_sessions'
        ? { kind: 'agent_sessions' as const, agentKeys, minMessages, idleMinutes, days: lookBackDays }
        : { kind: 'conversations' as const };
      const res = await fetch(
        isEdit ? `/api/analysis/definitions/${editing!.id}` : '/api/analysis/definitions',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            description: description || undefined,
            fieldSet,
            extractionInstructions: instructions || undefined,
            modes,
            source,
            extractionModelKey: extractionModelKey || undefined,
            // null clears a decision model that an edit removed.
            decisionModelKey: hasDecisionModel ? decisionModelKey : isEdit && editing?.decisionModelKey ? null : undefined,
            review: hasDecisionModel ? { threshold, spotCheckPct } : undefined,
            judgeModelKey: modeJudge ? judgeModelKey : undefined,
            schedule: scheduleEnabled ? { cron: scheduleCron.trim(), enabled: true } : { enabled: false, cron: scheduleCron.trim() },
          }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to ${isEdit ? 'update' : 'create'} definition`);
      }
      const data = await res.json();
      notifications.show({ title: isEdit ? 'Definition updated' : 'Definition created', message: `"${data.definition.name}" was ${isEdit ? 'updated' : 'created'}`, color: 'teal' });
      onCreated(data.definition);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to create', color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const modeLabels = [
    needsExtractionModel ? 'extract' : null,
    hasDecisionModel ? 'decide' : null,
    modeStore ? 'store' : null,
    modeAccuracy ? 'accuracy' : null,
    modeJudge ? 'judge' : null,
  ].filter(Boolean).join(', ');

  const sourceLabel = sourceKind === 'agent_sessions'
    ? `Agent sessions · ${agentKeys.length} agent${agentKeys.length === 1 ? '' : 's'}`
    : 'Imported conversations';

  const checklist = [
    { id: 'name', label: 'Name provided', done: validName },
    { id: 'source', label: sourceKind === 'agent_sessions' ? `${agentKeys.length} agent(s) selected` : 'Imported conversations', done: validSource },
    { id: 'fields', label: `${namedFields.length} field(s) defined`, done: validFields },
    { id: 'model', label: needsExtractionModel ? 'Extraction model selected' : 'No extraction model needed', done: validModel },
    { id: 'judge', label: modeJudge ? 'Judge rubric + model set' : 'Judge mode off', done: validJudge },
  ];

  const summary = (
    <SummaryGroup title="Definition">
      <SummaryKV label="Name" value={name || '—'} />
      <SummaryKV label="Source" value={sourceLabel} />
      <SummaryKV label="Fields" value={String(namedFields.length)} />
      <SummaryKV label="Modes" value={modeLabels || '—'} />
      <SummaryKV label="Extraction model" value={extractionModelKey || '—'} />
      <SummaryKV label="Decision model" value={decisionModelKey || '—'} />
      <SummaryKV label="Schedule" value={scheduleEnabled ? scheduleCron : 'manual'} />
      <Checklist items={checklist} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconClipboardText size={16} />}
      title={isEdit ? 'Edit analysis definition' : 'New analysis definition'}
      subtitle="Declare where conversations come from, the fields to answer, and which modes to apply."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Create definition',
        icon: <IconCheck size={13} />,
        loading,
        disabled: !canSubmit,
        onClick: () => void handleSubmit(),
      }}
    >
      <FormSection number={1} title="Identity" done={validName}>
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput placeholder="e.g. Call intent & resolution" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          </FormField>
          <FormField label="Description" optional>
            <Textarea placeholder="What does this analysis capture?" autosize minRows={1} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={2} title="Source" done={validSource}>
        <FormField label="Conversations come from">
          <ChipPicker<SourceKind>
            value={sourceKind}
            onChange={(v) => setSourceKind(v as SourceKind)}
            options={SOURCE_OPTIONS}
          />
        </FormField>
        {sourceKind === 'agent_sessions' && (
          <>
            <FormField label="Agents" required>
              <MultiSelect
                placeholder="Pick the agents to analyze"
                data={agentOptions}
                value={agentKeys}
                onChange={setAgentKeys}
                searchable
                clearable
                hidePickedOptions
                nothingFoundMessage="No agents"
              />
            </FormField>
            <FormRow cols={3}>
              <FormField label="Skip sessions shorter than" hint="messages">
                <NumberInput min={1} max={1000} allowDecimal={false} value={minMessages} onChange={(v) => setMinMessages(Number(v) || 2)} />
              </FormField>
              <FormField label="Wait until idle for" hint="minutes">
                <NumberInput min={0} max={10080} allowDecimal={false} value={idleMinutes} onChange={(v) => setIdleMinutes(v === '' ? 30 : Number(v))} />
              </FormField>
              <FormField label="Look back" hint="days">
                <NumberInput min={1} max={365} allowDecimal={false} value={lookBackDays} onChange={(v) => setLookBackDays(Number(v) || 7)} />
              </FormField>
            </FormRow>
            <Text size="xs" c="dimmed">Sessions are read in place; nothing is copied.</Text>
          </>
        )}
      </FormSection>

      <FormSection number={3} title="Fields" done={validFields}>
        <Stack gap="sm">
          {fields.map((f, idx) => (
            <Stack key={idx} gap={4}>
              <Group align="flex-end" gap="xs" wrap="nowrap">
                <TextInput label={idx === 0 ? 'Key' : undefined} placeholder="intent" style={{ flex: 1 }} value={f.key} onChange={(e) => updateField(idx, { key: e.currentTarget.value })} />
                <Select label={idx === 0 ? 'Type' : undefined} data={TYPE_OPTIONS} w={130} allowDeselect={false} value={f.type} onChange={(v) => updateField(idx, { type: (v as AnalysisFieldType) ?? 'string' })} />
                {(f.type === 'enum' || f.type === 'score') && (
                  <TextInput
                    label={idx === 0 ? (f.type === 'score' ? 'Levels, lowest first (comma-separated)' : 'Values (comma-separated)') : undefined}
                    placeholder={f.type === 'score' ? 'poor, ok, good' : 'billing, support'}
                    style={{ flex: 1 }}
                    value={f.values}
                    onChange={(e) => updateField(idx, { values: e.currentTarget.value })}
                  />
                )}
                <Checkbox label="Req" checked={f.required} onChange={(e) => updateField(idx, { required: e.currentTarget.checked })} mb={6} />
                <ActionIcon variant="subtle" color="red" mb={4} disabled={fields.length === 1} onClick={() => setFields((prev) => prev.filter((_, i) => i !== idx))}>
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
              <TextInput size="xs" placeholder="What should the model look for? (optional)" value={f.description} onChange={(e) => updateField(idx, { description: e.currentTarget.value })} />
            </Stack>
          ))}
          <Button variant="light" size="xs" leftSection={<IconPlus size={14} />} onClick={() => setFields((prev) => [...prev, emptyField()])} style={{ alignSelf: 'flex-start' }}>
            Add field
          </Button>
          {hasDecisionModel && decisionQuestionCount > 0 && (
            <Text size="xs" c={decisionQuestionCount > MAX_COMFORTABLE_QUESTIONS ? 'orange' : 'dimmed'}>
              {decisionQuestionCount} question{decisionQuestionCount === 1 ? '' : 's'} go to the decision model (one call per conversation)
              {decisionQuestionCount > MAX_COMFORTABLE_QUESTIONS ? ` — more than ${MAX_COMFORTABLE_QUESTIONS} in one call can lower answer quality.` : ''}
            </Text>
          )}
        </Stack>
      </FormSection>

      <FormSection number={4} title="Models" done={validModel}>
        <FormField label="Decision model" optional hint="Yes / No, Choice and Score fields are answered by the decision model with probabilities.">
          <Select
            placeholder="None — answer every field with the extraction model"
            data={decisionModelOptions}
            searchable
            clearable
            value={decisionModelKey || null}
            onChange={(v) => pickDecisionModel(v ?? '')}
            nothingFoundMessage="No decision models"
          />
        </FormField>
        {hasDecisionModel && selfReported && (
          <Text size="xs" c="dimmed">Confidence is the model&apos;s own estimate; review a sample before trusting it.</Text>
        )}
        {hasDecisionModel && (
          <FormRow cols={2}>
            <FormField label="Flag answers below confidence" hint="Flagged answers go to the review queue.">
              <NumberInput
                min={0}
                max={1}
                step={0.05}
                decimalScale={2}
                value={threshold}
                onChange={(v) => { setThreshold(v === '' ? DEFAULT_THRESHOLD : Number(v)); setThresholdEdited(true); }}
              />
            </FormField>
            <FormField label="Spot-check confident answers" hint="% of confident answers also sent to review.">
              <NumberInput min={0} max={100} value={spotCheckPct} onChange={(v) => setSpotCheckPct(v === '' ? 0 : Number(v))} suffix="%" />
            </FormField>
          </FormRow>
        )}
        <FormField label="Extraction instructions" optional>
          <Textarea placeholder="Extra guidance for the extractor (optional)" autosize minRows={1} value={instructions} onChange={(e) => setInstructions(e.currentTarget.value)} />
        </FormField>
        <FormField
          label="Extraction model"
          required={needsExtractionModel}
          optional={!needsExtractionModel}
          hint={!needsExtractionModel ? 'Only Text and Number fields use it.' : undefined}
        >
          <Select placeholder="Select a model…" data={models} searchable clearable={!needsExtractionModel} value={extractionModelKey || null} onChange={(v) => setExtractionModelKey(v ?? '')} />
        </FormField>
      </FormSection>

      <FormSection number={5} title="Modes" done={validJudge}>
        <Stack gap="xs">
          <Checkbox label="Store — write extracted fields back onto each conversation" checked={modeStore} onChange={(e) => setModeStore(e.currentTarget.checked)} />
          <Checkbox label="Accuracy — compare extracted fields against each conversation's reference fields" checked={modeAccuracy} onChange={(e) => setModeAccuracy(e.currentTarget.checked)} />
          <Checkbox label="Judge — grade conversation quality against a rubric" checked={modeJudge} onChange={(e) => setModeJudge(e.currentTarget.checked)} />
        </Stack>
        {modeJudge && (
          <>
            <FormField label="Judge rubric" required>
              <Textarea placeholder="What does a good conversation look like?" autosize minRows={2} value={judgeRubric} onChange={(e) => setJudgeRubric(e.currentTarget.value)} />
            </FormField>
            <FormField label="Judge model" required>
              <Select placeholder="Select a model…" data={models} searchable value={judgeModelKey} onChange={(v) => setJudgeModelKey(v ?? '')} />
            </FormField>
          </>
        )}
      </FormSection>

      <FormSection number={6} title="Schedule">
        <Checkbox label="Run automatically on a schedule" checked={scheduleEnabled} onChange={(e) => setScheduleEnabled(e.currentTarget.checked)} />
        {scheduleEnabled && (
          <FormField label="Cron expression (UTC)" hint="Standard 5-field cron, evaluated in UTC. Example: 0 2 * * * runs at 02:00 every day.">
            <TextInput placeholder="0 2 * * *" value={scheduleCron} onChange={(e) => setScheduleCron(e.currentTarget.value)} />
          </FormField>
        )}
        {scheduleEnabled && sourceKind === 'agent_sessions' && (
          <Text size="xs" c="dimmed">Scheduled runs analyze sessions that are new or changed.</Text>
        )}
        {error && <Alert color="red" variant="light" mt="sm">{error}</Alert>}
      </FormSection>
    </FormShell>
  );
}
