'use client';

import { ReactNode } from 'react';

interface PageContainerProps {
  children: ReactNode;
  className?: string;
}

export default function PageContainer({ children, className }: PageContainerProps) {
  return <div className={`ds-page ${className ?? ''}`}>{children}</div>;
}

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, eyebrow, actions }: PageHeaderProps) {
  return (
    <header className="ds-page-header">
      <div>
        {eyebrow ? <div className="ds-eyebrow" style={{ marginBottom: 4 }}>{eyebrow}</div> : null}
        <h1 className="ds-h1">{title}</h1>
        {subtitle ? (
          <p className="ds-muted" style={{ marginTop: 4, fontSize: 13.5, maxWidth: 720 }}>
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? <div className="ds-row ds-gap-sm" style={{ flexShrink: 0 }}>{actions}</div> : null}
    </header>
  );
}
