'use client';

/**
 * The session's steps grouped the way the run actually nested them: each
 * turn (agent iteration, graph node, chain, or an inferred step for SDKs that
 * send a flat list) is a collapsible header, and every model or tool call
 * under it says in one line what it did.
 */

import { useState } from 'react';
import { ActionIcon, Badge, Box, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { formatDuration, formatNumber, resolveStatusColor } from '@/lib/utils/tracingUtils';
import { flattenTree, humanOutcomeText, outcomeText, type TraceNode } from './sessionModel';
import { CATEGORY_DISPLAY, HUMAN_STATE_COLOR, groupBadge, nodeDurationMs, stepBadge } from './stepDisplay';

export interface EventListGroupedProps {
  nodes: TraceNode[];
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
}

/** Groups this deep start collapsed, so a LangGraph run opens on its nodes rather than every call. */
const COLLAPSE_FROM_DEPTH = 3;

function DurationBar({ ms, maxMs, color, estimated }: { ms?: number; maxMs: number; color: string; estimated?: boolean }) {
  const pct = ms !== undefined && maxMs > 0 ? Math.max(1.5, (ms / maxMs) * 100) : 0;
  return (
    <Group gap={6} wrap="nowrap" style={{ flexShrink: 0, width: 118 }} justify="flex-end">
      <Box style={{ width: 52, height: 5, borderRadius: 3, background: 'var(--mantine-color-gray-2)', overflow: 'hidden' }}>
        {ms !== undefined ? (
          <Box
            style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: 3,
              background: `var(--mantine-color-${color}-5)`,
              opacity: estimated ? 0.5 : 1,
            }}
          />
        ) : null}
      </Box>
      <Text size="xs" c="dimmed" ff="monospace" style={{ width: 58, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {ms === undefined ? '—' : `${estimated ? '≈' : ''}${formatDuration(ms)}`}
      </Text>
    </Group>
  );
}

function stepSubtitle(node: TraceNode): string {
  const event = node.event;
  if (!event) return '';
  const parts: string[] = [`#${event.sequence ?? '—'}`];
  const tokens = event.totalTokens ?? ((event.inputTokens ?? 0) + (event.outputTokens ?? 0));
  if (tokens > 0) parts.push(`${formatNumber(tokens)} tok`);
  if (event.finishReason) parts.push(event.finishReason);
  return parts.join(' · ');
}

function StepRow({
  node,
  maxMs,
  selected,
  onSelect,
}: {
  node: TraceNode;
  maxMs: number;
  selected: boolean;
  onSelect: (eventId: string) => void;
}) {
  const event = node.event!;
  const display = CATEGORY_DISPLAY[node.category];
  const outcome = node.category === 'model' ? outcomeText(event) : undefined;
  const human = node.human;
  const failed = event.status === 'error';

  return (
    <UnstyledButton
      onClick={() => onSelect(event.id)}
      aria-pressed={selected}
      style={{
        display: 'block',
        width: '100%',
        padding: '7px 10px',
        borderRadius: 8,
        border: `1px solid ${selected ? 'var(--mantine-color-blue-4)' : failed ? 'var(--mantine-color-red-3)' : 'var(--mantine-color-gray-3)'}`,
        background: selected ? 'var(--mantine-color-blue-0)' : 'var(--mantine-color-body)',
      }}
    >
      <Group gap={8} wrap="nowrap">
        <Badge size="xs" variant="light" color={display.color} style={{ flexShrink: 0, minWidth: 44 }}>
          {stepBadge(node)}
        </Badge>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={600} lineClamp={1}>
            {node.label}
            {outcome ? <Text span size="sm" fw={500} c="dimmed"> {outcome}</Text> : null}
            {human ? (
              <Text span size="sm" fw={600} c={`${HUMAN_STATE_COLOR[human.state]}.7`}> {humanOutcomeText(human)}</Text>
            ) : null}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={1}>{stepSubtitle(node)}</Text>
        </Box>
        {node.waiting ? (
          <Tooltip label="The run paused here and nobody has answered yet." withArrow>
            <Badge size="xs" variant="filled" color="yellow" style={{ flexShrink: 0 }}>waiting</Badge>
          </Tooltip>
        ) : null}
        {failed ? (
          <Badge size="xs" variant="light" color={resolveStatusColor(event.status)} style={{ flexShrink: 0 }}>error</Badge>
        ) : null}
        <DurationBar ms={nodeDurationMs(node)} maxMs={maxMs} color={display.color} estimated={node.timing?.estimated} />
      </Group>
    </UnstyledButton>
  );
}

function GroupBlock({
  node,
  depth,
  maxLeafMs,
  maxGroupMs,
  selectedEventId,
  onSelect,
}: {
  node: TraceNode;
  depth: number;
  maxLeafMs: number;
  maxGroupMs: number;
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
}) {
  const [open, setOpen] = useState(depth < COLLAPSE_FROM_DEPTH);
  const selectable = Boolean(node.event?.sections && node.event.sections.length > 0) || node.category === 'tool';
  const selected = node.event ? node.event.id === selectedEventId : false;
  const firstModel = node.children.find((child) => child.category === 'model' && child.event);
  const summary = firstModel?.event ? outcomeText(firstModel.event) : undefined;
  const title = [...node.foldedLabels, node.label].join(' › ');

  return (
    <Box>
      <Group
        gap={6}
        wrap="nowrap"
        px={6}
        py={5}
        style={{
          borderRadius: 8,
          border: node.inferred ? '1px dashed var(--mantine-color-gray-4)' : '1px solid transparent',
          background: selected ? 'var(--mantine-color-blue-0)' : 'var(--mantine-color-gray-0)',
        }}
      >
        <ActionIcon
          variant="subtle"
          size="sm"
          color="gray"
          aria-label={open ? 'Collapse group' : 'Expand group'}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </ActionIcon>
        <UnstyledButton
          onClick={() => (selectable && node.event ? onSelect(node.event.id) : setOpen((value) => !value))}
          style={{ flex: 1, minWidth: 0 }}
        >
          <Group gap={7} wrap="nowrap">
            <Badge size="xs" variant="light" color={node.inferred ? 'gray' : CATEGORY_DISPLAY[node.category].color} style={{ flexShrink: 0 }}>
              {groupBadge(node)}
            </Badge>
            <Text size="sm" fw={700} lineClamp={1} style={{ flexShrink: 1, minWidth: 0 }}>{title}</Text>
            {node.resumed ? (
              <Tooltip label="Resumed after a pause (e.g. tool approval). The model call that requested these tools is in the previous session of this thread." multiline maw={300} withArrow>
                <Badge size="xs" variant="light" color="yellow" style={{ flexShrink: 0 }}>resumed</Badge>
              </Tooltip>
            ) : null}
            {node.running ? (
              <Tooltip label="Still running. The sub-agent's own record is written when it finishes; until then its steps are grouped here." multiline maw={300} withArrow>
                <Badge size="xs" variant="light" color="blue" style={{ flexShrink: 0 }}>running</Badge>
              </Tooltip>
            ) : null}
            {node.inferred ? (
              <Tooltip label="This SDK sent a flat list of calls; the step boundaries were inferred (each model call opens a step)." multiline maw={280} withArrow>
                <Badge size="xs" variant="outline" color="gray" style={{ flexShrink: 0 }}>inferred</Badge>
              </Tooltip>
            ) : null}
            {summary ? <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>{summary}</Text> : null}
            {node.parallel > 1 ? (
              <Tooltip label={`${node.parallel} steps in this group ran at the same time`} withArrow>
                <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>∥ {node.parallel}</Badge>
              </Tooltip>
            ) : null}
          </Group>
        </UnstyledButton>
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{node.children.length}</Text>
        <DurationBar ms={nodeDurationMs(node)} maxMs={maxGroupMs} color="teal" estimated={node.timing?.estimated} />
      </Group>
      {open ? (
        <Stack
          gap={4}
          mt={4}
          mb={6}
          ml={14}
          pl={10}
          style={{ borderLeft: '2px solid var(--mantine-color-teal-1)' }}
        >
          <NodeList
            nodes={node.children}
            depth={depth + 1}
            maxLeafMs={maxLeafMs}
            maxGroupMs={maxGroupMs}
            selectedEventId={selectedEventId}
            onSelect={onSelect}
          />
        </Stack>
      ) : null}
    </Box>
  );
}

function NodeList(props: {
  nodes: TraceNode[];
  depth: number;
  maxLeafMs: number;
  maxGroupMs: number;
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
}) {
  const { nodes, depth, maxLeafMs, maxGroupMs, selectedEventId, onSelect } = props;
  return (
    <>
      {nodes.map((node) => (
        node.children.length > 0 ? (
          <GroupBlock
            key={node.key}
            node={node}
            depth={depth}
            maxLeafMs={maxLeafMs}
            maxGroupMs={maxGroupMs}
            selectedEventId={selectedEventId}
            onSelect={onSelect}
          />
        ) : node.event ? (
          <StepRow
            key={node.key}
            node={node}
            maxMs={maxLeafMs}
            selected={node.event.id === selectedEventId}
            onSelect={onSelect}
          />
        ) : null
      ))}
    </>
  );
}

export default function EventListGrouped({ nodes, selectedEventId, onSelect }: EventListGroupedProps) {
  const all = flattenTree(nodes).map(({ node }) => node);
  const maxLeafMs = Math.max(0, ...all.filter((n) => n.children.length === 0).map((n) => nodeDurationMs(n) ?? 0));
  const maxGroupMs = Math.max(0, ...all.filter((n) => n.children.length > 0).map((n) => nodeDurationMs(n) ?? 0));

  return (
    <Stack gap={4}>
      <NodeList
        nodes={nodes}
        depth={0}
        maxLeafMs={maxLeafMs}
        maxGroupMs={maxGroupMs}
        selectedEventId={selectedEventId}
        onSelect={onSelect}
      />
    </Stack>
  );
}
