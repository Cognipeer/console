'use client';

import { ReactNode } from 'react';

type Status = 'active' | 'paused' | 'degraded' | 'failed' | 'pending' | 'ok' | 'warn' | 'err' | 'info';

interface StatusBadgeProps {
  status: Status | string;
  label?: ReactNode;
  withDot?: boolean;
}

const STATUS_MAP: Record<string, { cls: string; label: string }> = {
  active: { cls: 'ds-badge-ok', label: 'Active' },
  ok: { cls: 'ds-badge-ok', label: 'OK' },
  success: { cls: 'ds-badge-ok', label: 'Success' },
  paused: { cls: '', label: 'Paused' },
  degraded: { cls: 'ds-badge-warn', label: 'Degraded' },
  warn: { cls: 'ds-badge-warn', label: 'Warning' },
  failed: { cls: 'ds-badge-err', label: 'Failed' },
  err: { cls: 'ds-badge-err', label: 'Error' },
  error: { cls: 'ds-badge-err', label: 'Error' },
  pending: { cls: 'ds-badge-info', label: 'Pending' },
  info: { cls: 'ds-badge-info', label: 'Info' },
};

export default function StatusBadge({ status, label, withDot = true }: StatusBadgeProps) {
  const cfg = STATUS_MAP[status.toLowerCase()] ?? { cls: '', label: status };
  return (
    <span className={`ds-badge ${cfg.cls}`}>
      {withDot ? <span className="ds-badge-dot" /> : null}
      {label ?? cfg.label}
    </span>
  );
}
