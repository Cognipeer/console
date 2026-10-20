'use client';

import type { ReactNode } from 'react';
import { Text } from '@mantine/core';

export interface ListStateCardProps {
  /** `error` tints the icon and announces the card to assistive technology. */
  tone?: 'neutral' | 'error';
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  /** The actions under the text (a button, a link, a note). */
  children?: ReactNode;
}

/**
 * A whole-list state that replaces the table: the list could not be loaded, there is nothing to list yet, or
 * there is nothing to list it on. Same look as a DataGrid's empty view, without a toolbar that has nothing to filter.
 */
export default function ListStateCard({ tone = 'neutral', icon, title, description, children }: ListStateCardProps) {
  const isError = tone === 'error';
  return (
    <div className="ds-card" role={isError ? 'alert' : undefined}>
      <div className="ds-empty">
        <div
          className="ds-empty-icon"
          aria-hidden="true"
          style={isError ? { background: 'rgba(201, 59, 59, 0.12)', color: 'var(--ds-err)' } : undefined}
        >
          {icon}
        </div>
        <h2 className="ds-h4" style={{ margin: '0 0 4px' }}>
          {title}
        </h2>
        {description ? (
          <Text size="sm" c="dimmed" mb="md" maw={460} ta="center">
            {description}
          </Text>
        ) : null}
        {children}
      </div>
    </div>
  );
}
