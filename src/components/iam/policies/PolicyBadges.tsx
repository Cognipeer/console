'use client';

import { Badge } from '@mantine/core';
import type { IamPolicyEffect } from '../api';
import type { IamLabels } from '../useIamLabels';

const EFFECT_COLOR: Record<IamPolicyEffect, string> = {
  permit: 'green',
  forbid: 'red',
  mixed: 'yellow',
};

// A badge never shrinks below its text: in a table cell Mantine would otherwise cut it to "DEN...".
const NO_SHRINK = { minWidth: 'max-content' } as const;

export function EffectBadge({ effect, labels }: { effect: IamPolicyEffect; labels: IamLabels }) {
  return (
    <Badge variant="light" color={EFFECT_COLOR[effect]} style={NO_SHRINK}>
      {labels.effect(effect)}
    </Badge>
  );
}
