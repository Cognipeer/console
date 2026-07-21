'use client';

import Image from 'next/image';
import { ReactNode } from 'react';
import { useTranslations } from '@/lib/i18n';

const DEFAULT_BRAND = (
  <>
    <Image
      src="/images/cognipeer-icon.png"
      alt=""
      width={28}
      height={28}
      className="auth-brand-icon"
      priority
    />
    <Image
      src="/images/cognipeer-logo-d.png"
      alt="Cognipeer"
      width={148}
      height={32}
      className="auth-brand-wordmark"
      priority
    />
  </>
);

function renderTitle(title: ReactNode, accent?: string): ReactNode {
  if (typeof title !== 'string' || !accent) {
    return title;
  }
  const index = title.indexOf(accent);
  if (index === -1) {
    return title;
  }
  return (
    <>
      {title.slice(0, index)}
      <span className="auth-title-accent">{accent}</span>
      {title.slice(index + accent.length)}
    </>
  );
}

interface AuthShellProps {
  title: ReactNode;
  subtitle: ReactNode;
  /** Single word of `title` rendered in accent teal (string titles only). */
  titleAccent?: string;
  eyebrow?: ReactNode;
  /** Optional brand badge text (defaults to "Cognipeer Console"). */
  brand?: ReactNode;
  /** Optional highlight bullets in the intro pane (max ~4). */
  highlights?: Array<{ icon?: ReactNode; label: ReactNode }>;
  children: ReactNode;
  /** Footer rendered under the form panel (e.g. sign-up link). */
  footer?: ReactNode;
}

export default function AuthShell({
  title,
  subtitle,
  titleAccent,
  eyebrow,
  brand = DEFAULT_BRAND,
  highlights,
  children,
  footer,
}: AuthShellProps) {
  const t = useTranslations('auth');
  const eyebrowContent = eyebrow ?? t('eyebrow');
  return (
    <div className="auth-page">
      <div className="auth-glow auth-glow-a" aria-hidden="true" />
      <div className="auth-glow auth-glow-b" aria-hidden="true" />
      <div className="auth-shell">
        <section className="auth-intro">
          {brand ? <div className="auth-brand">{brand}</div> : null}
          {eyebrowContent ? <div className="ds-eyebrow">{eyebrowContent}</div> : null}
          <h1 className="auth-title">{renderTitle(title, titleAccent)}</h1>
          <p className="auth-subtitle">{subtitle}</p>
          {highlights && highlights.length > 0 ? (
            <ul className="auth-highlights">
              {highlights.map((h, i) => (
                <li key={i}>
                  {h.icon ? <span className="auth-highlight-icon">{h.icon}</span> : null}
                  <span>{h.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="auth-panel">
          <div className="auth-panel-body">{children}</div>
          {footer ? <div className="auth-panel-footer">{footer}</div> : null}
        </section>
      </div>
    </div>
  );
}
