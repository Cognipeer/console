'use client';

import { useMemo } from 'react';
import { ScrollArea, Stack, Text } from '@mantine/core';

export interface FunctionsListProps {
  /** Every function/tool name offered on this request. */
  names: string[] | null | undefined;
  /** Subset of `names` that was actually invoked — highlighted, not just listed. */
  usedNames?: string[] | null;
  emptyLabel?: string;
  /** Max height before the list scrolls internally instead of growing the page. */
  maxHeight?: number;
}

/** Above this many distinct names, stop rendering individual rows — an
 *  agent with a pathologically large declared tool set must not turn this
 *  row into thousands of DOM nodes. */
const MAX_ROWS = 200;

/**
 * The "Functions" row value used wherever a request's available tools are
 * shown — Model Hub, Agent Observability, AI App Gateway. One name per
 * line, monospace, right-aligned — a plain readable list rather than a
 * wall of pills (which loses contrast against a tinted Properties row).
 * Always shows the full list — no collapse; a long list scrolls inside its
 * own box instead of stretching the Properties column. A used/invoked name
 * is colored, not pulled into a separate list.
 */
export default function FunctionsList({
  names,
  usedNames,
  emptyLabel = 'No functions available',
  maxHeight = 160,
}: FunctionsListProps) {
  // De-duplicated: a repeated declaration (the same tool offered twice,
  // e.g. once native + once via an MCP alias) must not double-list.
  const uniqueNames = useMemo(
    () => Array.from(new Set((names ?? []).filter((n): n is string => typeof n === 'string' && n.length > 0))),
    [names],
  );
  const usedSet = useMemo(() => new Set((usedNames ?? []).filter((n): n is string => typeof n === 'string')), [usedNames]);

  if (uniqueNames.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        {emptyLabel}
      </Text>
    );
  }

  const visible = uniqueNames.slice(0, MAX_ROWS);
  const overflow = uniqueNames.length - visible.length;

  return (
    <ScrollArea.Autosize mah={maxHeight} type="auto" offsetScrollbars>
      <Stack gap={2} align="flex-end">
        {visible.map((name) => (
          <Text
            key={name}
            size="xs"
            style={{ fontFamily: 'var(--mantine-font-family-monospace, monospace)' }}
            c={usedSet.has(name) ? 'teal' : 'dimmed'}
            fw={usedSet.has(name) ? 600 : 400}
          >
            {name}()
          </Text>
        ))}
        {overflow > 0 ? (
          <Text size="xs" c="dimmed">
            +{overflow} more
          </Text>
        ) : null}
      </Stack>
    </ScrollArea.Autosize>
  );
}
