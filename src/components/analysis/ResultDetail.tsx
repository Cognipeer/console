'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Group, Stack, Text } from '@mantine/core';
import { DetailCard, DetailTwoCol } from '@/components/common/ui/DetailShell';
import DecisionCard, { answerToDraft, draftToAnswer } from './DecisionCard';
import { pct } from './decisionUi';
import type { AnalysisResultDetailResponse } from './types';

function fmtDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

function cellText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '∅';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

interface ResultDetailProps {
  data: AnalysisResultDetailResponse;
  /** Opened from the review queue: Save & next / Skip, with Enter and S shortcuts. */
  queue: boolean;
  saving: boolean;
  onSave: (values: Record<string, string | boolean>) => void;
  onSkip: () => void;
}

/** Transcript on the left, the decision cards with their "Correct answer" pickers on the right. */
export default function ResultDetail({ data, queue, saving, onSave, onSkip }: ResultDetailProps) {
  const { result, definition, source } = data;

  // Only the fields the decision model answered; the rest are plain extraction.
  const decisionFields = useMemo(
    () => definition.fieldSet.filter((f) => result.decisions[f.key]),
    [definition.fieldSet, result.decisions],
  );

  // Prefill with the earlier review, else the model's own answer.
  const [draft, setDraft] = useState<Record<string, string | null>>(() => {
    const initial: Record<string, string | null> = {};
    for (const f of decisionFields) {
      const reviewed = result.review?.values?.[f.key];
      initial[f.key] = answerToDraft(reviewed !== undefined ? reviewed : result.decisions[f.key]?.answer);
    }
    return initial;
  });

  // A question the model refused has no answer to confirm: the reviewer must pick one.
  const unanswered = decisionFields.filter((f) => !draft[f.key]);
  const canSave = decisionFields.length > 0 && unanswered.length === 0;

  const save = () => {
    if (!canSave) return;
    const values: Record<string, string | boolean> = {};
    for (const f of decisionFields) {
      const v = draft[f.key];
      if (v) values[f.key] = draftToAnswer(f, v);
    }
    onSave(values);
  };

  // Keep the latest closures reachable from the window listener without re-binding it.
  const handlers = useRef({ save, onSkip, saving, canSave });
  handlers.current = { save, onSkip, saving, canSave };

  useEffect(() => {
    if (!queue) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable], [role="dialog"], [role="listbox"]')) return;
      const key = e.key.toLowerCase();
      if (key === 'enter') {
        // A focused button already handles Enter itself.
        if (target?.closest?.('button, a')) return;
        e.preventDefault();
        if (!handlers.current.saving && handlers.current.canSave) handlers.current.save();
      } else if (key === 's') {
        e.preventDefault();
        if (!handlers.current.saving) handlers.current.onSkip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [queue]);

  const decisionKeys = new Set(decisionFields.map((f) => f.key));
  const extracted = Object.entries(result.extractedFields ?? {}).filter(([k]) => !decisionKeys.has(k));

  return (
    <DetailTwoCol>
      <DetailCard title="Transcript">
        {source.available ? (
          <Stack gap="sm">
            {source.transcript.map((m, i) => (
              <div key={i}>
                <Text size="xs" c="dimmed" fw={600} tt="uppercase">{m.role}</Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</Text>
              </div>
            ))}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">The source is no longer available.</Text>
        )}
      </DetailCard>

      <Stack gap="md">
        <DetailCard title="Decisions" pad="md">
          <Stack gap="sm">
            {decisionFields.map((f) => (
              <DecisionCard
                key={f.key}
                field={f}
                decision={result.decisions[f.key]}
                value={draft[f.key] ?? null}
                onChange={(v) => setDraft((prev) => ({ ...prev, [f.key]: v }))}
                disabled={saving}
              />
            ))}
            {decisionFields.length === 0 ? <Text size="sm" c="dimmed">No decision answers on this result.</Text> : null}
          </Stack>

          {result.review ? (
            <Text size="xs" c="dimmed" mt="sm">Reviewed by {result.review.by} · {fmtDate(result.review.at)}</Text>
          ) : null}

          {decisionFields.length > 0 && unanswered.length > 0 ? (
            <Text size="xs" c="dimmed" mt="sm">Pick an answer for {unanswered.map((f) => f.key).join(', ')} to save.</Text>
          ) : null}

          {decisionFields.length > 0 || queue ? (
            <Group gap="xs" mt="md">
              {decisionFields.length > 0 ? (
                <Button size="sm" color="teal" loading={saving} disabled={!canSave} onClick={save}>{queue ? 'Save & next' : 'Save review'}</Button>
              ) : null}
              {queue ? <Button size="sm" variant="default" disabled={saving} onClick={onSkip}>Skip</Button> : null}
              {queue ? <span className="ds-faint" style={{ fontSize: 11 }}>{canSave ? 'Enter saves · S skips' : 'S skips'}</span> : null}
            </Group>
          ) : null}
        </DetailCard>

        {result.rationale ? (
          <DetailCard title="Rationale" pad="md">
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{result.rationale}</Text>
          </DetailCard>
        ) : null}

        {extracted.length > 0 ? (
          <DetailCard title="Extracted" pad="md">
            <Stack gap={4}>
              {extracted.map(([k, v]) => (
                <Group key={k} justify="space-between" wrap="nowrap" align="flex-start">
                  <Text size="xs" c="dimmed" className="ds-mono">{k}</Text>
                  <Text size="xs" style={{ textAlign: 'right', wordBreak: 'break-word' }}>{cellText(v)}</Text>
                </Group>
              ))}
            </Stack>
          </DetailCard>
        ) : null}

        {result.judge ? (
          <DetailCard title="Judge" pad="md">
            <Group gap="xs" mb={result.judge.reasoning ? 6 : 0}>
              <span className={`ds-badge ${result.judge.passed === false ? 'ds-badge-warn' : 'ds-badge-teal'}`}>{pct(result.judge.score)}</span>
              {result.judge.passed !== undefined ? <Text size="xs" c="dimmed">{result.judge.passed ? 'passed' : 'failed'}</Text> : null}
            </Group>
            {result.judge.reasoning ? <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{result.judge.reasoning}</Text> : null}
          </DetailCard>
        ) : null}
      </Stack>
    </DetailTwoCol>
  );
}
