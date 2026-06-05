'use client';

import Image from 'next/image';
import { ReactNode } from 'react';

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

interface AuthShellProps {
  title: ReactNode;
  subtitle: ReactNode;
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
  eyebrow,
  brand = DEFAULT_BRAND,
  highlights,
  children,
  footer,
}: AuthShellProps) {
  return (
    <div className="auth-page">
      <div className="auth-glow auth-glow-a" aria-hidden="true" />
      <div className="auth-glow auth-glow-b" aria-hidden="true" />
      <div className="auth-shell">
        <section className="auth-intro">
          {brand ? <div className="auth-brand">{brand}</div> : null}
          {eyebrow ? <div className="ds-eyebrow">{eyebrow}</div> : null}
          <h1 className="auth-title">{title}</h1>
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
