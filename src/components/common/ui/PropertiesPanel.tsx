'use client';

import { ReactNode } from 'react';
import { Divider, Group, Stack, Text } from '@mantine/core';

export interface PropertyRow {
  key: string;
  label: string;
  /** Omit to render `label` as a section header instead of a label/value row — groups a long property list (e.g. Request / Actor / Policy / Performance). */
  value?: ReactNode;
}

export interface PropertiesPanelProps {
  title?: string;
  rows: PropertyRow[];
}

/**
 * A right-hand "Properties" rail: a title plus a list of label/value rows.
 * Modeled after provider log-viewer detail pages (metadata sidebar next to
 * the request/response body) — reused by the Model Hub log modal and the
 * Agent Observability event panel so both surfaces read the same way.
 */
export default function PropertiesPanel({ title = 'Properties', rows }: PropertiesPanelProps) {
  if (rows.length === 0) return null;
  return (
    // Fixed width + flexShrink:0 so a wide sibling (a long conversation
    // column) never squeezes this rail to nothing in the flex row. No
    // scroll of its own — the modal's own body scrolls for the whole page;
    // a second, nested scroll region here fought that one (a visible gap
    // above the content, a scrollbar sitting on top of the rail). Only
    // `FunctionsList` keeps an inline scroll, scoped to just that row.
    <Stack gap="md" style={{ width: 280, flexShrink: 0 }}>
      <Text size="xs" fw={700} c="dimmed" tt="uppercase">
        {title}
      </Text>
      <Stack gap={12}>
        {rows.map((row, i) =>
          row.value === undefined ? (
            <Divider
              key={row.key}
              label={row.label}
              labelPosition="left"
              mt={i === 0 ? 0 : 4}
            />
          ) : (
            <Group key={row.key} justify="space-between" align="flex-start" wrap="nowrap" gap="md">
              <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
                {row.label}
              </Text>
              <div style={{ textAlign: 'right', minWidth: 0 }}>{row.value}</div>
            </Group>
          ),
        )}
      </Stack>
    </Stack>
  );
}
