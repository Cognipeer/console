'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@mantine/core';
import { IconEdit, IconExternalLink } from '@tabler/icons-react';
import { DetailCard } from '@/components/common/ui/DetailShell';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import type { WebSearchProviderSummary } from '@/lib/services/webSearch/webSearchInstanceView';
import { allFields } from '@/components/providers/providerFormModel';
import { useInstanceOptionsForm } from './useInstanceOptionsForm';
import { optionRows } from './webSearchModel';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ds-row-between">
      <span className="ds-muted">{label}</span>
      {children}
    </div>
  );
}

/**
 * The search options an instance sets, labelled by the form they are edited with. A platform instance's options are
 * the deployment's: the reply leaves them out, so the card names the options and says who sets them.
 */
export function SearchOptionsCard({
  provider,
  settings,
  setByPlatform = false,
  onEdit,
}: {
  provider: WebSearchProviderSummary | null;
  settings: Record<string, unknown>;
  setByPlatform?: boolean;
  /** Set for someone who may change the instance. */
  onEdit?: () => void;
}) {
  const t = useTranslations('webSearch.detail');
  const { form } = useInstanceOptionsForm(provider, true);
  const rows = setByPlatform ? [] : optionRows(form, settings);
  const names = allFields(form).map((field) => field.label);

  return (
    <DetailCard
      title={t('optionsTitle')}
      description={t('optionsDescription')}
      actions={onEdit ? (
        <Button variant="default" size="xs" leftSection={<IconEdit size={13} stroke={1.7} />} onClick={onEdit}>
          {t('optionsEdit')}
        </Button>
      ) : undefined}
    >
      <div className="ds-col" style={{ gap: 8, fontSize: 13 }}>
        {setByPlatform ? (
          <span className="ds-faint">
            {names.length > 0 ? t('optionsPlatformList', { options: names.join(', ') }) : t('optionsPlatform')}
          </span>
        ) : null}
        {!setByPlatform && rows.length === 0 ? <span className="ds-faint">{t('optionsDefault')}</span> : null}
        {rows.map((row) => (
          <Row key={row.name} label={row.label}>
            <span className="ds-mono">{row.value}</span>
          </Row>
        ))}
      </div>
    </DetailCard>
  );
}

/** The `_id` of a project provider, for a link to its page (null until found, or when `key` is null). */
function useProviderId(key: string | null): string | null {
  const [found, setFound] = useState<{ key: string; id: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/providers?type=websearch', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { providers?: Array<{ _id?: string; key: string }> };
        const match = body.providers?.find((candidate) => candidate.key === key);
        if (!cancelled && match?._id) setFound({ key, id: String(match._id) });
      } catch {
        // No link then: the card still names the provider.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);
  return found && found.key === key ? found.id : null;
}

/**
 * The provider an instance searches through: a summary, never its credentials or connection settings. Owners and
 * admins get a link to the provider's page, where the connection is edited; a platform provider has none.
 */
export function ConnectionCard({
  providerKey,
  provider,
  canOpenProvider,
  scope,
}: {
  providerKey: string;
  provider: WebSearchProviderSummary | null;
  canOpenProvider: boolean;
  /** Where the instance is visible (an instance page; a provider without an instance has none). */
  scope?: string;
}) {
  const t = useTranslations('webSearch.detail');
  const tPlatform = useTranslations('webSearch.platform');
  const providerId = useProviderId(canOpenProvider && provider && !provider.platform ? providerKey : null);

  return (
    <DetailCard
      title={t('connectionTitle')}
      description={t('connectionDescription')}
      actions={providerId ? (
        <Button
          component={Link}
          href={`/dashboard/providers/${encodeURIComponent(providerId)}`}
          variant="default"
          size="xs"
          leftSection={<IconExternalLink size={13} stroke={1.7} />}
        >
          {t('openProvider')}
        </Button>
      ) : undefined}
    >
      <div className="ds-col" style={{ gap: 8, fontSize: 13 }}>
        {provider ? (
          <>
            <Row label={t('provider')}>
              <span className="ds-row" style={{ gap: 6 }}>
                <span>{provider.label}</span>
                <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{provider.key}</span>
                {provider.platform ? <span className="ds-badge ds-badge-info">{tPlatform('badge')}</span> : null}
              </span>
            </Row>
            <Row label={t('engine')}>
              <span className="ds-badge">{provider.driver}</span>
            </Row>
            <Row label={t('providerStatus')}>
              <StatusBadge status={provider.status === 'active' ? 'active' : 'paused'} />
            </Row>
          </>
        ) : (
          <>
            <Row label={t('provider')}>
              <span className="ds-mono">{providerKey}</span>
            </Row>
            <span className="ds-badge ds-badge-warn" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>
              {t('providerMissing')}
            </span>
          </>
        )}
        {scope ? (
          <Row label={t('scope')}>
            <span>{scope}</span>
          </Row>
        ) : null}
      </div>
    </DetailCard>
  );
}
