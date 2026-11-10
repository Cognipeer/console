'use client';

import { Box, Group, Text } from '@mantine/core';
import { fillPercent, severityOf, type UsageSeverity } from './format';

const COLOR: Record<UsageSeverity, string> = {
  ok: 'var(--mantine-color-gray-6)',
  warning: 'var(--mantine-color-yellow-6)',
  critical: 'var(--mantine-color-red-6)',
};

interface UsageBarProps {
  label: string;
  /** Already formatted "used of limit" (or "used, no limit") text. */
  valueText: string;
  used: number;
  limit?: number;
  /** 24 h peak, drawn as a marker on the bar. */
  peak?: number;
  peakText?: string;
  note?: string;
}

/** One row of the usage page: label, value text and a bar (neutral, warning from 80 %, critical at 100 %). */
export default function UsageBar({ label, valueText, used, limit, peak, peakText, note }: UsageBarProps) {
  const severity = severityOf(used, limit);
  const fill = fillPercent(used, limit);
  const peakAt = limit !== undefined && limit > 0 && peak !== undefined ? Math.min(100, (peak / limit) * 100) : undefined;

  return (
    <Box>
      <Group justify="space-between" gap="xs" wrap="nowrap" mb={4}>
        <Text size="sm" fw={500} truncate>{label}</Text>
        <Text size="sm" c={severity === 'ok' ? 'dimmed' : severity === 'warning' ? 'yellow.8' : 'red.7'} style={{ whiteSpace: 'nowrap' }}>
          {valueText}
        </Text>
      </Group>
      <Box
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit ?? undefined}
        aria-valuenow={used}
        style={{
          position: 'relative',
          height: 8,
          borderRadius: 4,
          background: 'var(--mantine-color-default-border)',
          overflow: 'visible',
        }}
      >
        {limit !== undefined ? (
          <Box style={{ width: `${fill}%`, height: '100%', borderRadius: 4, background: COLOR[severity] }} />
        ) : null}
        {peakAt !== undefined ? (
          <Box
            title={peakText}
            style={{
              position: 'absolute',
              top: -3,
              bottom: -3,
              left: `calc(${peakAt}% - 1px)`,
              width: 2,
              background: 'var(--mantine-color-text)',
              opacity: 0.7,
            }}
          />
        ) : null}
      </Box>
      {note || (peakText && peakAt !== undefined) ? (
        <Text size="xs" c="dimmed" mt={4}>
          {[peakAt !== undefined ? peakText : undefined, note].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
    </Box>
  );
}
