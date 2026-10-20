'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Alert, Anchor, Button } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconTrash } from '@tabler/icons-react';
import { DetailCard } from '@/components/common/ui/DetailShell';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { BucketDetail } from '../filesApi';
import { formatCount } from '../shared';
import DeleteBucketDialog from './DeleteBucketDialog';
import { agentFilesHref, deleteErrorOf, deleteRules } from './settingsModel';
import styles from './bucket.module.css';

/**
 * Danger zone: delete the bucket, and with it (the person's explicit choice, asked in the dialog) the files it holds
 * in the storage provider. When an agent keeps its session files here the deletion is blocked and the agents are
 * listed with a link to where they choose another bucket.
 */
export default function SettingsDangerCard({ bucket }: { bucket: BucketDetail }) {
  const t = useTranslations('files.bucket');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const rules = deleteRules(bucket);
  const lastError = deleteErrorOf(bucket);
  const providerName = bucket.provider?.label?.trim() || bucket.providerKey;

  const description =
    rules.fileCount === 0
      ? t('danger.descriptionEmpty')
      : rules.fileCount === 1
        ? t('danger.descriptionOne', { provider: providerName })
        : t('danger.descriptionMany', { count: formatCount(rules.fileCount, locale), provider: providerName });

  return (
    <DetailCard title={t('danger.title')} description={description} danger>
      {lastError && !rules.deleting ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} role="alert" mb="sm">
          {t('danger.lastFailed', { reason: lastError })}
        </Alert>
      ) : null}
      {rules.deleting ? (
        <Alert color="blue" icon={<IconInfoCircle size={16} />} role="status" mb="sm">
          {t('danger.inProgress')}
        </Alert>
      ) : null}
      {rules.blocked ? (
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />} role="note" mb="sm">
          <div>{t('danger.usedBy')}</div>
          <ul className={styles.agentList} aria-label={t('delete.agentsLabel')}>
            {rules.agents.map((agent) => (
              <li key={agent.agentId}>
                <Anchor component={Link} href={agentFilesHref(agent)} size="sm">
                  {agent.name}
                </Anchor>
                <span className="ds-faint ds-mono">{` · ${agent.agentKey}`}</span>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6 }}>{t('danger.chooseAnother')}</div>
        </Alert>
      ) : null}
      <Button
        color="red"
        variant="light"
        size="xs"
        disabled={rules.blocked || rules.deleting}
        // The page theme paints every light button in the accent colour; a destructive one keeps red.
        style={{ background: 'var(--mantine-color-red-light)', color: 'var(--ds-err-text)' }}
        leftSection={<IconTrash size={13} stroke={1.7} />}
        onClick={() => setOpen(true)}
      >
        {t('danger.button')}
      </Button>
      <DeleteBucketDialog bucket={bucket} opened={open} onClose={() => setOpen(false)} />
    </DetailCard>
  );
}
