'use client';

import type { ReactNode } from 'react';
import { Badge, Tooltip } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { AgentVersionTagView } from './agentVersionTag';

interface AgentWithVersionProps {
  /** The agent (its key or name), or whatever the tag stands for. Left out, only the tag is drawn. */
  name?: ReactNode;
  /** From `configVersionTag` or `runVersionTag`; `null` draws the name alone. */
  tag: AgentVersionTagView | null;
}

/**
 * An agent's name with its version beside it, the one way Evaluations and Red team show which configuration of
 * an agent a test is set to, or a run tested. Spans only, so it sits inside a paragraph or a table cell, and it
 * takes its text style from where it is placed.
 */
export default function AgentWithVersion({ name, tag }: AgentWithVersionProps) {
  const badge = tag ? (
    <Tooltip label={tag.tooltip} withArrow multiline w={260} styles={{ tooltip: { whiteSpace: 'pre-line' } }}>
      <Badge
        component="span"
        size="xs"
        variant="light"
        color={tag.color}
        className="ds-mono"
        style={{ textTransform: 'none', flexShrink: 0, verticalAlign: 'middle' }}
        leftSection={tag.changed ? <IconAlertTriangle size={10} aria-hidden="true" /> : undefined}
      >
        {tag.label}
      </Badge>
    </Tooltip>
  ) : null;

  const hasName = name !== undefined && name !== null && name !== '';
  if (!hasName) return badge;
  if (!badge) return <>{name}</>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', verticalAlign: 'middle' }}>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{name}</span>
      {badge}
    </span>
  );
}
