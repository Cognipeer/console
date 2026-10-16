'use client';

import { useState } from 'react';
import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlayerPlay } from '@tabler/icons-react';
import { DetailCard } from '@/components/common/ui/DetailShell';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  formatLatency,
  formatRelativeTime,
  testState,
  type ProviderTestResult,
  type StoredProviderTest,
} from './providerAccessModel';

export interface ProviderConnectionCardProps {
  providerId: string;
  /** `null`/absent: never tested, or the connection changed since the last test. */
  lastTest?: StoredProviderTest | null;
  /** Owners and admins only: the test endpoint is admin-gated. */
  canTest: boolean;
  /** Called after a re-test was stored, so the page reloads the provider. */
  onTested: () => void | Promise<void>;
}

/** Connection card of the provider detail page: last test, latency, found deployments, Re-test. */
export default function ProviderConnectionCard({
  providerId,
  lastTest,
  canTest,
  onTested,
}: ProviderConnectionCardProps) {
  const t = useTranslations('providerAccess');
  const locale = useLocale();
  const [testing, setTesting] = useState(false);

  const retest = async () => {
    setTesting(true);
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/test`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => null)) as (ProviderTestResult & { error?: string }) | null;
      if (!res.ok) throw new Error(body?.error || t('test.requestFailed'));
      await onTested();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: t('detail.connection'),
        message: error instanceof Error ? error.message : t('test.requestFailed'),
      });
    } finally {
      setTesting(false);
    }
  };

  const state = lastTest ? testState(lastTest) : null;

  return (
    <DetailCard
      title={t('detail.connection')}
      description={t('detail.connectionDescription')}
      actions={
        canTest ? (
          <Button
            variant="default"
            size="xs"
            leftSection={<IconPlayerPlay size={13} stroke={1.7} />}
            loading={testing}
            onClick={() => void retest()}
          >
            {lastTest ? t('test.retest') : t('test.button')}
          </Button>
        ) : undefined
      }
    >
      {lastTest && state ? (
        <div className="ds-tbl-wrap">
          <table className="ds-tbl">
            <tbody>
              <ConnectionRow
                label={t('detail.result')}
                value={
                  <span
                    className={`ds-badge ${
                      state === 'ok' ? 'ds-badge-ok' : state === 'failed' ? 'ds-badge-err' : 'ds-badge-warn'
                    }`}
                  >
                    {t(`test.${state}`)}
                  </span>
                }
              />
              <ConnectionRow
                label={t('detail.lastTest')}
                value={formatRelativeTime(lastTest.at, locale) || '—'}
              />
              {state !== 'unsupported' ? (
                <ConnectionRow label={t('detail.latency')} value={formatLatency(lastTest.latencyMs)} />
              ) : null}
              {lastTest.deployments !== undefined ? (
                <ConnectionRow label={t('detail.deployments')} value={String(lastTest.deployments)} />
              ) : null}
              {lastTest.message ? (
                <ConnectionRow label="" value={lastTest.message} />
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="ds-empty" style={{ padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{t('detail.neverTested')}</div>
          <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            {t('detail.neverTestedHint')}
          </div>
        </div>
      )}
    </DetailCard>
  );
}

function ConnectionRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr>
      <td style={{ width: '40%', verticalAlign: 'top' }}>
        <span className="ds-muted" style={{ fontSize: 12.5 }}>
          {label}
        </span>
      </td>
      <td style={{ verticalAlign: 'top' }}>
        <span style={{ fontSize: 12.5, wordBreak: 'break-word' }}>{value}</span>
      </td>
    </tr>
  );
}
