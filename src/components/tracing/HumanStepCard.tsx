'use client';

/**
 * What a person did at a pause, read from the event's own sections: for an
 * approval, the decision, who made it, how long the run waited and the
 * arguments as requested (and as approved, when the reviewer edited them);
 * for a question, each question with its answer; for a host-run tool, the
 * wait and the result the host sent back.
 *
 * Shown above the raw sections, which stay available for anything this card
 * does not know how to read.
 */

import { Badge, Box, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconUserCheck } from '@tabler/icons-react';
import dayjs from 'dayjs';
import JsonTreeViewer from '@/components/common/JsonTreeViewer';
import { humanStep, sectionToolArgs, type HumanStep, type SectionShell } from '@/lib/shared/tracingSections';
import { formatDuration } from '@/lib/utils/tracingUtils';
import { HUMAN_STATE_COLOR } from './stepDisplay';

type Section = SectionShell & Record<string, unknown>;

const TITLE: Record<HumanStep['kind'], string> = {
  approval: 'Tool approval',
  question: 'Question to the user',
  client_tool: 'Tool run by the client',
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function when(value: unknown): string | undefined {
  const raw = text(value);
  return raw && dayjs(raw).isValid() ? dayjs(raw).format('MMM D, HH:mm:ss') : undefined;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="xs" c="dimmed" w={96} style={{ flexShrink: 0 }}>{label}</Text>
      <Box style={{ minWidth: 0, flex: 1 }}>{children}</Box>
    </Group>
  );
}

function Arguments({ label, value }: { label: string; value: unknown }) {
  return (
    <Stack gap={4} style={{ minWidth: 0 }}>
      <Text size="xs" fw={600} c="dimmed">{label}</Text>
      {value !== null && typeof value === 'object'
        ? <JsonTreeViewer data={value as object} initialExpandLevel={2} />
        : <Text size="xs" ff="monospace" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{value === undefined ? '—' : String(value)}</Text>}
    </Stack>
  );
}

export default function HumanStepCard({ event }: {
  event: { type?: string; status?: string; durationMs?: number; sections?: Section[] };
}) {
  const human = humanStep(event);
  if (!human) return null;
  const sections = event.sections ?? [];
  const data = sections.map((section) => record(section.data)).find((candidate) => candidate && (candidate.approvalId || candidate.questionId)) ?? {};
  const argumentSections = sections.filter((section) => section.kind === 'tool_call');
  const qa = sections
    .map((section) => record(section.data))
    .flatMap((candidate) => (Array.isArray(candidate?.items) ? candidate.items : []))
    .map(record)
    .filter((item): item is Record<string, unknown> => Boolean(item && text(item.question)));
  const result = sections.find((section) => section.kind === 'tool_result');
  const waited = typeof data.waitedMs === 'number' ? data.waitedMs : human.state !== 'pending' ? event.durationMs : undefined;
  const decidedAt = when(data.decidedAt) ?? when(data.answeredAt);
  const note = text(data.comment) ?? text(data.notes);

  return (
    <Paper withBorder radius="md" p="sm" style={{ borderColor: `var(--mantine-color-${HUMAN_STATE_COLOR[human.state]}-3)` }}>
      <Stack gap="xs">
        <Group gap={8} wrap="nowrap">
          <IconUserCheck size={16} color={`var(--mantine-color-${HUMAN_STATE_COLOR[human.state]}-6)`} />
          <Text size="sm" fw={600}>{TITLE[human.kind]}</Text>
          <Badge size="sm" variant="light" color={HUMAN_STATE_COLOR[human.state]}>
            {human.state === 'pending' ? 'waiting' : human.state}
          </Badge>
          {data.argumentsEdited ? <Badge size="sm" variant="outline" color="blue">arguments edited</Badge> : null}
        </Group>

        <Stack gap={4}>
          {human.by ? <Row label={human.kind === 'approval' ? 'Decided by' : 'Answered by'}><Text size="xs" fw={600}>{human.by}</Text></Row> : null}
          {when(data.requestedAt) ? <Row label="Requested"><Text size="xs">{when(data.requestedAt)}</Text></Row> : null}
          {decidedAt ? <Row label={human.kind === 'approval' ? 'Decided' : 'Answered'}><Text size="xs">{decidedAt}</Text></Row> : null}
          {waited !== undefined ? <Row label="Run waited"><Text size="xs" fw={600}>{formatDuration(waited)}</Text></Row> : null}
          {note ? <Row label="Comment"><Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>{note}</Text></Row> : null}
          {text(data.prompt) ? <Row label="Prompt"><Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>{text(data.prompt)}</Text></Row> : null}
        </Stack>

        {qa.length > 0 ? (
          <Stack gap={6}>
            {qa.map((item, index) => (
              <Box key={index} p={8} style={{ borderRadius: 6, background: 'var(--mantine-color-default-hover)' }}>
                <Text size="xs" c="dimmed">{text(item.header) ? `${text(item.header)} · ` : ''}{text(item.question)}</Text>
                <Text size="sm" fw={500} style={{ whiteSpace: 'pre-wrap' }}>
                  {item.answer === null || item.answer === undefined
                    ? '—'
                    : typeof item.answer === 'string' ? item.answer : JSON.stringify(item.answer)}
                </Text>
              </Box>
            ))}
          </Stack>
        ) : null}

        {argumentSections.length > 0 ? (
          <SimpleGrid cols={argumentSections.length > 1 ? { base: 1, sm: 2 } : 1} spacing="sm">
            {argumentSections.map((section, index) => (
              <Arguments key={index} label={text(section.label) ?? 'Arguments'} value={sectionToolArgs(section)} />
            ))}
          </SimpleGrid>
        ) : null}

        {result ? <Arguments label={text(result.label) ?? 'Result'} value={result.output ?? result.content ?? result.summary} /> : null}
      </Stack>
    </Paper>
  );
}
