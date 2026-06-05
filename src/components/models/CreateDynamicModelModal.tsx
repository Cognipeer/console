import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Button,
  NumberInput,
  SegmentedControl,
  Select,
  TextInput,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowsSplit, IconPlus, IconRoute, IconTrash } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type {
  DynamicRoutingOperator,
  DynamicRoutingSignal,
  DynamicRoutingStrategy,
  IDynamicRoutingConfig,
} from '@/lib/database';

/** A model that can be picked as a routing target / default / fallback / decider. */
export interface CandidateModel {
  key: string;
  name: string;
}

interface ConditionDraft {
  signal: DynamicRoutingSignal;
  operator: DynamicRoutingOperator;
  value: string;
}

interface RuleDraft {
  label: string;
  targetModelKey: string;
  matchType: 'all' | 'any';
  conditions: ConditionDraft[];
}

interface LabelDraft {
  label: string;
  description: string;
  targetModelKey: string;
}

export interface DynamicModelInit {
  _id: string;
  name: string;
  description?: string;
  key: string;
  dynamic: IDynamicRoutingConfig;
}

type SignalKind = 'number' | 'boolean' | 'text';

const SIGNALS: ReadonlyArray<{ value: DynamicRoutingSignal; label: string; kind: SignalKind }> = [
  { value: 'inputTokensEst', label: 'Estimated input tokens', kind: 'number' },
  { value: 'messageCount', label: 'Message count', kind: 'number' },
  { value: 'lastUserLength', label: 'Last user message length', kind: 'number' },
  { value: 'hasTools', label: 'Request uses tools', kind: 'boolean' },
  { value: 'hasResponseFormat', label: 'Structured output requested', kind: 'boolean' },
  { value: 'hasImages', label: 'Request has images', kind: 'boolean' },
  { value: 'keyword', label: 'Keyword in last user message', kind: 'text' },
];

const OPERATORS: Record<SignalKind, Array<{ value: DynamicRoutingOperator; label: string }>> = {
  number: [
    { value: 'gt', label: '> greater than' },
    { value: 'gte', label: '≥ at least' },
    { value: 'lt', label: '< less than' },
    { value: 'lte', label: '≤ at most' },
    { value: 'eq', label: '= equals' },
    { value: 'neq', label: '≠ not equals' },
  ],
  boolean: [
    { value: 'isTrue', label: 'is true' },
    { value: 'isFalse', label: 'is false' },
  ],
  text: [
    { value: 'contains', label: 'contains' },
    { value: 'matches', label: 'matches (regex)' },
  ],
};

function signalKind(signal: DynamicRoutingSignal): SignalKind {
  return SIGNALS.find((s) => s.value === signal)?.kind ?? 'number';
}

function newCondition(): ConditionDraft {
  return { signal: 'inputTokensEst', operator: 'gt', value: '' };
}

function newRule(): RuleDraft {
  return { label: '', targetModelKey: '', matchType: 'all', conditions: [newCondition()] };
}

function newLabel(): LabelDraft {
  return { label: '', description: '', targetModelKey: '' };
}

type Props = {
  opened: boolean;
  onClose: () => void;
  /** LLM models available as routing targets (routers themselves excluded). */
  candidates: CandidateModel[];
  /** When set, the modal edits this Dynamic LLM instead of creating one. */
  editModel?: DynamicModelInit | null;
  onSaved: () => void;
};

export default function CreateDynamicModelModal({
  opened,
  onClose,
  candidates,
  editModel,
  onSaved,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [strategy, setStrategy] = useState<DynamicRoutingStrategy>('rule-based');
  const [defaultModelKey, setDefaultModelKey] = useState('');
  const [fallbackModelKey, setFallbackModelKey] = useState<string | null>(null);
  const [rules, setRules] = useState<RuleDraft[]>([newRule()]);
  const [deciderModelKey, setDeciderModelKey] = useState('');
  const [promptOverride, setPromptOverride] = useState('');
  const [labels, setLabels] = useState<LabelDraft[]>([newLabel(), newLabel()]);

  const isEdit = Boolean(editModel);

  // Hydrate the form whenever the modal opens (fresh create or edit target).
  useEffect(() => {
    if (!opened) return;
    if (editModel) {
      const d = editModel.dynamic;
      setName(editModel.name);
      setKey(editModel.key);
      setDescription(editModel.description ?? '');
      setStrategy(d.strategy);
      setDefaultModelKey(d.defaultModelKey ?? '');
      setFallbackModelKey(d.fallbackModelKey ?? null);
      setRules(
        d.rules && d.rules.length > 0
          ? d.rules.map((r) => ({
              label: r.label ?? '',
              targetModelKey: r.targetModelKey ?? '',
              matchType: r.matchType ?? 'all',
              conditions:
                r.conditions && r.conditions.length > 0
                  ? r.conditions.map((c) => ({
                      signal: c.signal,
                      operator: c.operator,
                      value: c.value === undefined ? '' : String(c.value),
                    }))
                  : [newCondition()],
            }))
          : [newRule()],
      );
      setDeciderModelKey(d.decider?.modelKey ?? '');
      setPromptOverride(d.decider?.promptOverride ?? '');
      setLabels(
        d.decider?.labels && d.decider.labels.length > 0
          ? d.decider.labels.map((l) => ({
              label: l.label,
              description: l.description ?? '',
              targetModelKey: l.targetModelKey ?? '',
            }))
          : [newLabel(), newLabel()],
      );
    } else {
      setName('');
      setKey('');
      setDescription('');
      setStrategy('rule-based');
      setDefaultModelKey('');
      setFallbackModelKey(null);
      setRules([newRule()]);
      setDeciderModelKey('');
      setPromptOverride('');
      setLabels([newLabel(), newLabel()]);
    }
  }, [opened, editModel]);

  const modelOptions = useMemo(
    () => candidates.map((m) => ({ value: m.key, label: `${m.name} · ${m.key}` })),
    [candidates],
  );

  const validIdentity = Boolean(name.trim());
  const validDefault = Boolean(defaultModelKey);
  const validStrategy =
    strategy === 'rule-based'
      ? rules.length > 0 &&
        rules.every(
          (r) => r.targetModelKey && r.conditions.length > 0 && r.conditions.every((c) => isConditionValid(c)),
        )
      : Boolean(deciderModelKey) && labels.filter((l) => l.label && l.targetModelKey).length > 0;

  const canSubmit = validIdentity && validDefault && validStrategy && !submitting;

  const checklist = [
    { id: 1, label: 'Name set', done: validIdentity },
    { id: 2, label: 'Default model chosen', done: validDefault },
    {
      id: 3,
      label: strategy === 'rule-based' ? 'Rules configured' : 'Decider & labels configured',
      done: validStrategy,
    },
  ];

  const buildConfig = (): IDynamicRoutingConfig => {
    const base: IDynamicRoutingConfig = {
      strategy,
      defaultModelKey,
      ...(fallbackModelKey ? { fallbackModelKey } : {}),
    };
    if (strategy === 'rule-based') {
      base.rules = rules
        .filter((r) => r.targetModelKey && r.conditions.length > 0)
        .map((r) => ({
          label: r.label.trim() || 'rule',
          targetModelKey: r.targetModelKey,
          matchType: r.matchType,
          conditions: r.conditions.filter(isConditionValid).map((c) => ({
            signal: c.signal,
            operator: c.operator,
            value: coerceValue(c),
          })),
        }));
    } else {
      base.decider = {
        modelKey: deciderModelKey,
        ...(promptOverride.trim() ? { promptOverride: promptOverride.trim() } : {}),
        labels: labels
          .filter((l) => l.label && l.targetModelKey)
          .map((l) => ({
            label: l.label.trim(),
            description: l.description.trim(),
            targetModelKey: l.targetModelKey,
          })),
      };
    }
    return base;
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const dynamic = buildConfig();
      const payload = { name: name.trim(), key: key.trim() || undefined, description: description.trim(), dynamic };
      const url = isEdit ? `/api/models/${editModel!._id}` : '/api/models/dynamic';
      const method = isEdit ? 'PUT' : 'POST';
      const body = isEdit
        ? { name: payload.name, description: payload.description, settings: { dynamic } }
        : payload;

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to save dynamic model');
      }
      notifications.show({
        color: 'green',
        title: isEdit ? 'Dynamic LLM updated' : 'Dynamic LLM created',
        message: `${payload.name} is ready to route.`,
      });
      onSaved();
      onClose();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Unable to save dynamic model',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  // ── Rule editors ──────────────────────────────────────────────────────
  const updateRule = (index: number, patch: Partial<RuleDraft>) =>
    setRules((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const updateCondition = (ri: number, ci: number, patch: Partial<ConditionDraft>) =>
    setRules((rs) =>
      rs.map((r, i) =>
        i === ri
          ? { ...r, conditions: r.conditions.map((c, j) => (j === ci ? { ...c, ...patch } : c)) }
          : r,
      ),
    );
  const updateLabel = (index: number, patch: Partial<LabelDraft>) =>
    setLabels((ls) => ls.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const summary = (
    <>
      <SummaryGroup title="Dynamic LLM">
        <SummaryKV label="Name" value={name || <span className="ds-faint">—</span>} />
        <SummaryKV label="Strategy" value={strategy} />
        <SummaryKV
          label="Default"
          value={defaultModelKey || <span className="ds-faint">—</span>}
          mono
        />
        <SummaryKV
          label="Fallback"
          value={fallbackModelKey || <span className="ds-faint">none</span>}
          mono
        />
      </SummaryGroup>
      <SummaryGroup title={strategy === 'rule-based' ? 'Rules' : 'Decider'}>
        {strategy === 'rule-based' ? (
          <SummaryKV label="Rule count" value={String(rules.length)} />
        ) : (
          <>
            <SummaryKV label="Decider" value={deciderModelKey || '—'} mono />
            <SummaryKV label="Labels" value={String(labels.filter((l) => l.label).length)} />
          </>
        )}
      </SummaryGroup>
      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const noCandidates = candidates.length === 0;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconArrowsSplit size={16} />}
      title={isEdit ? 'Edit Dynamic LLM' : 'Create Dynamic LLM'}
      subtitle="Route each request to a different model by rules or by a decider model."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Create Dynamic LLM',
        icon: <IconRoute size={13} />,
        loading: submitting,
        disabled: !canSubmit,
        onClick: submit,
      }}
    >
      {noCandidates ? (
        <div className="ds-card ds-card-pad" style={{ background: 'var(--ds-surface-1)' }}>
          <span className="ds-muted" style={{ fontSize: 13 }}>
            No LLM models found in this project. Create at least two regular LLM models first —
            a Dynamic LLM routes between existing models.
          </span>
        </div>
      ) : null}

      <FormSection number={1} title="Identity" description="How this router is identified." done={validIdentity}>
        <FormRow cols={2}>
          <FormField label="Display name" required>
            <TextInput
              placeholder="e.g. Smart router"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </FormField>
          <FormField label="Key" hint={isEdit ? 'Key is immutable after creation.' : 'Leave blank to auto-generate.'}>
            <TextInput
              placeholder="optional-key"
              value={key}
              disabled={isEdit}
              onChange={(e) => setKey(e.currentTarget.value)}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              autosize
              minRows={2}
              placeholder="Optional description"
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={2} title="Strategy" description="How the target model is chosen for each request." done>
        <ChipPicker<DynamicRoutingStrategy>
          options={[
            { value: 'rule-based', label: 'Rule-based' },
            { value: 'model-based', label: 'Model-based (decider)' },
          ]}
          value={strategy}
          onChange={(v) => setStrategy(v as DynamicRoutingStrategy)}
        />
        <div className="ds-muted" style={{ fontSize: 12, marginTop: 8 }}>
          {strategy === 'rule-based'
            ? 'Evaluate ordered rules against request signals (token size, tools, keywords…). First match wins.'
            : 'A decider model classifies each request into one of your labels, then routes to that label’s model.'}
        </div>
      </FormSection>

      <FormSection
        number={3}
        title="Default & fallback"
        description="Default runs when nothing matches; fallback runs when the chosen model errors."
        done={validDefault}
      >
        <FormRow cols={2}>
          <FormField label="Default model" required>
            <Select
              placeholder="Select default model"
              data={modelOptions}
              value={defaultModelKey || null}
              onChange={(v) => setDefaultModelKey(v ?? '')}
              searchable
            />
          </FormField>
          <FormField label="Fallback model" optional>
            <Select
              placeholder="None"
              data={modelOptions}
              value={fallbackModelKey}
              onChange={setFallbackModelKey}
              clearable
              searchable
            />
          </FormField>
        </FormRow>
      </FormSection>

      {strategy === 'rule-based' ? (
        <FormSection number={4} title="Rules" description="First matching rule decides the target model." done={validStrategy}>
          <div className="ds-col ds-gap-md">
            {rules.map((rule, ri) => (
              <div
                key={ri}
                className="ds-card ds-card-pad-sm"
                style={{ background: 'var(--ds-surface-1)' }}
              >
                <div className="ds-row-between" style={{ marginBottom: 10 }}>
                  <span className="ds-eyebrow">Rule {ri + 1}</span>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    disabled={rules.length <= 1}
                    onClick={() => setRules((rs) => rs.filter((_, i) => i !== ri))}
                    aria-label="Remove rule"
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </div>
                <FormRow cols={2}>
                  <FormField label="Label">
                    <TextInput
                      placeholder="e.g. complex"
                      value={rule.label}
                      onChange={(e) => updateRule(ri, { label: e.currentTarget.value })}
                    />
                  </FormField>
                  <FormField label="Route to" required>
                    <Select
                      placeholder="Target model"
                      data={modelOptions}
                      value={rule.targetModelKey || null}
                      onChange={(v) => updateRule(ri, { targetModelKey: v ?? '' })}
                      searchable
                    />
                  </FormField>
                </FormRow>
                <FormField label="Match">
                  <SegmentedControl
                    size="xs"
                    data={[
                      { value: 'all', label: 'All conditions' },
                      { value: 'any', label: 'Any condition' },
                    ]}
                    value={rule.matchType}
                    onChange={(v) => updateRule(ri, { matchType: v as 'all' | 'any' })}
                  />
                </FormField>

                <div className="ds-col ds-gap-sm" style={{ marginTop: 8 }}>
                  {rule.conditions.map((cond, ci) => {
                    const kind = signalKind(cond.signal);
                    return (
                      <div key={ci} className="ds-row ds-gap-xs" style={{ alignItems: 'flex-end' }}>
                        <div style={{ flex: 2 }}>
                          <Select
                            size="xs"
                            data={SIGNALS.map((s) => ({ value: s.value, label: s.label }))}
                            value={cond.signal}
                            onChange={(v) => {
                              const nextSignal = (v ?? 'inputTokensEst') as DynamicRoutingSignal;
                              const nextKind = signalKind(nextSignal);
                              updateCondition(ri, ci, {
                                signal: nextSignal,
                                operator: OPERATORS[nextKind][0].value,
                                value: '',
                              });
                            }}
                          />
                        </div>
                        <div style={{ flex: 1.4 }}>
                          <Select
                            size="xs"
                            data={OPERATORS[kind]}
                            value={cond.operator}
                            onChange={(v) =>
                              updateCondition(ri, ci, { operator: (v ?? OPERATORS[kind][0].value) as DynamicRoutingOperator })
                            }
                          />
                        </div>
                        <div style={{ flex: 1.4 }}>
                          {kind === 'number' ? (
                            <NumberInput
                              size="xs"
                              min={0}
                              placeholder="value"
                              value={cond.value === '' ? '' : Number(cond.value)}
                              onChange={(v) => updateCondition(ri, ci, { value: v === '' ? '' : String(v) })}
                            />
                          ) : kind === 'text' ? (
                            <TextInput
                              size="xs"
                              placeholder="keyword / regex"
                              value={cond.value}
                              onChange={(e) => updateCondition(ri, ci, { value: e.currentTarget.value })}
                            />
                          ) : (
                            <TextInput size="xs" value="—" disabled />
                          )}
                        </div>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          size="sm"
                          disabled={rule.conditions.length <= 1}
                          onClick={() =>
                            updateRule(ri, { conditions: rule.conditions.filter((_, j) => j !== ci) })
                          }
                          aria-label="Remove condition"
                        >
                          <IconTrash size={13} />
                        </ActionIcon>
                      </div>
                    );
                  })}
                  <Button
                    variant="subtle"
                    size="xs"
                    leftSection={<IconPlus size={12} />}
                    onClick={() => updateRule(ri, { conditions: [...rule.conditions, newCondition()] })}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    Add condition
                  </Button>
                </div>
              </div>
            ))}
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPlus size={13} />}
              onClick={() => setRules((rs) => [...rs, newRule()])}
              style={{ alignSelf: 'flex-start' }}
            >
              Add rule
            </Button>
          </div>
        </FormSection>
      ) : (
        <FormSection
          number={4}
          title="Decider"
          description="A model classifies each request into one label; the label decides the target."
          done={validStrategy}
        >
          <FormRow cols={1}>
            <FormField label="Decider model" required>
              <Select
                placeholder="Select classifier model"
                data={modelOptions}
                value={deciderModelKey || null}
                onChange={(v) => setDeciderModelKey(v ?? '')}
                searchable
              />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label="Prompt override" optional hint="Override the default classification system prompt.">
              <Textarea
                autosize
                minRows={2}
                placeholder="Leave blank to use the built-in classifier prompt."
                value={promptOverride}
                onChange={(e) => setPromptOverride(e.currentTarget.value)}
              />
            </FormField>
          </FormRow>

          <div className="ds-col ds-gap-sm" style={{ marginTop: 4 }}>
            {labels.map((label, li) => (
              <div key={li} className="ds-card ds-card-pad-sm" style={{ background: 'var(--ds-surface-1)' }}>
                <div className="ds-row-between" style={{ marginBottom: 8 }}>
                  <span className="ds-eyebrow">Label {li + 1}</span>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    disabled={labels.length <= 1}
                    onClick={() => setLabels((ls) => ls.filter((_, i) => i !== li))}
                    aria-label="Remove label"
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </div>
                <FormRow cols={2}>
                  <FormField label="Label" required>
                    <TextInput
                      placeholder="e.g. simple"
                      value={label.label}
                      onChange={(e) => updateLabel(li, { label: e.currentTarget.value })}
                    />
                  </FormField>
                  <FormField label="Route to" required>
                    <Select
                      placeholder="Target model"
                      data={modelOptions}
                      value={label.targetModelKey || null}
                      onChange={(v) => updateLabel(li, { targetModelKey: v ?? '' })}
                      searchable
                    />
                  </FormField>
                </FormRow>
                <FormField label="Description" hint="Helps the decider tell labels apart.">
                  <TextInput
                    placeholder="When does this label apply?"
                    value={label.description}
                    onChange={(e) => updateLabel(li, { description: e.currentTarget.value })}
                  />
                </FormField>
              </div>
            ))}
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPlus size={13} />}
              onClick={() => setLabels((ls) => [...ls, newLabel()])}
              style={{ alignSelf: 'flex-start' }}
            >
              Add label
            </Button>
          </div>
        </FormSection>
      )}
    </FormShell>
  );
}

function isConditionValid(c: ConditionDraft): boolean {
  const kind = signalKind(c.signal);
  if (kind === 'boolean') return c.operator === 'isTrue' || c.operator === 'isFalse';
  return c.value !== '' && c.value !== undefined && c.value !== null;
}

function coerceValue(c: ConditionDraft): string | number | boolean | undefined {
  const kind = signalKind(c.signal);
  if (kind === 'number') return Number(c.value);
  if (kind === 'boolean') return undefined;
  return c.value;
}
