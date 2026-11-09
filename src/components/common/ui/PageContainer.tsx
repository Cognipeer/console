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
      {/* Beside the title while they fit; on their own line they wrap at the header's width instead of running
          past the screen edge (a narrow window or a phone). */}
      {actions ? <div className="ds-row ds-gap-sm" style={{ flexShrink: 0, maxWidth: '100%' }}>{actions}</div> : null}
    </header>
  );
}
