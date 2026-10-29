'use client';

/** The chip in a knowledge base's header that says whether document permissions are enforced; a click opens the Access tab. */

import { Badge, Tooltip } from '@mantine/core';
import { IconLock, IconLockOpen } from '@tabler/icons-react';

export interface RagAccessChipProps {
  /** Access control is on for the knowledge base. */
  enabled: boolean;
  /** Opens the Access tab. */
  onClick: () => void;
}

export function RagAccessChip({ enabled, onClick }: RagAccessChipProps) {
  return (
    <Tooltip label="Open the Access tab" withArrow>
      <Badge
        component="button"
        type="button"
        variant="light"
        color={enabled ? 'teal' : 'gray'}
        leftSection={enabled ? <IconLock size={12} /> : <IconLockOpen size={12} />}
        style={{ cursor: 'pointer' }}
        onClick={onClick}
      >
        Access control: {enabled ? 'On' : 'Off'}
      </Badge>
    </Tooltip>
  );
}
