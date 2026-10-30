'use client';

import Link from 'next/link';
import { Tooltip } from '@mantine/core';
import { IconTopologyStar3 } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { flowAttributionLabel, flowRunHref, type TracingFlowBlock } from './flowAttribution';

export interface FlowAttributionLinkProps {
  flow: TracingFlowBlock;
  /** Stop the row click from also firing (the link is inside a clickable table row). */
  stopRowClick?: boolean;
}

/** "Flow: <name> › <node>", a link to the flow run when the session has one. */
export default function FlowAttributionLink({ flow, stopRowClick = true }: FlowAttributionLinkProps) {
  const t = useTranslations('tracingHealth');
  const label = flowAttributionLabel(flow, t('flowAttribution.prefix'));
  const href = flowRunHref(flow);
  const content = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, fontWeight: 500, maxWidth: 260 }}>
      <IconTopologyStar3 size={13} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </span>
  );
  if (!href) return <Tooltip label={label} withArrow>{content}</Tooltip>;
  return (
    <Tooltip label={t('flowAttribution.openRun')} withArrow>
      <Link
        href={href}
        style={{ color: 'var(--ds-accent)', textDecoration: 'none' }}
        onClick={stopRowClick ? (event) => event.stopPropagation() : undefined}
      >
        {content}
      </Link>
    </Tooltip>
  );
}
