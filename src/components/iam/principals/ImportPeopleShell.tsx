'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Text, Textarea } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconInfoCircle, IconUpload } from '@tabler/icons-react';
import FormShell, { ChipPicker, FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { directoryApi, type ImportSummary } from './directoryApi';
import { FormError } from './errors';

interface ImportPeopleShellProps {
  open: boolean;
  assignableRoles: readonly string[];
  onClose: () => void;
  /** After accounts were created (refresh the list). */
  onImported: (summary: ImportSummary) => void;
}

const ROLE_ORDER = ['user', 'project_admin', 'admin', 'portal_user'] as const;
type RoleValue = (typeof ROLE_ORDER)[number];

/** Rows of the CSV the file will be read from (the first line may be a header). */
export function countCsvRows(csv: string): number {
  return csv.split(/\r?\n/).filter((line) => line.trim() !== '').length;
}

/**
 * Bulk import of SERVICE ACCOUNTS from a CSV: people who will never open the
 * console and only need an identity so their gateway usage has a name on it.
 * They cannot sign in, nothing is emailed, and a row that cannot be read is
 * reported back rather than dropped silently.
 */
export default function ImportPeopleShell({ open, assignableRoles, onClose, onImported }: ImportPeopleShellProps) {
  const t = useTranslations('iamDirectory');
  const [csv, setCsv] = useState('');
  const [role, setRole] = useState<RoleValue>('user');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  useEffect(() => {
    if (open) return;
    setCsv('');
    setRole('user');
    setBusy(false);
    setError(null);
    setSummary(null);
  }, [open]);

  const roles = ROLE_ORDER.filter((r) => assignableRoles.includes(r));
  useEffect(() => {
    if (roles.length > 0 && !roles.includes(role)) setRole(roles[0]);
  }, [roles, role]);

  const rows = countCsvRows(csv);
  const submit = async () => {
    if (!csv.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await directoryApi.bulkImport({ csv, role });
      setSummary(result);
      onImported(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (summary) {
    return (
      <FormShell
        open={open}
        onClose={onClose}
        icon={<IconUpload size={16} />}
        title={t('import.doneTitle')}
        subtitle={t('import.doneSubtitle')}
        summary={
          <SummaryGroup title={t('import.result')}>
            <SummaryKV label={t('import.created')} value={summary.createdCount} />
            <SummaryKV label={t('import.skipped')} value={summary.skippedExisting.length} />
            <SummaryKV label={t('import.invalid')} value={summary.invalidCount} />
          </SummaryGroup>
        }
        primaryAction={{ label: t('invite.done'), color: 'teal', onClick: onClose }}
        secondaryAction={{ label: t('common.close'), onClick: onClose }}
      >
        <FormSection number={1} title={t('import.createdTitle', { count: summary.createdCount })} done>
          <Alert color="teal" icon={<IconCheck size={16} />} data-testid="import-created">
            {t('import.createdBody', { count: summary.createdCount })}
          </Alert>
          {summary.skippedExisting.length > 0 ? (
            <Text size="sm" c="dimmed" mt="xs">
              {t('import.skippedBody', { count: summary.skippedExisting.length })}
            </Text>
          ) : null}
        </FormSection>
        {summary.halted ? (
          <Alert color="orange" icon={<IconAlertTriangle size={16} />} title={t('import.haltedTitle')} data-testid="import-halted">
            {t('import.haltedBody')}
          </Alert>
        ) : null}
        {summary.invalidCount > 0 ? (
          <Alert color="orange" icon={<IconAlertTriangle size={16} />} title={t('import.invalidTitle', { count: summary.invalidCount })} data-testid="import-invalid">
            <Text size="xs" style={{ fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap' }}>
              {summary.invalid.join('\n')}
            </Text>
          </Alert>
        ) : null}
      </FormShell>
    );
  }

  return (
    <FormShell
      open={open}
      onClose={onClose}
      icon={<IconUpload size={16} />}
      title={t('import.title')}
      subtitle={t('import.subtitle')}
      disableEscape={busy}
      summary={
        <SummaryGroup title={t('import.summary')}>
          <SummaryKV label={t('import.rows')} value={rows} />
          <SummaryKV label={t('import.role')} value={t(`roles.${role}`)} />
          <SummaryKV label={t('import.type')} value={<span className="ds-badge">{t('badges.kinds.service')}</span>} />
        </SummaryGroup>
      }
      primaryAction={{
        label: t('import.submit'),
        loading: busy,
        disabled: !csv.trim() || roles.length === 0,
        onClick: () => void submit(),
      }}
      secondaryAction={{ label: t('common.cancel'), onClick: onClose, disabled: busy }}
    >
      <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
        {t('import.note')}
      </Alert>
      <FormSection number={1} title={t('import.fileSection')} description={t('import.fileHint')} done={Boolean(csv.trim())}>
        <Textarea
          value={csv}
          onChange={(e) => setCsv(e.currentTarget.value)}
          placeholder={'email,name\nayse@firma.com,"Yılmaz, Ayşe"\nmehmet@firma.com,Mehmet Demir'}
          aria-label={t('import.fileSection')}
          autosize
          minRows={9}
          maxRows={18}
          styles={{ input: { fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 12.5 } }}
        />
        <Button variant="light" component="label" mt="sm" leftSection={<IconUpload size={14} />} style={{ alignSelf: 'flex-start' }}>
          {t('import.chooseFile')}
          <input
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            hidden
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file) void file.text().then(setCsv);
            }}
          />
        </Button>
      </FormSection>
      <FormSection number={2} title={t('import.roleSection')} description={t('import.roleHint')} done={roles.includes(role)}>
        <ChipPicker<RoleValue>
          options={roles.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
          value={role}
          onChange={(v) => setRole(v as RoleValue)}
        />
      </FormSection>
      {error ? <FormError error={error} t={t} /> : null}
    </FormShell>
  );
}
