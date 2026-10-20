'use client';

import { VisuallyHidden } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { ProviderTestStep } from './providerAccessModel';

/** The steps the file drivers report; anything else is shown by its own name. */
const KNOWN_STEPS = new Set(['list', 'write', 'read', 'delete']);

export interface ProviderTestStepsProps {
  steps?: readonly ProviderTestStep[] | null;
}

/**
 * The steps a connection check ran, in order, each with how it ended ("List", "Write test object", "Read back",
 * "Delete"). A step after a failed one did not run and is not listed. Renders nothing for a test without steps.
 */
export default function ProviderTestSteps({ steps }: ProviderTestStepsProps) {
  const t = useTranslations('providerAccess');
  if (!steps || steps.length === 0) return null;

  return (
    <ul
      aria-label={t('test.stepsLabel')}
      style={{
        listStyle: 'none',
        margin: '10px 0 0',
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 12.5,
      }}
    >
      {steps.map((entry) => (
        <li
          key={entry.step}
          data-step={entry.step}
          data-ok={entry.ok ? 'true' : 'false'}
          style={{ display: 'flex', gap: 6, alignItems: 'baseline', wordBreak: 'break-word' }}
        >
          <span
            aria-hidden="true"
            style={{ display: 'inline-flex', flexShrink: 0, color: entry.ok ? 'var(--ds-ok)' : 'var(--ds-err)' }}
          >
            {entry.ok ? <IconCheck size={12} stroke={2.4} /> : <IconX size={12} stroke={2.4} />}
          </span>
          <VisuallyHidden>{entry.ok ? t('test.stepPassed') : t('test.stepFailed')}</VisuallyHidden>
          <span>
            <span style={{ fontWeight: 500 }}>
              {KNOWN_STEPS.has(entry.step) ? t(`test.steps.${entry.step}`) : entry.step}
            </span>
            {entry.message ? <span className="ds-muted">{` — ${entry.message}`}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
