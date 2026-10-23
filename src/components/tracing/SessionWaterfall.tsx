'use client';

/**
 * Every step of the session at its real position on the clock. Groups are a
 * thin band spanning their children; parallel steps overlap visibly; a step
 * without a duration is a point, and an estimated one is drawn hollow.
 */

import { Box, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { formatDuration } from '@/lib/utils/tracingUtils';
import { flattenTree, outcomeText, type TraceNode } from './sessionModel';
import { CATEGORY_DISPLAY, groupBadge, nodeDurationMs, stepBadge } from './stepDisplay';

export interface SessionWaterfallProps {
  nodes: TraceNode[];
  windowStart: number;
  windowEnd: number;
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
}

const NAME_COL = 250;
const DUR_COL = 64;
const MIN_BAR_PX = 3;

/** 1/2/5 × 10^k step giving 4–8 ticks across the window. */
function tickStep(totalMs: number): number {
  const raw = totalMs / 6;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const factor of [1, 2, 5, 10]) {
    if (raw <= factor * magnitude) return factor * magnitude;
  }
  return 10 * magnitude;
}

function formatOffset(ms: number): string {
  if (ms === 0) return '0';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

function rowTitle(node: TraceNode): string {
  if (node.children.length > 0) return [...node.foldedLabels, node.label].join(' › ');
  const outcome = node.event && node.category === 'model' ? outcomeText(node.event) : undefined;
  return outcome ? `${node.label} ${outcome}` : node.label;
}

export default function SessionWaterfall({ nodes, windowStart, windowEnd, selectedEventId, onSelect }: SessionWaterfallProps) {
  const total = Math.max(1, windowEnd - windowStart);
  const step = tickStep(total);
  const ticks: number[] = [];
  for (let t = 0; t <= total + 1; t += step) ticks.push(t);
  const rows = flattenTree(nodes);
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / total) * 100))}%`;

  return (
    <Box style={{ overflowX: 'auto' }}>
      <Stack gap={0} style={{ minWidth: 640 }}>
        <Group gap={10} wrap="nowrap" mb={4}>
          <Box style={{ width: NAME_COL, flexShrink: 0 }} />
          <Box style={{ position: 'relative', flex: 1, height: 16 }}>
            {ticks.map((t) => (
              <Text
                key={t}
                size="10px"
                c="dimmed"
                ff="monospace"
                style={{ position: 'absolute', left: pct(t), transform: t === 0 ? undefined : 'translateX(-50%)', whiteSpace: 'nowrap' }}
              >
                {formatOffset(t)}
              </Text>
            ))}
          </Box>
          <Box style={{ width: DUR_COL, flexShrink: 0 }} />
        </Group>

        {rows.map(({ node, depth }) => {
          const isGroup = node.children.length > 0;
          const event = node.event;
          const timing = node.timing;
          const display = CATEGORY_DISPLAY[node.category];
          const color = event?.status === 'error' ? 'red' : isGroup ? (node.inferred ? 'gray' : 'teal') : display.color;
          const selected = Boolean(event && event.id === selectedEventId);
          const ms = nodeDurationMs(node);
          const offset = timing ? timing.start - windowStart : undefined;
          const tooltip = timing
            ? `${rowTitle(node)} · ${ms !== undefined ? `${timing.estimated ? '≈' : ''}${formatDuration(ms)}` : 'no duration reported'} · starts +${formatOffset(Math.max(0, offset ?? 0))}`
            : `${rowTitle(node)} · no timestamp`;

          return (
            <UnstyledButton
              key={node.key}
              onClick={() => event && onSelect(event.id)}
              disabled={!event}
              aria-pressed={selected}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '3px 0',
                borderRadius: 6,
                background: selected ? 'var(--mantine-color-blue-0)' : undefined,
                cursor: event ? 'pointer' : 'default',
              }}
            >
              <Group gap={6} wrap="nowrap" style={{ width: NAME_COL, flexShrink: 0, paddingLeft: 6 + depth * 14, minWidth: 0 }}>
                <Text size="10px" fw={700} tt="uppercase" c={color} style={{ flexShrink: 0, width: 62 }}>
                  {isGroup ? groupBadge(node) : stepBadge(node)}
                </Text>
                <Text size="xs" fw={isGroup ? 700 : 500} lineClamp={1} style={{ minWidth: 0 }}>
                  {rowTitle(node)}
                </Text>
                {node.parallel > 1 ? <Text size="10px" c="dimmed" style={{ flexShrink: 0 }}>∥{node.parallel}</Text> : null}
                {node.resumed ? <Text size="10px" c="yellow.8" fw={600} style={{ flexShrink: 0 }}>resumed</Text> : null}
                {node.waiting ? <Text size="10px" c="yellow.8" fw={600} style={{ flexShrink: 0 }}>waiting</Text> : null}
                {node.running ? <Text size="10px" c="blue.7" fw={600} style={{ flexShrink: 0 }}>running</Text> : null}
              </Group>

              <Tooltip label={tooltip} withArrow openDelay={150} multiline maw={360}>
                <Box
                  style={{
                    position: 'relative',
                    flex: 1,
                    height: 18,
                    backgroundImage: 'linear-gradient(to right, var(--mantine-color-gray-2) 1px, transparent 1px)',
                    backgroundSize: `${(step / total) * 100}% 100%`,
                  }}
                >
                  {timing && offset !== undefined ? (
                    timing.hasDuration ? (
                      <Box
                        style={{
                          position: 'absolute',
                          left: pct(offset),
                          width: `max(${MIN_BAR_PX}px, ${pct(timing.end - timing.start)})`,
                          top: isGroup ? 7 : 3,
                          height: isGroup ? 4 : 12,
                          borderRadius: 3,
                          background: timing.estimated ? 'transparent' : `var(--mantine-color-${color}-${isGroup ? 3 : 5})`,
                          border: timing.estimated ? `1px dashed var(--mantine-color-${color}-5)` : undefined,
                        }}
                      />
                    ) : (
                      <Box
                        style={{
                          position: 'absolute',
                          left: pct(offset),
                          top: 4,
                          width: 9,
                          height: 9,
                          transform: 'translateX(-50%) rotate(45deg)',
                          background: `var(--mantine-color-${color}-5)`,
                        }}
                      />
                    )
                  ) : null}
                </Box>
              </Tooltip>

              <Text size="xs" c="dimmed" ff="monospace" style={{ width: DUR_COL, flexShrink: 0, textAlign: 'right', paddingRight: 6, fontVariantNumeric: 'tabular-nums' }}>
                {ms === undefined ? '—' : `${timing?.estimated ? '≈' : ''}${formatDuration(ms)}`}
              </Text>
            </UnstyledButton>
          );
        })}
      </Stack>
    </Box>
  );
}
