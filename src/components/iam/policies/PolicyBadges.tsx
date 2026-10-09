'use client';

import { Badge } from '@mantine/core';
import type { IamPolicyEffect, IamPolicyMode } from '../api';
import type { IamLabels } from '../useIamLabels';

const EFFECT_COLOR: Record<IamPolicyEffect, string> = {
  permit: 'green',
  forbid: 'red',
  mixed: 'yellow',
};

// A badge never shrinks below its text: in a table cell Mantine would otherwise cut it to "MONIT...".
const NO_SHRINK = { minWidth: 'max-content' } as const;

export function EffectBadge({ effect, labels }: { effect: IamPolicyEffect; labels: IamLabels }) {
  return (
    <Badge variant="light" color={EFFECT_COLOR[effect]} style={NO_SHRINK}>
      {labels.effect(effect)}
    </Badge>
  );
}

export function ModeBadge({ mode, labels }: { mode: IamPolicyMode; labels: IamLabels }) {
  return (
    <Badge variant={mode === 'enforce' ? 'filled' : 'light'} color={mode === 'enforce' ? 'grape' : 'blue'} style={NO_SHRINK}>
      {labels.mode(mode)}
    </Badge>
  );
}
