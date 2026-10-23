'use client';

import { Group, Progress, Select, Text } from '@mantine/core';
import type { AnalysisDecisionView, AnalysisFieldDefView } from './types';
import { decisionBadgeClass, FIELD_TYPE_LABELS, formatAnswer, pct } from './decisionUi';

/** Select value for a stored answer: booleans are 'yes' / 'no', everything else its key / label. */
export function answerToDraft(answer: unknown): string | null {
  if (answer === undefined || answer === null) return null;
  if (typeof answer === 'boolean') return answer ? 'yes' : 'no';
  return String(answer);
}

/** Back from the Select value to what the review API stores (booleans stay booleans). */
export function draftToAnswer(field: AnalysisFieldDefView, draft: string): string | boolean {
  if (field.type === 'boolean') return draft === 'yes';
  return draft;
}

/** The options a reviewer can pick for a field: Yes / No, the choice keys, or the score levels. */
export function answerOptions(field: AnalysisFieldDefView): { value: string; label: string }[] {
  if (field.type === 'boolean') return [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
  const values = field.type === 'score' ? field.levels : field.enumValues;
  return (values ?? []).map((v) => ({ value: v, label: v }));
}

function optionLabel(key: string): string {
  if (key === 'yes') return 'Yes';
  if (key === 'no') return 'No';
  return key;
}

const CONFIDENCE_SOURCE_LABEL: Record<string, string> = {
  self_reported: 'self-reported',
  logprobs: 'from token probabilities',
};

interface DecisionCardProps {
  field: AnalysisFieldDefView;
  decision: AnalysisDecisionView;
  /** The reviewer's pick (a Select value), or null when none. */
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}

/** One decision-model question: the answer, its probabilities and a "Correct answer" picker. */
export default function DecisionCard({ field, decision, value, onChange, disabled }: DecisionCardProps) {
  const modelAnswer = answerToDraft(decision.answer);
  const probabilities = Object.entries(decision.probabilities ?? {});
  const sourceLabel = decision.confidenceSource ? CONFIDENCE_SOURCE_LABEL[decision.confidenceSource] : undefined;
  return (
    <div className="ds-card ds-card-pad-sm">
      <Group justify="space-between" wrap="nowrap" mb={6}>
        <Group gap={6} wrap="nowrap">
          <Text size="sm" fw={600} className="ds-mono">{field.key}</Text>
          <span className="ds-faint" style={{ fontSize: 11 }}>{FIELD_TYPE_LABELS[field.type]}</span>
        </Group>
        <Group gap={6} wrap="nowrap">
          <span className={decisionBadgeClass(decision)}>{formatAnswer(decision)}</span>
          <span className="ds-muted" style={{ fontSize: 12 }}>{decision.refused ? '—' : pct(decision.confidence)}</span>
        </Group>
      </Group>
      {field.description ? <Text size="xs" c="dimmed" mb={6}>{field.description}</Text> : null}
      {sourceLabel ? <Text size="xs" c="dimmed" mb={6}>confidence {sourceLabel}</Text> : null}

      {probabilities.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(60px, 120px) 1fr 40px', gap: '4px 8px', alignItems: 'center', marginBottom: 10 }}>
          {probabilities.map(([key, p]) => (
            <ProbabilityRow key={key} label={optionLabel(key)} p={p} selected={key === modelAnswer} />
          ))}
        </div>
      ) : null}

      <Select
        label="Correct answer"
        size="xs"
        data={answerOptions(field)}
        value={value}
        onChange={onChange}
        placeholder={modelAnswer ? undefined : 'Pick the right answer'}
        allowDeselect={false}
        disabled={disabled}
      />
    </div>
  );
}

function ProbabilityRow({ label, p, selected }: { label: string; p: number; selected: boolean }) {
  return (
    <>
      <Text size="xs" fw={selected ? 600 : 400} truncate title={label}>{label}</Text>
      <Progress size="sm" value={Math.max(0, Math.min(1, p)) * 100} color={selected ? 'teal' : 'gray'} />
      <Text size="xs" c="dimmed" ta="right">{pct(p)}</Text>
    </>
  );
}
