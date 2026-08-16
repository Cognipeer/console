'use client';

/**
 * LabelSummaryPanel — what the dataset actually contains, by label.
 *
 * This is the payoff of labeling: instead of "1,240 items" you see "62% simple
 * lookup, 11% multi-step tool use", and every value is a filter, so you can go
 * straight from a segment to the items in it.
 */

import { Alert, Group, Paper, Progress, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { EvalLabelSummaryView } from './types';

export interface LabelFilter {
  key: string;
  value: string;
}

interface LabelSummaryPanelProps {
  summary: EvalLabelSummaryView;
  /** True when the distribution scan hit its cap (see the labels endpoint). */
  truncated?: boolean;
  active: LabelFilter | null;
  onSelect: (filter: LabelFilter | null) => void;
}

export default function LabelSummaryPanel({ summary, truncated, active, onSelect }: LabelSummaryPanelProps) {
  if (summary.keys.length === 0) return null;

  const coverage = summary.total > 0 ? summary.labeled / summary.total : 0;

  return (
    <Paper withBorder radius="md" p="lg" mb="lg">
      <Group justify="space-between" align="baseline" mb="sm">
        <Text fw={600} size="sm">Labels</Text>
        <Text size="xs" c="dimmed">
          {summary.labeled.toLocaleString()} of {summary.total.toLocaleString()} items labeled
          {' '}({Math.round(coverage * 100)}%)
          {summary.humanLabeled > 0 ? ` · ${summary.humanLabeled.toLocaleString()} human-reviewed` : ''}
        </Text>
      </Group>

      {truncated ? (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} mb="sm">
          This dataset is larger than the distribution scan limit — percentages cover the first slice of items only.
        </Alert>
      ) : null}

      <Stack gap="md">
        {summary.keys.map((entry) => (
          <div key={entry.key}>
            <Group justify="space-between" align="baseline" mb={4}>
              <Text size="xs" fw={600} className="ds-mono">{entry.key}</Text>
              <Text size="xs" c="dimmed">{entry.count.toLocaleString()} labeled</Text>
            </Group>
            <Stack gap={4}>
              {entry.values.map((value) => {
                const selected = active?.key === entry.key && active.value === value.value;
                return (
                  <Group
                    key={value.value}
                    gap="xs"
                    wrap="nowrap"
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    onClick={() => onSelect(selected ? null : { key: entry.key, value: value.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(selected ? null : { key: entry.key, value: value.value });
                      }
                    }}
                    style={{ cursor: 'pointer', opacity: active && !selected ? 0.55 : 1 }}
                  >
                    <Text size="xs" style={{ minWidth: 160 }} truncate title={value.value}>
                      {value.value}
                    </Text>
                    <Progress
                      value={value.share * 100}
                      size="sm"
                      radius="sm"
                      color={selected ? 'teal' : 'blue'}
                      style={{ flex: 1 }}
                    />
                    <Text size="xs" c="dimmed" className="ds-mono" style={{ minWidth: 78, textAlign: 'right' }}>
                      {value.count.toLocaleString()} · {Math.round(value.share * 100)}%
                    </Text>
                  </Group>
                );
              })}
              {entry.otherValues > 0 ? (
                <Text size="xs" c="dimmed">+{entry.otherValues} more value(s)</Text>
              ) : null}
            </Stack>
          </div>
        ))}
      </Stack>
    </Paper>
  );
}
