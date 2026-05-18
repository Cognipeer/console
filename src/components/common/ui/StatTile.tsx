'use client';

import { ReactNode } from 'react';
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react';
import Spark from './Spark';

interface StatTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: string;
  deltaDir?: 'up' | 'down' | null;
  icon?: ReactNode;
  spark?: number[];
  sparkColor?: string;
}

export default function StatTile({
  label,
  value,
  unit,
  delta,
  deltaDir,
  icon,
  spark,
  sparkColor = 'var(--ds-accent)',
}: StatTileProps) {
  return (
    <div className="ds-stat">
      <div className="ds-stat-label">
        {icon}
        {label}
      </div>
      <div className="ds-stat-value">
        <span>{value}</span>
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {delta ? (
        <div className={`ds-stat-delta ${deltaDir ?? ''}`}>
          {deltaDir === 'up' ? (
            <IconArrowUp size={12} stroke={2} />
          ) : deltaDir === 'down' ? (
            <IconArrowDown size={12} stroke={2} />
          ) : null}
          {delta}
        </div>
      ) : null}
      {spark && spark.length > 1 ? (
        <div className="ds-stat-spark">
          <Spark data={spark} color={sparkColor} />
        </div>
      ) : null}
    </div>
  );
}
