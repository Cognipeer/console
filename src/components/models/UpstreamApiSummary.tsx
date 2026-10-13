'use client';

import { Badge } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { resolveUpstreamApi, supportsUpstreamApiChoice } from '@/lib/services/models/upstreamApi';

interface UpstreamApiSummaryProps {
  settings: Record<string, unknown> | undefined;
  driver?: string;
}

/** The model page's statement of which OpenAI endpoint the console calls for this model. */
export default function UpstreamApiSummary({ settings, driver }: UpstreamApiSummaryProps) {
  const t = useTranslations('modelUpstreamApi');
  if (!supportsUpstreamApiChoice(driver)) return null;
  const api = resolveUpstreamApi(settings);
  return (
    <div className="ds-card ds-card-pad-lg" data-testid="model-upstream-api-summary">
      <div className="ds-h4" style={{ marginBottom: 12 }}>{t('title')}</div>
      <div className="ds-row-between" style={{ fontSize: 12.5 }}>
        <span className="ds-muted">{t('label')}</span>
        <Badge variant="light" radius="sm">{t(`option.${api}`)}</Badge>
      </div>
    </div>
  );
}
