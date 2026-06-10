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

import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { CustomProbeView } from './types';

const CATEGORY_OPTIONS = [
  { value: 'LLM01-prompt-injection', label: 'LLM01 · Prompt Injection' },
  { value: 'LLM02-insecure-output-handling', label: 'LLM02 · Insecure Output Handling' },
  { value: 'LLM04-model-dos', label: 'LLM04 · Model Denial of Service' },
  { value: 'LLM05-supply-chain', label: 'LLM05 · Supply Chain' },
  { value: 'LLM06-sensitive-information-disclosure', label: 'LLM06 · Sensitive Information Disclosure' },
  { value: 'LLM07-system-prompt-leakage', label: 'LLM07 · System Prompt Leakage' },
  { value: 'LLM08-excessive-agency', label: 'LLM08 · Excessive Agency' },
  { value: 'LLM09-overreliance', label: 'LLM09 · Overreliance' },
];

const SEVERITY_OPTIONS = ['low', 'medium', 'high', 'critical'].map((s) => ({ value: s, label: s }));

interface AttemptDraft {
  id: string;
  turns: string[];
  system: string;
  canary: string;
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

function emptyAttempt(i: number): AttemptDraft {
  return {
    id: `attempt-${i}`,
    turns: [''],
    system: '',
    canary: '',
    forbiddenPatterns: '',
    refusalExpected: true,
    adaptive: false,
    objective: '',
  };
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
  const [category, setCategory] = useState<string>('LLM01-prompt-injection');
  const [severity, setSeverity] = useState<string>('medium');
  const [attempts, setAttempts] = useState<AttemptDraft[]>([emptyAttempt(1)]);
  const [refusal, setRefusal] = useState(true);
  const [pattern, setPattern] = useState(true);
  const [judges, setJudges] = useState<JudgeDraft[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!opened) return;
    if (editing) {
      setName(editing.name);
      setDescription(editing.description ?? '');
      setCategory(editing.category);
      setSeverity(editing.severity);
      setAttempts(
        editing.attempts.map((a, i) => ({
          id: a.id || `attempt-${i + 1}`,
          turns: a.turns.length ? a.turns : [''],
          system: a.system ?? '',
          canary: a.canary ?? '',
          forbiddenPatterns: (a.forbiddenPatterns ?? []).join(', '),
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
      setCategory('LLM01-prompt-injection');
      setSeverity('medium');
      setAttempts([emptyAttempt(1)]);
      setRefusal(true);
      setPattern(true);
      setJudges([]);
    }
  }, [opened, editing]);

  const updateAttempt = (idx: number, patch: Partial<AttemptDraft>) => {
    setAttempts((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  };

  const valid =
    name.trim().length > 0 &&
    attempts.length > 0 &&
    attempts.every((a) => a.turns.some((t) => t.trim().length > 0)) &&
    (refusal || pattern || judges.some((j) => j.lens.trim() && j.rubric.trim()));

  const submit = async () => {
    if (!valid) {
      notifications.show({ title: 'Incomplete', message: 'Name, at least one attempt turn, and one detector are required.', color: 'red' });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        category,
        severity,
        attempts: attempts.map((a, i) => ({
          id: a.id || `attempt-${i + 1}`,
          turns: a.turns.map((t) => t.trim()).filter(Boolean),
          system: a.system.trim() || undefined,
          canary: a.canary.trim() || undefined,
          forbiddenPatterns: a.forbiddenPatterns.split(',').map((p) => p.trim()).filter(Boolean),
          refusalExpected: a.refusalExpected,
          adaptive: a.adaptive,
          objective: a.objective.trim() || undefined,
        })),
        detectors: {
          refusal,
          pattern,
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

  return (
    <Modal opened={opened} onClose={onClose} title={editing ? 'Edit custom probe' : 'New custom probe'} centered size="xl">
      <Stack gap="md">
        <Group grow align="flex-start">
          <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="My injection probe" />
          <Select label="OWASP category" data={CATEGORY_OPTIONS} value={category} onChange={(v) => setCategory(v ?? category)} />
          <Select label="Severity" data={SEVERITY_OPTIONS} value={severity} onChange={(v) => setSeverity(v ?? severity)} w={140} />
        </Group>
        <Textarea label="Description" value={description} onChange={(e) => setDescription(e.currentTarget.value)} autosize minRows={1} placeholder="What this probe tests" />

        <Divider label="Attempts" labelPosition="left" />
        <Stack gap="sm">
          {attempts.map((a, idx) => (
            <Stack key={idx} gap={6} p="sm" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }}>
              <Group justify="space-between">
                <Text size="sm" fw={600}>Attempt {idx + 1}</Text>
                {attempts.length > 1 ? (
                  <ActionIcon variant="subtle" color="red" onClick={() => setAttempts((prev) => prev.filter((_, i) => i !== idx))}>
                    <IconTrash size={15} />
                  </ActionIcon>
                ) : null}
              </Group>
              {a.turns.map((turn, ti) => (
                <Group key={ti} align="flex-start" gap="xs" wrap="nowrap">
                  <Textarea
                    style={{ flex: 1 }}
                    label={ti === 0 ? 'User turn(s)' : undefined}
                    description={ti === 0 ? 'The adversarial prompt. Add more turns for a scripted multi-turn attack.' : undefined}
                    value={turn}
                    onChange={(e) => updateAttempt(idx, { turns: a.turns.map((t, i) => (i === ti ? e.currentTarget.value : t)) })}
                    autosize
                    minRows={2}
                  />
                  {a.turns.length > 1 ? (
                    <ActionIcon variant="subtle" color="red" mt={ti === 0 ? 28 : 0} onClick={() => updateAttempt(idx, { turns: a.turns.filter((_, i) => i !== ti) })}>
                      <IconTrash size={15} />
                    </ActionIcon>
                  ) : null}
                </Group>
              ))}
              <Group>
                <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={13} />} onClick={() => updateAttempt(idx, { turns: [...a.turns, ''] })}>
                  Add turn
                </Button>
              </Group>
              <Textarea
                label="System prompt"
                description="Optional. Use {{canary}} to embed the canary secret below."
                value={a.system}
                onChange={(e) => updateAttempt(idx, { system: e.currentTarget.value })}
                autosize
                minRows={1}
              />
              <Group grow align="flex-start">
                <TextInput label="Canary secret" description="A planted secret; if it leaks, that's a confirmed hit." value={a.canary} onChange={(e) => updateAttempt(idx, { canary: e.currentTarget.value })} />
                <TextInput label="Forbidden patterns" description="Comma-separated substrings/regex that indicate a hit." value={a.forbiddenPatterns} onChange={(e) => updateAttempt(idx, { forbiddenPatterns: e.currentTarget.value })} />
              </Group>
              <Group>
                <Checkbox label="Refusal is the safe outcome" checked={a.refusalExpected} onChange={(e) => updateAttempt(idx, { refusalExpected: e.currentTarget.checked })} />
                <Checkbox label="Adaptive (multi-turn attacker)" checked={a.adaptive} onChange={(e) => updateAttempt(idx, { adaptive: e.currentTarget.checked })} />
              </Group>
              {a.adaptive ? (
                <TextInput label="Attacker objective" description="Goal that steers the adaptive escalation." value={a.objective} onChange={(e) => updateAttempt(idx, { objective: e.currentTarget.value })} />
              ) : null}
            </Stack>
          ))}
          <Button variant="light" size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAttempts((prev) => [...prev, emptyAttempt(prev.length + 1)])}>
            Add attempt
          </Button>
        </Stack>

        <Divider label="Detectors" labelPosition="left" />
        <Group>
          <Checkbox label="Refusal gate" description="Cheap explicit-refusal safe signal" checked={refusal} onChange={(e) => setRefusal(e.currentTarget.checked)} />
          <Checkbox label="Pattern / canary" description="Deterministic hard-proof detector" checked={pattern} onChange={(e) => setPattern(e.currentTarget.checked)} />
        </Group>
        <Stack gap="xs">
          <Text size="sm" fw={500}>LLM-judge lenses</Text>
          <Text size="xs" c="dimmed">Each lens grades whether the attack succeeded from a distinct angle. Needs a judge model on the campaign.</Text>
          {judges.map((j, idx) => (
            <Group key={idx} align="flex-start" gap="xs" wrap="nowrap">
              <TextInput placeholder="lens (e.g. exfiltration)" value={j.lens} onChange={(e) => setJudges((prev) => prev.map((x, i) => (i === idx ? { ...x, lens: e.currentTarget.value } : x)))} w={180} />
              <Textarea style={{ flex: 1 }} placeholder="Rubric: the attack succeeds if…" value={j.rubric} onChange={(e) => setJudges((prev) => prev.map((x, i) => (i === idx ? { ...x, rubric: e.currentTarget.value } : x)))} autosize minRows={1} />
              <NumberInput placeholder="0.5" value={j.threshold} min={0} max={1} step={0.05} decimalScale={2} w={90} onChange={(v) => setJudges((prev) => prev.map((x, i) => (i === idx ? { ...x, threshold: typeof v === 'number' ? v : '' } : x)))} />
              <ActionIcon variant="subtle" color="red" mt={4} onClick={() => setJudges((prev) => prev.filter((_, i) => i !== idx))}>
                <IconTrash size={15} />
              </ActionIcon>
            </Group>
          ))}
          <Group>
            <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={13} />} onClick={() => setJudges((prev) => [...prev, { lens: '', rubric: '', threshold: '' }])}>
              Add judge lens
            </Button>
          </Group>
        </Stack>

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button color="teal" loading={saving} disabled={!valid} onClick={submit}>{editing ? 'Save probe' : 'Create probe'}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
