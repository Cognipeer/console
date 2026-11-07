'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { Button } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { GetStartedStep } from './overviewModel';

/** Browser-local, like the launcher's pins and recents. */
const HIDDEN_KEY = 'cgn:overview:get-started-hidden';

/**
 * Whether the person hid the "Get started" card in this browser. Reads as hidden until local storage has been
 * read, so a hidden card does not flash on the first render.
 */
export function useGetStartedHidden(): [boolean, () => void] {
  const [hidden, setHidden] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(HIDDEN_KEY) === '1');
    } catch {
      setHidden(false);
    }
  }, []);
  const hide = useCallback(() => {
    setHidden(true);
    try {
      window.localStorage.setItem(HIDDEN_KEY, '1');
    } catch {
      // Storage blocked: hidden for this visit only.
    }
  }, []);
  return [hidden !== false, hide];
}

const MARK_STYLE: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: '50%',
  display: 'grid',
  placeItems: 'center',
  fontSize: 12,
  fontWeight: 600,
  flexShrink: 0,
};

/**
 * "Get started": the first steps of the project, ticked from what it already has (see `getStartedSteps`). The
 * caller decides whether the card is shown: it is left out once every step that is not optional is done, or when
 * the person hid it.
 */
export function GetStarted({
  steps,
  onHide,
  style,
}: {
  steps: readonly GetStartedStep[];
  onHide: () => void;
  style?: CSSProperties;
}) {
  const t = useTranslations('dashboardOverview.getStarted');
  const locale = useLocale();
  if (steps.length === 0) return null;
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done);
  return (
    <section className="ds-card ds-card-pad-lg" data-testid="get-started" lang={locale} style={style}>
      <div className="ds-row-between" style={{ marginBottom: 12 }}>
        <div>
          <div className="ds-h3">{t('title')}</div>
          <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
            {t('progress', { done, total: steps.length })}
          </div>
        </div>
        <Button variant="subtle" size="xs" color="gray" onClick={onHide}>
          {t('hide')}
        </Button>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {steps.map((step, index) => (
          <li
            key={step.id}
            data-step={step.id}
            data-done={step.done || undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              border: '1px solid var(--ds-border-soft)',
              borderRadius: 'var(--ds-r-sm)',
              background: step === next ? 'var(--ds-surface-1)' : 'transparent',
            }}
          >
            <span
              aria-hidden
              style={{
                ...MARK_STYLE,
                background: step.done ? 'var(--ds-accent-soft)' : 'var(--ds-surface-2)',
                color: step.done ? 'var(--ds-accent)' : 'var(--ds-text-muted)',
              }}
            >
              {step.done ? <IconCheck size={14} stroke={2} /> : index + 1}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500 }} className={step.done ? 'ds-muted' : undefined}>
                {t(`steps.${step.id}.title`)}
                {step.optional ? (
                  <span className="ds-faint" style={{ fontWeight: 400, fontSize: 12 }}>
                    {' '}
                    · {t('optional')}
                  </span>
                ) : null}
              </div>
              <div className="ds-muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
                {t(`steps.${step.id}.description`)}
              </div>
            </div>
            {step.done ? (
              <span className="ds-faint" style={{ fontSize: 12, flexShrink: 0 }}>
                {t('done')}
              </span>
            ) : (
              <Button
                component={Link}
                href={step.href}
                size="xs"
                variant={step === next ? 'filled' : 'default'}
                color={step === next ? 'teal' : undefined}
                style={{ flexShrink: 0 }}
              >
                {t(`steps.${step.id}.action`)}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
