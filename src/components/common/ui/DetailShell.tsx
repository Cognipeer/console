'use client';

import { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ActionIcon, Tooltip } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import PageContainer from './PageContainer';
import TabsBar, { type TabsBarItem } from './TabsBar';

export interface DetailShellTab extends TabsBarItem {
  id: string;
}

export interface DetailShellProps {
  /** Optional href for the back chevron. Falls back to router.back(). */
  backHref?: string;
  /** Back-button tooltip. */
  backLabel?: string;
  /** Icon shown in the colored badge. */
  icon?: ReactNode;
  /** Main title + chips beside it. */
  title: ReactNode;
  /** Inline meta row (provider, model id, updated time, etc). */
  meta?: ReactNode;
  /** Right-side actions (buttons, kebab menu, etc). */
  actions?: ReactNode;
  /** Tab list. */
  tabs?: DetailShellTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  /** Body content. Two-column or single-column. */
  children: ReactNode;
}

export default function DetailShell({
  backHref,
  backLabel = 'Back',
  icon,
  title,
  meta,
  actions,
  tabs,
  activeTab,
  onTabChange,
  children,
}: DetailShellProps) {
  const router = useRouter();
  const handleBack = () => {
    if (backHref) router.push(backHref);
    else router.back();
  };

  return (
    <PageContainer>
      <header className="detail-header">
        <Tooltip label={backLabel} withArrow>
          {backHref ? (
            <ActionIcon
              component={Link}
              href={backHref}
              variant="default"
              radius="md"
              size="lg"
              aria-label={backLabel}
              className="detail-back"
            >
              <IconArrowLeft size={15} stroke={1.7} />
            </ActionIcon>
          ) : (
            <ActionIcon
              onClick={handleBack}
              variant="default"
              radius="md"
              size="lg"
              aria-label={backLabel}
              className="detail-back"
            >
              <IconArrowLeft size={15} stroke={1.7} />
            </ActionIcon>
          )}
        </Tooltip>
        {icon ? <div className="detail-icon">{icon}</div> : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="detail-title-row">{title}</div>
          {meta ? <div className="detail-meta-row">{meta}</div> : null}
        </div>
        {actions ? (
          <div className="ds-row ds-gap-sm" style={{ flexShrink: 0 }}>
            {actions}
          </div>
        ) : null}
      </header>

      {tabs && tabs.length > 0 && activeTab !== undefined && onTabChange ? (
        <TabsBar items={tabs} activeId={activeTab} onChange={onTabChange} />
      ) : null}

      {children}
    </PageContainer>
  );
}

/* Layout helpers for the body content */

export function DetailTwoCol({
  children,
  narrowAside = false,
}: {
  children: ReactNode;
  narrowAside?: boolean;
}) {
  return (
    <div className={`detail-grid ${narrowAside ? 'narrow-aside' : ''}`}>
      {children}
    </div>
  );
}

export function DetailCard({
  title,
  description,
  actions,
  children,
  danger = false,
  pad = 'lg',
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  danger?: boolean;
  pad?: 'sm' | 'md' | 'lg';
}) {
  const padClass =
    pad === 'sm'
      ? 'ds-card-pad-sm'
      : pad === 'lg'
        ? 'ds-card-pad-lg'
        : 'ds-card-pad';
  return (
    <div
      className={`ds-card ${padClass}`}
      style={danger ? { borderColor: 'rgba(201, 59, 59, 0.2)' } : undefined}
    >
      {title || actions ? (
        <div className="ds-row-between" style={{ marginBottom: description ? 4 : 12 }}>
          {title ? (
            <div
              className="ds-h3"
              style={danger ? { color: 'var(--ds-err)' } : undefined}
            >
              {title}
            </div>
          ) : null}
          {actions}
        </div>
      ) : null}
      {description ? (
        <div className="ds-muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
          {description}
        </div>
      ) : null}
      {children}
    </div>
  );
}
