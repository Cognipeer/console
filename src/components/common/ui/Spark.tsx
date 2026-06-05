'use client';

import { useMemo } from 'react';

interface SparkProps {
  data: number[];
  color?: string;
  filled?: boolean;
  height?: number;
  className?: string;
}

export default function Spark({
  data,
  color = 'var(--ds-accent)',
  filled = true,
  height = 36,
  className,
}: SparkProps) {
  const { path, area, id } = useMemo(() => {
    if (!data || data.length === 0) {
      return { path: '', area: '', id: 'empty' };
    }
    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min || 1;
    const w = 200;
    const h = height;
    const pts = data.map((v, i) => {
      const x = (i / Math.max(1, data.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x},${y}`;
    });
    const p = `M ${pts.join(' L ')}`;
    const a = `${p} L ${w},${h} L 0,${h} Z`;
    return {
      path: p,
      area: a,
      id: `spark-${color.replace(/[^a-z0-9]/gi, '')}`,
    };
  }, [data, color, height]);

  if (!path) {
    return (
      <div
        style={{ height, display: 'block' }}
        aria-hidden="true"
        className={className}
      />
    );
  }

  return (
    <svg
      viewBox={`0 0 200 ${height}`}
      preserveAspectRatio="none"
      style={{ display: 'block', width: '100%', height }}
      className={className}
      aria-hidden="true"
    >
      {filled ? (
        <>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${id})`} />
        </>
      ) : null}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
