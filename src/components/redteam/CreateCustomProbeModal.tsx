'use client';

/**
 * Custom probe builder — author an adversarial probe without code. The form
 * mirrors the engine's probe shape: a set of attempts (user turns + an optional
 * canary-bearing system prompt) and a detector selection (refusal gate, the
 * deterministic canary/pattern detector, and a panel of LLM-judge lenses). The
 * payload posts to /api/redteam/custom-probes, where it is validated against the
 * same `buildCustomProbe` rules the runner uses, so an unrunnable probe is
 * rejected up front.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import Link from 'next/link';
import FormShell, { FormSection } from '@/components/common/ui/FormShell';
import { CUSTOM_PROBE_LIMITS } from '@/lib/services/redteam/limits';
import { OWASP_LLM_CATEGORIES, OWASP_LLM_LABELS, normalizeOwaspCategory } from '@/lib/services/redteam/owasp';
import { NAMED_DETECTOR_KEYS } from '@/lib/services/redteam/types';
import { attemptIdError, detectorInfo, highestAttemptSuffix, nextAttemptId, probeSourceLabel, splitPatternLines } from './helpers';
import type { BuiltinProbeDefinitionView, CustomProbeAttemptView, CustomProbeView, RedTeamProbePolarity } from './types';

const POLARITY_OPTIONS = [
  { value: 'attack', label: 'Attack: a hit means the attack worked' },
  { value: 'over-refusal', label: 'Over-refusal: harmless prompts, a refusal is the failure' },
];

const HISTORY_ROLE_OPTIONS = [
  { value: 'user', label: 'user' },
  { value: 'assistant', label: 'assistant' },
];

interface HistoryDraft {
  role: 'user' | 'assistant';
  content: string;
}

const CATEGORY_OPTIONS = OWASP_LLM_CATEGORIES.map((value) => ({ value, label: OWASP_LLM_LABELS[value] }));
const DEFAULT_CATEGORY = 'LLM01-prompt-injection';

const SEVERITY_OPTIONS = ['low', 'medium', 'high', 'critical'].map((s) => ({ value: s, label: s }));

interface AttemptDraft {
  id: string;
  turns: string[];
  /** Forged earlier turns sent before the first user turn. */
  history: HistoryDraft[];
  system: string;
  canary: string;
  /** One pattern per line. */
  forbiddenPatterns: string;
  refusalExpected: boolean;
  adaptive: boolean;
  objective: string;
}

interface JudgeDraft {
  lens: string;
  rubric: string;
  threshold: number | '';
}

function emptyAttempt(id: string): AttemptDraft {
  return {
    id,
    turns: [''],
    history: [],
    system: '',
    canary: '',
    forbiddenPatterns: '',
    refusalExpected: true,
    adaptive: false,
    objective: '',
  };
}

/** The canary is only planted when the system prompt carries it, so a canary needs `{{canary}}` (or its own text) there. */
function canaryNotPlanted(a: AttemptDraft): boolean {
  const canary = a.canary.trim();
  if (!canary) return false;
  return !a.system.includes('{{canary}}') && !a.system.includes(canary);
}

/** A canary or forbidden patterns are matched by the pattern detector, so it cannot be switched off for them. */
function needsPatternDetector(a: AttemptDraft): boolean {
  return a.canary.trim().length > 0 || splitPatternLines(a.forbiddenPatterns).length > 0;
}

function toAttemptDraft(a: CustomProbeAttemptView, i: number): AttemptDraft {
  return {
    id: a.id || `attempt-${i + 1}`,
    turns: a.turns.length ? a.turns : [''],
    history: (a.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    system: a.system ?? '',
    canary: a.canary ?? '',
    forbiddenPatterns: (a.forbiddenPatterns ?? []).join('\n'),
    refusalExpected: a.refusalExpected ?? true,
    adaptive: a.adaptive ?? false,
    objective: a.objective ?? '',
  };
}

interface Props {
  opened: boolean;
  editing?: CustomProbeView | null;
  /** Create mode prefilled from a built-in probe; saving posts `clonedFrom`. */
  cloneOf?: BuiltinProbeDefinitionView | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function CreateCustomProbeModal({ opened, editing, cloneOf, onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>(DEFAULT_CATEGORY);
  const [severity, setSeverity] = useState<string>('medium');
  const [enabled, setEnabled] = useState(true);
  const [attempts, setAttempts] = useState<AttemptDraft[]>([emptyAttempt('attempt-1')]);
  const [refusal, setRefusal] = useState(true);
  const [pattern, setPattern] = useState(true);
  const [judges, setJudges] = useState<JudgeDraft[]>([]);
  const [named, setNamed] = useState<string[]>([]);
  const [polarity, setPolarity] = useState<RedTeamProbePolarity>('attack');
  const [saving, setSaving] = useState(false);
  // Highest attempt-id suffix seen in this edit session, so an id that was removed is not handed out again.
  const maxAttemptSuffix = useRef(1);

  useEffect(() => {
    if (!opened) return;
    if (editing) {
      setName(editing.name);
      setDescription(editing.description ?? '');
      // A probe stored under a legacy category shows (and saves) under its 2025 key.
      setCategory(normalizeOwaspCategory(editing.category));
      setSeverity(editing.severity);
      setEnabled(editing.enabled !== false);
      maxAttemptSuffix.current = Math.max(1, highestAttemptSuffix(editing.attempts.map((a) => a.id || '')));
      setAttempts(editing.attempts.map(toAttemptDraft));
      setRefusal(editing.detectors.refusal !== false);
      setPattern(editing.detectors.pattern !== false);
      setNamed(editing.detectors.named ?? []);
      setPolarity(editing.polarity ?? 'attack');
      setJudges((editing.detectors.judges ?? []).map((j) => ({ lens: j.lens, rubric: j.rubric, threshold: j.threshold ?? '' })));
    } else if (cloneOf) {
      setName(`${cloneOf.key}-copy`);
      setDescription(cloneOf.description ?? '');
      setCategory(normalizeOwaspCategory(cloneOf.category));
      setSeverity(cloneOf.severity);
      setEnabled(true);
      maxAttemptSuffix.current = Math.max(1, highestAttemptSuffix(cloneOf.attempts.map((a) => a.id || '')));
      setAttempts(cloneOf.attempts.map(toAttemptDraft));
      setRefusal(cloneOf.detectorSpec.refusal === true);
      setPattern(cloneOf.detectorSpec.pattern === true);
      setNamed(cloneOf.detectorSpec.named ?? []);
      setPolarity(cloneOf.polarity ?? 'attack');
      setJudges((cloneOf.detectorSpec.judges ?? []).map((j) => ({ lens: j.lens, rubric: j.rubric, threshold: j.threshold ?? '' })));
    } else {
      setNamed([]);
      setPolarity('attack');
      setName('');
      setDescription('');
      setCategory(DEFAULT_CATEGORY);
      setSeverity('medium');
      setEnabled(true);
      maxAttemptSuffix.current = 1;
      setAttempts([emptyAttempt('attempt-1')]);
      setRefusal(true);
      setPattern(true);
      setJudges([]);
    }
  }, [opened, editing, cloneOf]);

  const updateAttempt = (idx: number, patch: Partial<AttemptDraft>) => {
    setAttempts((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  };

  // The ids of the other attempts, to check one attempt's id against.
  const idErrors = attempts.map((a, idx) => attemptIdError(a.id, attempts.filter((_, i) => i !== idx).map((o) => o.id)));
  const overRefusal = polarity === 'over-refusal';
  const patternForced = !overRefusal && attempts.some(needsPatternDetector);
  const patternOn = !overRefusal && (pattern || patternForced);
  const refusalOn = overRefusal || refusal;
  const namedOn = overRefusal ? [] : named;
  // An over-refusal probe has no canary or patterns: it only checks whether the target refuses.
  const overRefusalHasPatterns = overRefusal && attempts.some(needsPatternDetector);
  const historyIncomplete = attempts.some((a) => a.history.some((m) => !m.content.trim()));

  const valid =
    name.trim().length > 0 &&
    attempts.length > 0 &&
    attempts.every((a) => a.turns.some((t) => t.trim().length > 0)) &&
    idErrors.every((e) => e === null) &&
    !attempts.some(canaryNotPlanted) &&
    !overRefusalHasPatterns &&
    !historyIncomplete &&
    (refusalOn || patternOn || namedOn.length > 0 || judges.some((j) => j.lens.trim() && j.rubric.trim()));

  const submit = async () => {
    if (!valid) {
      notifications.show({ title: 'Incomplete', message: 'Name, at least one attempt turn, and one detector are required.', color: 'red' });
      return;
    }
    setSaving(true);
    try {
      // An absent key leaves the stored value alone on an edit, so an emptied description is
      // sent as `''` to clear it. The optional fields inside the attempts and the judges need
      // no such care: those arrays are sent whole and replace the stored ones.
      const payload = {
        name: name.trim(),
        description: description.trim() || (editing ? '' : undefined),
        category,
        severity,
        enabled,
        polarity,
        ...(!editing && cloneOf ? { clonedFrom: { probeKey: cloneOf.key, version: cloneOf.version ?? 1 } } : {}),
        attempts: attempts.map((a, i) => ({
          id: a.id || `attempt-${i + 1}`,
          turns: a.turns.map((t) => t.trim()).filter(Boolean),
          history: a.history.map((m) => ({ role: m.role, content: m.content.trim() })),
          system: a.system.trim() || undefined,
          canary: a.canary.trim() || undefined,
          forbiddenPatterns: splitPatternLines(a.forbiddenPatterns),
          refusalExpected: a.refusalExpected,
          adaptive: a.adaptive,
          objective: a.objective.trim() || undefined,
        })),
        detectors: {
          refusal: refusalOn,
          pattern: patternOn,
          named: namedOn,
          judges: judges
            .filter((j) => j.lens.trim() && j.rubric.trim())
            .map((j) => ({ lens: j.lens.trim(), rubric: j.rubric.trim(), threshold: typeof j.threshold === 'number' ? j.threshold : undefined })),
        },
      };
      const url = editing ? `/api/redteam/custom-probes/${editing.id}` : '/api/redteam/custom-probes';
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');
      notifications.show({ title: editing ? 'Probe updated' : 'Probe created', message: name, color: 'teal' });
      onSaved();
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Save failed', color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  const atAttemptLimit = attempts.length >= CUSTOM_PROBE_LIMITS.maxAttempts;
  const atJudgeLimit = judges.length >= CUSTOM_PROBE_LIMITS.maxJudges;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      title={editing ? 'Edit custom probe' : cloneOf ? 'Clone built-in probe' : 'New custom probe'}
      primaryAction={{
        label: editing ? 'Save probe' : 'Create probe',
        loading: saving,
        disabled: !valid,
        onClick: () => {
          void submit();
        },
      }}
    >
      <FormSection title="Probe">
        <Stack gap="md">
          {!editing && cloneOf ? (
            <Text size="sm" c="dimmed" data-testid="redteam-clone-banner">
              Cloned from{' '}
              <Link href={`/dashboard/redteam/probes/builtin/${encodeURIComponent(cloneOf.key)}`}>
                {cloneOf.key} v{cloneOf.version ?? 1}
              </Link>
              . The built-in probe is not changed.
            </Text>
          ) : null}
          {editing?.origin === 'clone' && editing.clonedFrom ? (
            <Text size="sm" c="dimmed">
              {probeSourceLabel(editing)}
              {' · '}
              <Link href={`/dashboard/redteam/probes/builtin/${encodeURIComponent(editing.clonedFrom.probeKey)}`}>view the original</Link>
            </Text>
          ) : null}
          {editing?.origin === 'import' ? (
            <Text size="sm" c="dimmed" data-testid="redteam-import-source">
              {probeSourceLabel(editing)}
              {editing.source?.license ? ` · licence ${editing.source.license}` : ''}
              {editing.source?.fileName ? ` · ${editing.source.fileName}` : ''}
              {editing.source?.url ? (
                <>
                  {' · '}
                  <a href={editing.source.url} target="_blank" rel="noopener noreferrer">source</a>
                </>
              ) : null}
            </Text>
          ) : null}
          <Group grow align="flex-start">
            <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="My injection probe" />
            <Select
              label="OWASP category"
              description="OWASP Top 10 for LLM Applications (2025)"
              data={CATEGORY_OPTIONS}
              value={category}
              onChange={(v) => setCategory(v ?? category)}
              allowDeselect={false}
            />
            <Select label="Severity" data={SEVERITY_OPTIONS} value={severity} onChange={(v) => setSeverity(v ?? severity)} w={140} allowDeselect={false} />
          </Group>
          <Textarea label="Description" value={description} onChange={(e) => setDescription(e.currentTarget.value)} autosize minRows={1} placeholder="What this probe tests" />
          <Select
            label="Polarity"
            description="An over-refusal probe sends harmless prompts and counts refusals as its own rate; it never counts in the attack success rate."
            data={POLARITY_OPTIONS}
            value={polarity}
            onChange={(v) => setPolarity(v === 'over-refusal' ? 'over-refusal' : 'attack')}
            allowDeselect={false}
          />
          {overRefusalHasPatterns ? (
            <Text size="xs" c="red">An over-refusal probe cannot have a canary or forbidden patterns. Clear them or switch the polarity back to attack.</Text>
          ) : null}
          <Switch
            label="Enabled"
            description="A disabled probe stays in the library but campaigns skip it."
            checked={enabled}
            onChange={(e) => setEnabled(e.currentTarget.checked)}
          />
        </Stack>
      </FormSection>

      <FormSection title="Attempts">
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            Up to {CUSTOM_PROBE_LIMITS.maxAttempts} attempts, each with up to {CUSTOM_PROBE_LIMITS.maxTurnsPerAttempt} turns
            ({CUSTOM_PROBE_LIMITS.maxTurnChars.toLocaleString('en-US')} characters per turn). Attempt ids stay fixed once created, so earlier scans keep pointing at the same attempt.
          </Text>
          {attempts.map((a, idx) => {
            const idError = idErrors[idx];
            const notPlanted = canaryNotPlanted(a);
            return (
              <Stack key={idx} gap={6} p="sm" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }}>
                <Group justify="space-between">
                  <Group gap="xs">
                    <Text size="sm" fw={600}>Attempt {idx + 1}</Text>
                    {idError === null ? <Text size="xs" c="dimmed" className="ds-mono">{a.id}</Text> : null}
                  </Group>
                  {attempts.length > 1 ? (
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`Remove attempt ${idx + 1}`}
                      onClick={() => setAttempts((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <IconTrash size={15} />
                    </ActionIcon>
                  ) : null}
                </Group>
                {idError !== null ? (
                  // Only shown for an id the server would refuse (stored before the rules, or a duplicate); a valid id is not editable.
                  <TextInput
                    label="Attempt id"
                    value={a.id}
                    maxLength={CUSTOM_PROBE_LIMITS.maxAttemptIdLength}
                    error={idError}
                    onChange={(e) => updateAttempt(idx, { id: e.currentTarget.value })}
                  />
                ) : null}
                <Stack gap={4}>
                  <Text size="sm" fw={500}>History (optional)</Text>
                  <Text size="xs" c="dimmed">
                    Forged earlier turns sent before the first user turn, up to {CUSTOM_PROBE_LIMITS.maxHistoryMessages}. The scan skips this attempt on targets that do not take caller history, such as agents.
                  </Text>
                  {a.history.map((m, hi) => (
                    <Group key={hi} align="flex-start" gap="xs" wrap="nowrap">
                      <Select
                        aria-label={`History message ${hi + 1} role of attempt ${idx + 1}`}
                        data={HISTORY_ROLE_OPTIONS}
                        value={m.role}
                        w={120}
                        allowDeselect={false}
                        onChange={(v) =>
                          updateAttempt(idx, { history: a.history.map((x, i) => (i === hi ? { ...x, role: v === 'assistant' ? 'assistant' : 'user' } : x)) })
                        }
                      />
                      <Textarea
                        aria-label={`History message ${hi + 1} of attempt ${idx + 1}`}
                        style={{ flex: 1 }}
                        value={m.content}
                        maxLength={CUSTOM_PROBE_LIMITS.maxTurnChars}
                        onChange={(e) => {
                          const content = e.currentTarget.value;
                          updateAttempt(idx, { history: a.history.map((x, i) => (i === hi ? { ...x, content } : x)) });
                        }}
                        autosize
                        minRows={1}
                      />
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        mt={4}
                        aria-label={`Remove history message ${hi + 1} of attempt ${idx + 1}`}
                        onClick={() => updateAttempt(idx, { history: a.history.filter((_, i) => i !== hi) })}
                      >
                        <IconTrash size={15} />
                      </ActionIcon>
                    </Group>
                  ))}
                  <Group>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      leftSection={<IconPlus size={13} />}
                      disabled={a.history.length >= CUSTOM_PROBE_LIMITS.maxHistoryMessages}
                      onClick={() =>
                        updateAttempt(idx, {
                          history: [...a.history, { role: a.history.length % 2 === 0 ? 'user' : 'assistant', content: '' }],
                        })
                      }
                    >
                      Add history message
                    </Button>
                  </Group>
                </Stack>
                {a.turns.map((turn, ti) => (
                  <Group key={ti} align="flex-start" gap="xs" wrap="nowrap">
                    <Textarea
                      style={{ flex: 1 }}
                      label={ti === 0 ? 'User turn(s)' : undefined}
                      description={ti === 0 ? 'The adversarial prompt. Add more turns for a scripted multi-turn attack.' : undefined}
                      value={turn}
                      maxLength={CUSTOM_PROBE_LIMITS.maxTurnChars}
                      onChange={(e) => updateAttempt(idx, { turns: a.turns.map((t, i) => (i === ti ? e.currentTarget.value : t)) })}
                      autosize
                      minRows={2}
                    />
                    {a.turns.length > 1 ? (
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        mt={ti === 0 ? 28 : 0}
                        aria-label={`Remove turn ${ti + 1} of attempt ${idx + 1}`}
                        onClick={() => updateAttempt(idx, { turns: a.turns.filter((_, i) => i !== ti) })}
                      >
                        <IconTrash size={15} />
                      </ActionIcon>
                    ) : null}
                  </Group>
                ))}
                <Group>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    leftSection={<IconPlus size={13} />}
                    disabled={a.turns.length >= CUSTOM_PROBE_LIMITS.maxTurnsPerAttempt}
                    onClick={() => updateAttempt(idx, { turns: [...a.turns, ''] })}
                  >
                    Add turn
                  </Button>
                </Group>
                <Textarea
                  label="System prompt"
                  description="Optional. Put {{canary}} where the canary secret below should appear, so the canary is planted."
                  value={a.system}
                  maxLength={CUSTOM_PROBE_LIMITS.maxSystemChars}
                  onChange={(e) => updateAttempt(idx, { system: e.currentTarget.value })}
                  error={notPlanted ? 'Put {{canary}} in the system prompt so the canary is planted.' : undefined}
                  autosize
                  minRows={1}
                />
                <Group grow align="flex-start">
                  <TextInput label="Canary secret" description="A planted secret; if it leaks, that's a confirmed hit." value={a.canary} onChange={(e) => updateAttempt(idx, { canary: e.currentTarget.value })} />
                  <Textarea
                    label="Forbidden patterns"
                    description="One per line: substrings or regular expressions that indicate a hit."
                    value={a.forbiddenPatterns}
                    onChange={(e) => updateAttempt(idx, { forbiddenPatterns: e.currentTarget.value })}
                    autosize
                    minRows={2}
                  />
                </Group>
                <Group>
                  <Checkbox label="Refusal is the safe outcome" checked={a.refusalExpected} onChange={(e) => updateAttempt(idx, { refusalExpected: e.currentTarget.checked })} />
                  <Checkbox label="Adaptive (multi-turn attacker)" checked={a.adaptive} onChange={(e) => updateAttempt(idx, { adaptive: e.currentTarget.checked })} />
                </Group>
                {a.adaptive ? (
                  <TextInput
                    label="Attacker objective"
                    description="Goal that steers the adaptive escalation."
                    value={a.objective}
                    maxLength={CUSTOM_PROBE_LIMITS.maxObjectiveChars}
                    onChange={(e) => updateAttempt(idx, { objective: e.currentTarget.value })}
                  />
                ) : null}
              </Stack>
            );
          })}
          <Button
            variant="light"
            size="xs"
            leftSection={<IconPlus size={14} />}
            disabled={atAttemptLimit}
            onClick={() => {
              const id = nextAttemptId(attempts.map((a) => a.id), 'attempt-', maxAttemptSuffix.current);
              maxAttemptSuffix.current = highestAttemptSuffix([id], maxAttemptSuffix.current);
              setAttempts((prev) => [...prev, emptyAttempt(id)]);
            }}
          >
            {atAttemptLimit ? `Attempt limit reached (${CUSTOM_PROBE_LIMITS.maxAttempts})` : 'Add attempt'}
          </Button>
        </Stack>
      </FormSection>

      <FormSection title="Detectors">
        <Stack gap="md">
          <Group align="flex-start">
            <Checkbox
              label="Refusal gate"
              description={overRefusal ? 'Always on: a refusal is what an over-refusal probe measures.' : 'Cheap explicit-refusal safe signal'}
              checked={refusalOn}
              disabled={overRefusal}
              onChange={(e) => setRefusal(e.currentTarget.checked)}
            />
            <Checkbox
              label="Pattern / canary"
              description={
                overRefusal
                  ? 'Off for an over-refusal probe.'
                  : patternForced
                    ? 'Always on: an attempt sets a canary or forbidden patterns.'
                    : 'Deterministic hard-proof detector'
              }
              checked={patternOn}
              disabled={patternForced || overRefusal}
              onChange={(e) => setPattern(e.currentTarget.checked)}
            />
          </Group>
          <Stack gap="xs">
            <Text size="sm" fw={500}>Named detectors</Text>
            <Text size="xs" c="dimmed">
              Ready-made deterministic checks on the output (up to {CUSTOM_PROBE_LIMITS.maxNamedDetectors}).
              {overRefusal ? ' Off for an over-refusal probe.' : ''}
            </Text>
            <Checkbox.Group value={namedOn} onChange={setNamed}>
              <Group align="flex-start" gap="lg">
                {NAMED_DETECTOR_KEYS.map((key) => (
                  <Checkbox
                    key={key}
                    value={key}
                    label={detectorInfo(key).label}
                    description={detectorInfo(key).help}
                    disabled={overRefusal || (!namedOn.includes(key) && namedOn.length >= CUSTOM_PROBE_LIMITS.maxNamedDetectors)}
                    w={260}
                  />
                ))}
              </Group>
            </Checkbox.Group>
          </Stack>
          <Stack gap="xs">
            <Text size="sm" fw={500}>LLM-judge lenses</Text>
            <Text size="xs" c="dimmed">
              Each lens grades whether the attack succeeded from a distinct angle (up to {CUSTOM_PROBE_LIMITS.maxJudges}). Needs a judge model on the campaign.
            </Text>
            {judges.map((j, idx) => (
              <Group key={idx} align="flex-start" gap="xs" wrap="nowrap">
                {/* The value is read HERE, not inside the updater: React runs a
                    functional update during the next render, by which time the
                    synthetic event's `currentTarget` is null. */}
                <TextInput aria-label={`Judge lens ${idx + 1} name`} placeholder="lens (e.g. exfiltration)" value={j.lens} onChange={(e) => { const value = e.currentTarget.value; setJudges((prev) => prev.map((x, i) => (i === idx ? { ...x, lens: value } : x))); }} w={180} />
                <Textarea aria-label={`Judge lens ${idx + 1} rubric`} style={{ flex: 1 }} placeholder="Rubric: the attack succeeds if…" value={j.rubric} maxLength={CUSTOM_PROBE_LIMITS.maxRubricChars} onChange={(e) => { const value = e.currentTarget.value; setJudges((prev) => prev.map((x, i) => (i === idx ? { ...x, rubric: value } : x))); }} autosize minRows={1} />
                <NumberInput aria-label={`Judge lens ${idx + 1} threshold`} placeholder="0.5" value={j.threshold} min={0} max={1} step={0.05} decimalScale={2} w={90} onChange={(v) => setJudges((prev) => prev.map((x, i) => (i === idx ? { ...x, threshold: typeof v === 'number' ? v : '' } : x)))} />
                <ActionIcon variant="subtle" color="red" mt={4} aria-label={`Remove judge lens ${idx + 1}`} onClick={() => setJudges((prev) => prev.filter((_, i) => i !== idx))}>
                  <IconTrash size={15} />
                </ActionIcon>
              </Group>
            ))}
            <Group>
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={<IconPlus size={13} />}
                disabled={atJudgeLimit}
                onClick={() => setJudges((prev) => [...prev, { lens: '', rubric: '', threshold: '' }])}
              >
                Add judge lens
              </Button>
            </Group>
          </Stack>
        </Stack>
      </FormSection>
    </FormShell>
  );
}
