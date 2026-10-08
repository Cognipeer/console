import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Button,
  NumberInput,
  SegmentedControl,
  Select,
  Switch,
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
  DynamicPoolPolicy,
  DynamicRoutingOperator,
  DynamicRoutingSignal,
  DynamicRoutingStrategy,
  IDynamicRoutingConfig,
  IDynamicRoutingGuards,
  IDynamicRoutingTarget,
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

/** A route's destination: one model, or a pool of candidates + a selection policy. */
interface TargetDraft {
  kind: 'model' | 'pool';
  modelKey: string;
  pool: Array<{ modelKey: string; tier: number | '' }>;
  policy: DynamicPoolPolicy;
}

interface RuleDraft {
  label: string;
  target: TargetDraft;
  matchType: 'all' | 'any';
  conditions: ConditionDraft[];
}

interface LabelDraft {
  label: string;
  description: string;
  target: TargetDraft;
}

const POLICIES: ReadonlyArray<{ value: DynamicPoolPolicy; label: string; hint: string }> = [
  {
    value: 'best-under-cap',
    label: 'Best under cost cap',
    hint: 'Highest-tier candidate whose estimated cost fits the per-request cap (Cost guards). Without a cap: highest tier.',
  },
  {
    value: 'cheapest',
    label: 'Cheapest',
    hint: 'Lowest estimated cost. Use for equivalent models, e.g. the same model on several providers or regions.',
  },
  {
    value: 'token-profile',
    label: 'Token profile (input/output aware)',
    hint: 'Lowest expected cost from the predicted output/input ratio, each model’s verbosity and prompt-cache stickiness.',
  },
];

function newTarget(modelKey = ''): TargetDraft {
  return { kind: 'model', modelKey, pool: [{ modelKey: '', tier: 1 }, { modelKey: '', tier: 2 }], policy: 'best-under-cap' };
}

function targetFromConfig(spec: { target?: IDynamicRoutingTarget; targetModelKey?: string }): TargetDraft {
  const pool = spec.target?.pool;
  if (pool && pool.length > 0) {
    return {
      kind: 'pool',
      modelKey: '',
      pool: pool.map((c) => ({ modelKey: c.modelKey, tier: c.tier ?? 1 })),
      policy: spec.target?.policy ?? 'best-under-cap',
    };
  }
  return newTarget(spec.target?.modelKey ?? spec.targetModelKey ?? '');
}

function poolCandidates(draft: TargetDraft) {
  return draft.pool
    .filter((c) => c.modelKey)
    .map((c) => ({ modelKey: c.modelKey, ...(c.tier === '' ? {} : { tier: Number(c.tier) }) }));
}

function isTargetValid(draft: TargetDraft): boolean {
  return draft.kind === 'model' ? Boolean(draft.modelKey) : poolCandidates(draft).length > 0;
}

/** Serialized form: the legacy `targetModelKey` shorthand for a single model. */
function targetToConfig(draft: TargetDraft): { targetModelKey?: string; target?: IDynamicRoutingTarget } {
  if (draft.kind === 'model') return { targetModelKey: draft.modelKey };
  return { target: { pool: poolCandidates(draft), policy: draft.policy } };
}

function describeDraft(draft: TargetDraft): string {
  if (draft.kind === 'model') return draft.modelKey || '—';
  return `${draft.policy} · ${poolCandidates(draft).length} models`;
}

const numberOrUndefined = (value: number | '') => (value === '' ? undefined : Number(value));

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
  { value: 'estimatedCostUsd', label: 'Estimated cost in USD (at default model pricing)', kind: 'number' },
  { value: 'conversationCostUsd', label: 'Conversation spend so far (USD)', kind: 'number' },
  { value: 'budgetUsedPct', label: 'Budget used (% of Cost guards budget)', kind: 'number' },
  { value: 'predictedOutputTokens', label: 'Predicted output tokens (from history)', kind: 'number' },
  { value: 'ioRatio', label: 'Predicted output / input ratio', kind: 'number' },
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
  return { label: '', target: newTarget(), matchType: 'all', conditions: [newCondition()] };
}

function newLabel(): LabelDraft {
  return { label: '', description: '', target: newTarget() };
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
  // Default pool (optional): replaces the default model when nothing matches.
  const [useDefaultPool, setUseDefaultPool] = useState(false);
  const [defaultPool, setDefaultPool] = useState<TargetDraft>({ ...newTarget(), kind: 'pool' });
  // Cost guards.
  const [maxCostPerRequest, setMaxCostPerRequest] = useState<number | ''>('');
  const [conversationBudget, setConversationBudget] = useState<number | ''>('');
  const [budgetLimit, setBudgetLimit] = useState<number | ''>('');
  const [budgetWindow, setBudgetWindow] = useState<number | ''>(24);
  const [budgetDowngradeAt, setBudgetDowngradeAt] = useState<number | ''>(80);
  const [budgetOnExceeded, setBudgetOnExceeded] = useState<'cheapest' | 'reject'>('cheapest');
  const [economyModelKey, setEconomyModelKey] = useState<string | null>(null);
  const [sticky, setSticky] = useState(true);
  const [switchMargin, setSwitchMargin] = useState<number | ''>(15);
  // Measurement + rollout.
  const [baselineModelKey, setBaselineModelKey] = useState<string | null>(null);
  const [defaultOutputTokens, setDefaultOutputTokens] = useState<number | ''>('');
  const [mode, setMode] = useState<'enforce' | 'shadow'>('enforce');
  const [canaryPercent, setCanaryPercent] = useState<number | ''>(100);

  const isEdit = Boolean(editModel);
  // Bumped on every hydration so collapsible sections re-read `defaultOpen`
  // from the loaded config instead of the pre-hydration blank form.
  const [hydration, setHydration] = useState(0);

  // Hydrate the form whenever the modal opens (fresh create or edit target).
  useEffect(() => {
    if (!opened) return;
    setHydration((n) => n + 1);
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
              target: targetFromConfig(r),
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
              target: targetFromConfig(l),
            }))
          : [newLabel(), newLabel()],
      );
      setUseDefaultPool(Boolean(d.defaultTarget?.pool?.length));
      setDefaultPool(d.defaultTarget?.pool?.length ? targetFromConfig({ target: d.defaultTarget }) : { ...newTarget(), kind: 'pool' });
      const g = d.guards ?? {};
      setMaxCostPerRequest(g.maxCostPerRequestUsd ?? '');
      setConversationBudget(g.conversationBudgetUsd ?? '');
      setBudgetLimit(g.budget?.limitUsd ?? '');
      setBudgetWindow(g.budget?.windowHours ?? 24);
      setBudgetDowngradeAt(g.budget?.downgradeAtPct ?? 80);
      setBudgetOnExceeded(g.budget?.onExceeded ?? 'cheapest');
      setEconomyModelKey(g.economyModelKey ?? null);
      setSticky(g.sticky ?? true);
      setSwitchMargin(g.switchMarginPct ?? 15);
      setBaselineModelKey(d.baselineModelKey ?? null);
      setDefaultOutputTokens(d.defaultOutputTokens ?? '');
      setMode(d.mode ?? 'enforce');
      setCanaryPercent(d.canaryPercent ?? 100);
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
      setUseDefaultPool(false);
      setDefaultPool({ ...newTarget(), kind: 'pool' });
      setMaxCostPerRequest('');
      setConversationBudget('');
      setBudgetLimit('');
      setBudgetWindow(24);
      setBudgetDowngradeAt(80);
      setBudgetOnExceeded('cheapest');
      setEconomyModelKey(null);
      setSticky(true);
      setSwitchMargin(15);
      setBaselineModelKey(null);
      setDefaultOutputTokens('');
      setMode('enforce');
      setCanaryPercent(100);
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
          (r) => isTargetValid(r.target) && r.conditions.length > 0 && r.conditions.every((c) => isConditionValid(c)),
        )
      : Boolean(deciderModelKey) && labels.filter((l) => l.label && isTargetValid(l.target)).length > 0;
  const validDefaultPool = !useDefaultPool || isTargetValid(defaultPool);

  const canSubmit = validIdentity && validDefault && validDefaultPool && validStrategy && !submitting;

  const checklist = [
    { id: 1, label: 'Name set', done: validIdentity },
    { id: 2, label: 'Default model chosen', done: validDefault && validDefaultPool },
    {
      id: 3,
      label: strategy === 'rule-based' ? 'Rules configured' : 'Decider & labels configured',
      done: validStrategy,
    },
  ];

  const buildGuards = (): IDynamicRoutingGuards | undefined => {
    const guards: IDynamicRoutingGuards = {};
    if (maxCostPerRequest !== '') guards.maxCostPerRequestUsd = Number(maxCostPerRequest);
    if (conversationBudget !== '') guards.conversationBudgetUsd = Number(conversationBudget);
    if (budgetLimit !== '' && Number(budgetLimit) > 0) {
      guards.budget = {
        limitUsd: Number(budgetLimit),
        windowHours: numberOrUndefined(budgetWindow) ?? 24,
        downgradeAtPct: numberOrUndefined(budgetDowngradeAt) ?? 80,
        onExceeded: budgetOnExceeded,
      };
    }
    if (economyModelKey) guards.economyModelKey = economyModelKey;
    if (!sticky) guards.sticky = false;
    if (switchMargin !== '' && Number(switchMargin) !== 15) guards.switchMarginPct = Number(switchMargin);
    return Object.keys(guards).length > 0 ? guards : undefined;
  };

  const buildConfig = (): IDynamicRoutingConfig => {
    const guards = buildGuards();
    const base: IDynamicRoutingConfig = {
      strategy,
      defaultModelKey,
      ...(fallbackModelKey ? { fallbackModelKey } : {}),
      ...(useDefaultPool && isTargetValid(defaultPool)
        ? { defaultTarget: targetToConfig({ ...defaultPool, kind: 'pool' }).target }
        : {}),
      ...(guards ? { guards } : {}),
      ...(baselineModelKey ? { baselineModelKey } : {}),
      ...(defaultOutputTokens !== '' ? { defaultOutputTokens: Number(defaultOutputTokens) } : {}),
      ...(mode === 'shadow' ? { mode } : {}),
      ...(mode === 'enforce' && canaryPercent !== '' && Number(canaryPercent) < 100
        ? { canaryPercent: Number(canaryPercent) }
        : {}),
    };
    if (strategy === 'rule-based') {
      base.rules = rules
        .filter((r) => isTargetValid(r.target) && r.conditions.length > 0)
        .map((r) => ({
          label: r.label.trim() || 'rule',
          ...targetToConfig(r.target),
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
          .filter((l) => l.label && isTargetValid(l.target))
          .map((l) => ({
            label: l.label.trim(),
            description: l.description.trim(),
            ...targetToConfig(l.target),
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
        {useDefaultPool ? <SummaryKV label="Default pool" value={describeDraft(defaultPool)} /> : null}
        <SummaryKV
          label="Mode"
          value={mode === 'shadow' ? 'shadow' : canaryPercent !== '' && Number(canaryPercent) < 100 ? `canary ${canaryPercent}%` : 'enforce'}
        />
        <SummaryKV label="Cost guards" value={buildGuards() ? 'on' : <span className="ds-faint">none</span>} />
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
        <Switch
          size="xs"
          label="When nothing matches, pick from a pool instead of the default model"
          checked={useDefaultPool}
          onChange={(e) => setUseDefaultPool(e.currentTarget.checked)}
          style={{ marginTop: 8 }}
        />
        {useDefaultPool ? (
          <div style={{ marginTop: 8 }}>
            <TargetEditor value={defaultPool} onChange={setDefaultPool} modelOptions={modelOptions} poolOnly />
          </div>
        ) : null}
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
                <FormRow cols={1}>
                  <FormField label="Label">
                    <TextInput
                      placeholder="e.g. complex"
                      value={rule.label}
                      onChange={(e) => updateRule(ri, { label: e.currentTarget.value })}
                    />
                  </FormField>
                </FormRow>
                <FormField label="Route to" required>
                  <TargetEditor
                    value={rule.target}
                    onChange={(target) => updateRule(ri, { target })}
                    modelOptions={modelOptions}
                  />
                </FormField>
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
                <FormRow cols={1}>
                  <FormField label="Label" required>
                    <TextInput
                      placeholder="e.g. simple"
                      value={label.label}
                      onChange={(e) => updateLabel(li, { label: e.currentTarget.value })}
                    />
                  </FormField>
                </FormRow>
                <FormField label="Route to" required>
                  <TargetEditor
                    value={label.target}
                    onChange={(target) => updateLabel(li, { target })}
                    modelOptions={modelOptions}
                  />
                </FormField>
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

      <FormSection
        key={`guards-${hydration}`}
        number={5}
        title="Cost guards"
        description="Router-wide limits applied after a route is chosen. A guard only ever moves a request to a cheaper model."
        done
        collapsible
        defaultOpen={Boolean(buildGuards())}
      >
        <FormRow cols={2}>
          <FormField label="Max cost per request (USD)" optional hint="Pools pick the best model under it; fixed targets downgrade to the economy model above it.">
            <NumberInput min={0} decimalScale={6} placeholder="no cap" value={maxCostPerRequest} onChange={(v) => setMaxCostPerRequest(v === '' ? '' : Number(v))} />
          </FormField>
          <FormField label="Per-conversation budget (USD)" optional hint="Downgrade once a conversation has spent this much through the router (24h).">
            <NumberInput min={0} decimalScale={4} placeholder="no limit" value={conversationBudget} onChange={(v) => setConversationBudget(v === '' ? '' : Number(v))} />
          </FormField>
        </FormRow>
        <FormRow cols={3}>
          <FormField label="Budget (USD)" optional hint="Rolling spend limit for this router.">
            <NumberInput min={0} decimalScale={2} placeholder="no budget" value={budgetLimit} onChange={(v) => setBudgetLimit(v === '' ? '' : Number(v))} />
          </FormField>
          <FormField label="Window (hours)">
            <NumberInput min={1} max={168} value={budgetWindow} onChange={(v) => setBudgetWindow(v === '' ? '' : Number(v))} disabled={budgetLimit === ''} />
          </FormField>
          <FormField label="Downgrade at (%)">
            <NumberInput min={0} max={100} value={budgetDowngradeAt} onChange={(v) => setBudgetDowngradeAt(v === '' ? '' : Number(v))} disabled={budgetLimit === ''} />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField label="When the budget is exhausted">
            <SegmentedControl
              size="xs"
              data={[
                { value: 'cheapest', label: 'Keep serving, cheapest model' },
                { value: 'reject', label: 'Reject (429)' },
              ]}
              value={budgetOnExceeded}
              onChange={(v) => setBudgetOnExceeded(v as 'cheapest' | 'reject')}
              disabled={budgetLimit === ''}
            />
          </FormField>
          <FormField label="Economy model" optional hint="Where a single-model route downgrades when a guard trips.">
            <Select placeholder="None" data={modelOptions} value={economyModelKey} onChange={setEconomyModelKey} clearable searchable />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField label="Conversation stickiness" hint="Token-profile pools keep a conversation on its model so the prompt cache stays warm.">
            <Switch size="sm" checked={sticky} onChange={(e) => setSticky(e.currentTarget.checked)} label={sticky ? 'On' : 'Off'} />
          </FormField>
          <FormField label="Switch margin (%)" hint="Only leave the sticky model for at least this saving.">
            <NumberInput min={0} max={100} value={switchMargin} onChange={(v) => setSwitchMargin(v === '' ? '' : Number(v))} disabled={!sticky} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        key={`rollout-${hydration}`}
        number={6}
        title="Measurement & rollout"
        description="Savings are measured against a baseline model. Shadow mode logs what pools and guards would do without changing traffic."
        done
        collapsible
        defaultOpen={
          mode === 'shadow' ||
          Boolean(baselineModelKey) ||
          (canaryPercent !== '' && Number(canaryPercent) < 100) ||
          defaultOutputTokens !== ''
        }
      >
        <FormRow cols={2}>
          <FormField label="Baseline model" optional hint="What savings are measured against. Defaults to the default model.">
            <Select placeholder={defaultModelKey || 'Default model'} data={modelOptions} value={baselineModelKey} onChange={setBaselineModelKey} clearable searchable />
          </FormField>
          <FormField label="Assumed output tokens" optional hint="Used for estimates when neither max_tokens nor history is available (512).">
            <NumberInput min={1} max={200000} placeholder="512" value={defaultOutputTokens} onChange={(v) => setDefaultOutputTokens(v === '' ? '' : Number(v))} />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField label="Mode">
            <SegmentedControl
              size="xs"
              data={[
                { value: 'enforce', label: 'Enforce' },
                { value: 'shadow', label: 'Shadow (log only)' },
              ]}
              value={mode}
              onChange={(v) => setMode(v as 'enforce' | 'shadow')}
            />
          </FormField>
          <FormField label="Canary (% of conversations)" hint="The rest run in shadow. A conversation always stays on the same side.">
            <NumberInput min={0} max={100} value={canaryPercent} onChange={(v) => setCanaryPercent(v === '' ? '' : Number(v))} disabled={mode === 'shadow'} />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}

function TargetEditor({
  value,
  onChange,
  modelOptions,
  poolOnly = false,
}: {
  value: TargetDraft;
  onChange: (next: TargetDraft) => void;
  modelOptions: Array<{ value: string; label: string }>;
  poolOnly?: boolean;
}) {
  const kind = poolOnly ? 'pool' : value.kind;
  const updateCandidate = (index: number, patch: Partial<TargetDraft['pool'][number]>) =>
    onChange({ ...value, pool: value.pool.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  return (
    <div className="ds-col ds-gap-xs">
      {poolOnly ? null : (
        <SegmentedControl
          size="xs"
          data={[
            { value: 'model', label: 'Single model' },
            { value: 'pool', label: 'Pool (cost-aware)' },
          ]}
          value={kind}
          onChange={(v) => onChange({ ...value, kind: v as TargetDraft['kind'] })}
          style={{ alignSelf: 'flex-start' }}
        />
      )}
      {kind === 'model' ? (
        <Select
          placeholder="Target model"
          data={modelOptions}
          value={value.modelKey || null}
          onChange={(v) => onChange({ ...value, modelKey: v ?? '' })}
          searchable
        />
      ) : (
        <>
          <Select
            size="xs"
            data={POLICIES.map((p) => ({ value: p.value, label: p.label }))}
            value={value.policy}
            onChange={(v) => onChange({ ...value, policy: (v ?? 'best-under-cap') as DynamicPoolPolicy })}
          />
          <div className="ds-faint" style={{ fontSize: 11.5 }}>
            {POLICIES.find((p) => p.value === value.policy)?.hint}
          </div>
          {value.pool.map((candidate, ci) => (
            <div key={ci} className="ds-row ds-gap-xs" style={{ alignItems: 'flex-end' }}>
              <div style={{ flex: 3 }}>
                <Select
                  size="xs"
                  placeholder="Candidate model"
                  data={modelOptions}
                  value={candidate.modelKey || null}
                  onChange={(v) => updateCandidate(ci, { modelKey: v ?? '' })}
                  searchable
                />
              </div>
              <div style={{ flex: 1 }}>
                <NumberInput
                  size="xs"
                  min={0}
                  max={100}
                  placeholder="tier"
                  aria-label="Quality tier"
                  value={candidate.tier}
                  onChange={(v) => updateCandidate(ci, { tier: v === '' ? '' : Number(v) })}
                />
              </div>
              <ActionIcon
                variant="subtle"
                color="red"
                size="sm"
                disabled={value.pool.length <= 1}
                onClick={() => onChange({ ...value, pool: value.pool.filter((_, j) => j !== ci) })}
                aria-label="Remove candidate"
              >
                <IconTrash size={13} />
              </ActionIcon>
            </div>
          ))}
          <div className="ds-row-between">
            <Button
              variant="subtle"
              size="xs"
              leftSection={<IconPlus size={12} />}
              onClick={() =>
                onChange({ ...value, pool: [...value.pool, { modelKey: '', tier: value.pool.length + 1 }] })
              }
            >
              Add candidate
            </Button>
            <span className="ds-faint" style={{ fontSize: 11 }}>
              Tier: higher = stronger. Candidates missing a needed capability are skipped per request.
            </span>
          </div>
        </>
      )}
    </div>
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
