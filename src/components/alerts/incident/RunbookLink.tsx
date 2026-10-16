'use client';

import { IconExternalLink } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { externalHost, safeExternalUrl } from './incidentModel';

/** The rule's runbook, as an external link that is only rendered for a plain http(s) address. */
export default function RunbookLink({ url }: { url: string | null | undefined }) {
  const t = useTranslations('incidents');
  const href = safeExternalUrl(url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {t('ux.runbook.open')} <span className="ds-faint">({externalHost(href)})</span>
      <IconExternalLink size={13} aria-hidden="true" />
    </a>
  );
}
