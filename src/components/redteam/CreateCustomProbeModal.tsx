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
import FormShell, { FormSection } from '@/components/common/ui/FormShell';
import { CUSTOM_PROBE_LIMITS } from '@/lib/services/redteam/limits';
import { OWASP_LLM_CATEGORIES, OWASP_LLM_LABELS, normalizeOwaspCategory } from '@/lib/services/redteam/owasp';
import { attemptIdError, highestAttemptSuffix, nextAttemptId, splitPatternLines } from './helpers';
import type { CustomProbeView } from './types';

const CATEGORY_OPTIONS = OWASP_LLM_CATEGORIES.map((value) => ({ value, label: OWASP_LLM_LABELS[value] }));
const DEFAULT_CATEGORY = 'LLM01-prompt-injection';

const SEVERITY_OPTIONS = ['low', 'medium', 'high', 'critical'].map((s) => ({ value: s, label: s }));

interface AttemptDraft {
  id: string;
  turns: string[];
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

interface Props {
  opened: boolean;
  editing?: CustomProbeView | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function CreateCustomProbeModal({ opened, editing, onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>(DEFAULT_CATEGORY);
  const [severity, setSeverity] = useState<string>('medium');
  const [enabled, setEnabled] = useState(true);
  const [attempts, setAttempts] = useState<AttemptDraft[]>([emptyAttempt('attempt-1')]);
  const [refusal, setRefusal] = useState(true);
  const [pattern, setPattern] = useState(true);
  const [judges, setJudges] = useState<JudgeDraft[]>([]);
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
      setAttempts(
        editing.attempts.map((a, i) => ({
          id: a.id || `attempt-${i + 1}`,
          turns: a.turns.length ? a.turns : [''],
          system: a.system ?? '',
          canary: a.canary ?? '',
          forbiddenPatterns: (a.forbiddenPatterns ?? []).join('\n'),
          refusalExpected: a.refusalExpected ?? true,
          adaptive: a.adaptive ?? false,
          objective: a.objective ?? '',
        })),
      );
      setRefusal(editing.detectors.refusal !== false);
      setPattern(editing.detectors.pattern !== false);
      setJudges((editing.detectors.judges ?? []).map((j) => ({ lens: j.lens, rubric: j.rubric, threshold: j.threshold ?? '' })));
    } else {
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
  }, [opened, editing]);

  const updateAttempt = (idx: number, patch: Partial<AttemptDraft>) => {
    setAttempts((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  };

  // The ids of the other attempts, to check one attempt's id against.
  const idErrors = attempts.map((a, idx) => attemptIdError(a.id, attempts.filter((_, i) => i !== idx).map((o) => o.id)));
  const patternForced = attempts.some(needsPatternDetector);
  const patternOn = pattern || patternForced;

  const valid =
    name.trim().length > 0 &&
    attempts.length > 0 &&
    attempts.every((a) => a.turns.some((t) => t.trim().length > 0)) &&
    idErrors.every((e) => e === null) &&
    !attempts.some(canaryNotPlanted) &&
    (refusal || patternOn || judges.some((j) => j.lens.trim() && j.rubric.trim()));

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
        attempts: attempts.map((a, i) => ({
          id: a.id || `attempt-${i + 1}`,
          turns: a.turns.map((t) => t.trim()).filter(Boolean),
          system: a.system.trim() || undefined,
          canary: a.canary.trim() || undefined,
          forbiddenPatterns: splitPatternLines(a.forbiddenPatterns),
          refusalExpected: a.refusalExpected,
          adaptive: a.adaptive,
          objective: a.objective.trim() || undefined,
        })),
        detectors: {
          refusal,
          pattern: patternOn,
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
      title={editing ? 'Edit custom probe' : 'New custom probe'}
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
            <Checkbox label="Refusal gate" description="Cheap explicit-refusal safe signal" checked={refusal} onChange={(e) => setRefusal(e.currentTarget.checked)} />
            <Checkbox
              label="Pattern / canary"
              description={patternForced ? 'Always on: an attempt sets a canary or forbidden patterns.' : 'Deterministic hard-proof detector'}
              checked={patternOn}
              disabled={patternForced}
              onChange={(e) => setPattern(e.currentTarget.checked)}
            />
          </Group>
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
