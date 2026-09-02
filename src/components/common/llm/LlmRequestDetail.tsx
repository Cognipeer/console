'use client';

import { ReactNode } from 'react';
import { Badge, Box, Card, Divider, Group, Modal, ScrollArea, Stack, Tabs, Text, Timeline } from '@mantine/core';
import PropertiesPanel, { type PropertyRow } from '@/components/common/ui/PropertiesPanel';
import MessageBlock from '@/components/common/ui/MessageBlock';
import CollapsibleText from '@/components/common/ui/CollapsibleText';
import JsonTreeViewer from '@/components/common/JsonTreeViewer';

/**
 * One ordered stream of "what happened in this request" — every surface
 * that shows a single LLM request/response (Model Hub logs, Agent
 * Observability events, AI App Gateway requests) maps its own raw payload
 * into this stream, in the order things actually happened. The parsing
 * stays per-surface; the grouping and display below do not.
 *
 * `call`/`result` items sharing a `turnId` render as one grouped card (a
 * tool call and its answer, read together) instead of two unrelated blocks
 * — the fix for "three flat 'Tool' blocks with no name and no link between
 * them". A `message`/`divider` item closes any turns open at that point, so
 * grouping never reaches across an unrelated message.
 */
export type LlmRequestItem =
  | { itemType: 'message'; role: string; roleLabel?: ReactNode; content: unknown }
  | { itemType: 'divider'; label: ReactNode }
  /** Escape hatch for content a surface already renders well (e.g. a tool-definitions
   *  or response-format section) — passed through as-is, in its position in the stream. */
  | { itemType: 'custom'; node: ReactNode }
  | { itemType: 'call'; turnId: string; name?: string; args: unknown }
  | { itemType: 'result'; turnId: string; name?: string; content: unknown };

export interface LlmRequestDetailData {
  /** Status/latency/finish-reason/decision/etc chips, rendered above the tabs. */
  badges?: ReactNode;
  /** Error text, a routing/policy callout, or a secrets warning — rendered under the badges. */
  banner?: ReactNode;
  items: LlmRequestItem[];
  /** Right-rail rows — Created/ID/Model/Tokens/Functions/etc; each surface picks what it has.
   *  A row with no `value` renders as a section header (groups a long list). */
  properties: PropertyRow[];
  /** Present only when a caller wants the escape-hatch "Raw JSON" tab. */
  raw?: { request?: unknown; response?: unknown };
}

export interface LlmRequestDetailLabels {
  formatted: string;
  raw: string;
  properties: string;
  request: string;
  response: string;
  noRequest: string;
  noResponse: string;
  noItems: string;
  exchanges: string;
  exchange: string;
  untitledCall: string;
  noArguments: string;
}

const DEFAULT_LABELS: LlmRequestDetailLabels = {
  formatted: 'Formatted',
  raw: 'Raw JSON',
  properties: 'Properties',
  request: 'Request',
  response: 'Response',
  noRequest: 'Request data not available.',
  noResponse: 'Response data not available.',
  noItems: 'Nothing recorded for this request.',
  exchanges: 'exchanges',
  exchange: 'exchange',
  untitledCall: 'untitled call',
  noArguments: '— no arguments',
};

export interface LlmRequestDetailModalProps {
  opened: boolean;
  onClose: () => void;
  title: ReactNode;
  data: LlmRequestDetailData | null;
  labels?: Partial<LlmRequestDetailLabels>;
}

/* ─── Grouping: the ordered item stream → messages / dividers / turn cards ─── */

interface TurnEntry {
  type: 'call' | 'result';
  name?: string;
  value: unknown;
}

type GroupedEntry =
  | { kind: 'message'; role: string; roleLabel?: ReactNode; content: unknown }
  | { kind: 'divider'; label: ReactNode }
  | { kind: 'custom'; node: ReactNode }
  | { kind: 'turn'; turnId: string; name?: string; entries: TurnEntry[] };

function groupItems(items: LlmRequestItem[]): GroupedEntry[] {
  const output: GroupedEntry[] = [];
  const openTurns = new Map<string, Extract<GroupedEntry, { kind: 'turn' }>>();

  for (const item of items) {
    if (item.itemType === 'call' || item.itemType === 'result') {
      let group = openTurns.get(item.turnId);
      if (!group) {
        group = { kind: 'turn', turnId: item.turnId, name: item.name, entries: [] };
        openTurns.set(item.turnId, group);
        output.push(group);
      }
      group.entries.push({
        type: item.itemType,
        name: item.name,
        value: item.itemType === 'call' ? item.args : item.content,
      });
      if (item.name && !group.name) group.name = item.name;
    } else {
      // A message, divider or custom block closes every turn open so far —
      // grouping never reaches across an unrelated turn of the conversation.
      openTurns.clear();
      if (item.itemType === 'message') {
        output.push({ kind: 'message', role: item.role, roleLabel: item.roleLabel, content: item.content });
      } else if (item.itemType === 'divider') {
        output.push({ kind: 'divider', label: item.label });
      } else {
        output.push({ kind: 'custom', node: item.node });
      }
    }
  }
  return output;
}

/** A call/result value: short primitives render as an inline pill, everything else as a JSON tree. */
function ExchangeValue({ value, noArgumentsLabel }: { value: unknown; noArgumentsLabel: string }) {
  if (value === undefined) {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        {noArgumentsLabel}
      </Text>
    );
  }
  if (value !== null && typeof value === 'object') {
    return <JsonTreeViewer data={value} initialExpandLevel={2} />;
  }
  const display = typeof value === 'string' ? value : String(value);
  if (display.length <= 48 && !display.includes('\n')) {
    return (
      <Badge
        variant="light"
        color="gray"
        radius="sm"
        style={{ fontWeight: 400, fontFamily: 'var(--mantine-font-family-monospace, monospace)', textTransform: 'none' }}
      >
        {typeof value === 'string' ? `"${value}"` : display}
      </Badge>
    );
  }
  return <CollapsibleText collapsedHeight={120}>{display}</CollapsibleText>;
}

function TurnCard({
  group,
  index,
  labels,
}: {
  group: Extract<GroupedEntry, { kind: 'turn' }>;
  index: number;
  labels: LlmRequestDetailLabels;
}) {
  const count = group.entries.length;
  return (
    <Card withBorder radius="md" p={0} style={{ overflow: 'hidden' }}>
      <Group gap={9} px="md" py={8} style={{ background: 'var(--mantine-color-gray-0)', borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
        <Box
          style={{
            width: 20, height: 20, borderRadius: 6, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--mantine-color-violet-1)', color: 'var(--mantine-color-violet-7)',
            fontFamily: 'var(--mantine-font-family-monospace, monospace)', fontSize: 11, fontWeight: 600,
          }}
        >
          {index}
        </Box>
        <Text
          size="sm"
          fw={600}
          style={{ fontFamily: 'var(--mantine-font-family-monospace, monospace)' }}
          c={group.name ? undefined : 'dimmed'}
          fs={group.name ? undefined : 'italic'}
        >
          {group.name ?? labels.untitledCall}
        </Text>
        <Text size="xs" c="dimmed" ml="auto">
          {count} {count === 1 ? labels.exchange : labels.exchanges}
        </Text>
      </Group>
      <Box p="md">
        <Timeline bulletSize={14} lineWidth={2} active={count}>
          {group.entries.map((entry, i) => (
            <Timeline.Item
              key={i}
              bullet={
                <Box
                  style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: entry.type === 'call' ? 'var(--mantine-color-violet-6)' : 'var(--mantine-color-blue-6)',
                  }}
                />
              }
              title={
                <Text size="10px" fw={700} tt="uppercase" style={{ letterSpacing: 0.4 }} c={entry.type === 'call' ? 'violet' : 'blue'}>
                  {entry.type}
                </Text>
              }
            >
              <ExchangeValue value={entry.value} noArgumentsLabel={labels.noArguments} />
            </Timeline.Item>
          ))}
        </Timeline>
      </Box>
    </Card>
  );
}

export interface LlmRequestItemsViewProps {
  items: LlmRequestItem[];
  labels?: Partial<LlmRequestDetailLabels>;
}

/**
 * Renders one ordered item stream — messages, dividers, custom passthrough
 * blocks, and grouped turn cards. Used both by `LlmRequestDetailModal`'s
 * "Formatted" tab and, directly, by a surface that wants the same grouped
 * rendering inline (e.g. Agent Observability's own Sections tab) without the
 * full-screen modal chrome around it.
 */
export function LlmRequestItemsView({ items, labels: labelsOverride }: LlmRequestItemsViewProps) {
  const labels = { ...DEFAULT_LABELS, ...labelsOverride };
  const grouped = groupItems(items);
  let turnNumber = 0;

  if (grouped.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {labels.noItems}
      </Text>
    );
  }

  return (
    <Stack gap="lg">
      {grouped.map((g, i) => {
        if (g.kind === 'message') {
          return <MessageBlock key={i} messageRole={g.role} roleLabel={g.roleLabel} content={g.content} />;
        }
        if (g.kind === 'divider') {
          return <Divider key={i} label={g.label} labelPosition="left" />;
        }
        if (g.kind === 'custom') {
          return <Box key={i}>{g.node}</Box>;
        }
        turnNumber += 1;
        return <TurnCard key={i} group={g} index={turnNumber} labels={labels} />;
      })}
    </Stack>
  );
}

/**
 * The single full-screen viewer for "one LLM request/response" used
 * throughout the app — Model Hub logs, Agent Observability events, and AI
 * App Gateway requests all render through this one component so a request
 * looks and behaves the same everywhere it's inspected.
 */
export default function LlmRequestDetailModal({
  opened,
  onClose,
  title,
  data,
  labels: labelsOverride,
}: LlmRequestDetailModalProps) {
  const labels = { ...DEFAULT_LABELS, ...labelsOverride };
  const hasRaw = Boolean(data?.raw && (data.raw.request !== undefined || data.raw.response !== undefined));

  return (
    <Modal opened={opened} onClose={onClose} title={title} fullScreen padding="lg">
      {data ? (
        <Stack gap="md">
          {data.badges ? <Box>{data.badges}</Box> : null}
          {data.banner ? <Box>{data.banner}</Box> : null}

          <Tabs defaultValue="formatted">
            <Tabs.List>
              <Tabs.Tab value="formatted">{labels.formatted}</Tabs.Tab>
              {hasRaw ? <Tabs.Tab value="raw">{labels.raw}</Tabs.Tab> : null}
            </Tabs.List>

            <Tabs.Panel value="formatted" pt="md">
              <Box style={{ display: 'flex', gap: 40, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <ScrollArea.Autosize mah="calc(100vh - 220px)" style={{ flex: '1 1 520px', minWidth: 0 }} type="auto">
                  <Box pr="sm" maw={760}>
                    <LlmRequestItemsView items={data.items} labels={labels} />
                  </Box>
                </ScrollArea.Autosize>

                <PropertiesPanel title={labels.properties} rows={data.properties} />
              </Box>
            </Tabs.Panel>

            {hasRaw ? (
              <Tabs.Panel value="raw" pt="md">
                <Stack gap="md">
                  <Stack gap={4}>
                    <Text size="sm" fw={600}>
                      {labels.request}
                    </Text>
                    <ScrollArea.Autosize mah={360} type="auto">
                      {data.raw?.request !== undefined ? (
                        <JsonTreeViewer data={data.raw.request} initialExpandLevel={2} />
                      ) : (
                        <Text size="sm" c="dimmed">
                          {labels.noRequest}
                        </Text>
                      )}
                    </ScrollArea.Autosize>
                  </Stack>
                  <Stack gap={4}>
                    <Text size="sm" fw={600}>
                      {labels.response}
                    </Text>
                    <ScrollArea.Autosize mah={360} type="auto">
                      {data.raw?.response !== undefined ? (
                        <JsonTreeViewer data={data.raw.response} initialExpandLevel={2} />
                      ) : (
                        <Text size="sm" c="dimmed">
                          {labels.noResponse}
                        </Text>
                      )}
                    </ScrollArea.Autosize>
                  </Stack>
                </Stack>
              </Tabs.Panel>
            ) : null}
          </Tabs>
        </Stack>
      ) : null}
    </Modal>
  );
}
