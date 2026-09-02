'use client';

import { useMemo, useState } from 'react';
import { Anchor, Box } from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';

export interface CollapsibleTextProps {
  children: string;
  /** Collapsed height in px before an "Expand" link appears. */
  collapsedHeight?: number;
  mono?: boolean;
  expandLabel?: string;
  collapseLabel?: string;
}

export default function CollapsibleText({
  children,
  collapsedHeight = 168,
  mono = false,
  expandLabel = 'Expand',
  collapseLabel = 'Collapse',
}: CollapsibleTextProps) {
  const [expanded, setExpanded] = useState(false);

  // A cheap proxy for "will this overflow the collapsed height" — real
  // layout can't be measured before paint, so line/char count stands in.
  const needsCollapse = useMemo(
    () => children.length > 420 || children.split('\n').length > 7,
    [children],
  );

  return (
    <Box>
      <Box
        style={{
          maxHeight: !expanded && needsCollapse ? collapsedHeight : undefined,
          overflow: 'hidden',
          position: 'relative',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: mono ? 'var(--mantine-font-family-monospace, ui-monospace, monospace)' : undefined,
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        {children}
        {!expanded && needsCollapse ? (
          <Box
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: 40,
              background: 'linear-gradient(to bottom, transparent, var(--mantine-color-body))',
            }}
          />
        ) : null}
      </Box>
      {needsCollapse ? (
        <Anchor
          size="sm"
          underline="never"
          onClick={() => setExpanded((v) => !v)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6 }}
        >
          {expanded ? collapseLabel : expandLabel}
          {expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        </Anchor>
      ) : null}
    </Box>
  );
}
