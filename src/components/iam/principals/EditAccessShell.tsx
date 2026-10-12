'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Group, Loader, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle, IconShieldCheck } from '@tabler/icons-react';
import FormShell, { FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { directoryApi } from './directoryApi';
import { DecisionLink, FormError } from './errors';
import {
  changedServices,
  overrideCount,
  readDraft,
  sameDraft,
  toPermissions,
  type MatrixDraft,
} from './permissionModel';
import ServicePermissionMatrix from './ServicePermissionMatrix';
import { useServiceLabels } from './serviceLabels';
import { useAccessPreview } from './useAccessPreview';
import type { UserServicePermissions } from '@/lib/security/rbac';

export interface AccessTarget {
  id: string;
  name: string;
  email: string;
  role: string;
  /** The person's own per-service overrides today. */
  servicePermissions: UserServicePermissions;
}

interface EditAccessShellProps {
  open: boolean;
  person: AccessTarget | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * A person's per-service permissions on top of their role, with the engine's own
 * answer next to the matrix: what they would be able to do (groups, project
 * limits and policies included) if this were saved.
 */
export default function EditAccessShell({ open, person, onClose, onSaved }: EditAccessShellProps) {
  const t = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const { labelOf } = useServiceLabels();
  const [draft, setDraft] = useState<MatrixDraft>(() => readDraft({}));
  const [baseline, setBaseline] = useState<MatrixDraft>(() => readDraft({}));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const personId = person?.id;
  useEffect(() => {
    if (!person) return;
    const stored = readDraft(person.servicePermissions);
    setDraft(stored);
    setBaseline(stored);
    setError(null);
    setSaving(false);
    // Re-seed only when another person is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, open]);

  const dirty = !sameDraft(draft, baseline);
  const permissions = useMemo(() => toPermissions(draft), [draft]);
  const preview = useAccessPreview(person?.id ?? null, open && dirty ? { servicePermissions: permissions } : null);
  const changed = useMemo(() => changedServices(baseline.choices, draft.choices), [baseline, draft]);

  if (!person) return null;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await directoryApi.setPermissions(person.id, permissions);
      notifications.show({ title: tCommon('success'), message: t('access.saved', { name: person.name || person.email }), color: 'green' });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const summary = (
    <>
      <SummaryGroup title={t('access.summary.person')}>
        <SummaryKV label={t('access.summary.name')} value={person.name || person.email} />
        <SummaryKV label={t('access.summary.role')} value={<Badge variant="default" radius="sm">{t(`roles.${person.role}`)}</Badge>} />
        <SummaryKV label={t('access.summary.overrides')} value={overrideCount(draft.choices)} />
      </SummaryGroup>
      <SummaryGroup title={t('access.summary.effect')}>
        {!dirty ? (
          <Text size="xs" c="dimmed">
            {t('access.summary.idle')}
          </Text>
        ) : preview.loading ? (
          <Group gap="xs" role="status">
            <Loader size="xs" />
            <Text size="xs" c="dimmed">
              {t('access.summary.loading')}
            </Text>
          </Group>
        ) : preview.error ? (
          <Group gap={6} wrap="wrap" align="baseline" data-testid="access-preview-failed">
            <Text size="xs" component="span">
              {t('access.summary.failed')}
            </Text>
            <DecisionLink error={preview.error} t={t} />
          </Group>
        ) : preview.preview ? (
          <div data-testid="access-preview">
            {preview.preview.changes.length === 0 ? (
              <Text size="xs" c="dimmed">
                {t('access.summary.noChange')}
              </Text>
            ) : (
              preview.preview.changes.map((c) => (
                <Text key={c.service} size="xs" data-testid="access-change">
                  {labelOf(c.service)}: {t(`matrix.levels.${c.from}`)} → {t(`matrix.levels.${c.to}`)}
                </Text>
              ))
            )}
          </div>
        ) : null}
      </SummaryGroup>
      <SummaryGroup title={t('access.summary.edited')}>
        {changed.length === 0 ? (
          <Text size="xs" c="dimmed">
            {t('access.summary.nothingEdited')}
          </Text>
        ) : (
          <Text size="xs">{changed.map((id) => labelOf(id)).join(', ')}</Text>
        )}
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={open}
      onClose={onClose}
      icon={<IconShieldCheck size={16} />}
      title={t('access.title', { name: person.name || person.email })}
      subtitle={t('access.subtitle')}
      summary={summary}
      disableEscape={saving}
      footerStatus={t('access.footer', { count: overrideCount(draft.choices) })}
      primaryAction={{
        label: t('access.save'),
        loading: saving,
        disabled: !dirty,
        onClick: () => void save(),
      }}
      secondaryAction={{ label: t('common.cancel'), onClick: onClose, disabled: saving }}
    >
      <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
        {t('access.note')}
      </Alert>
      <FormSection number={1} title={t('access.section')} description={t('access.sectionHint')} done={!dirty ? undefined : true}>
        <ServicePermissionMatrix draft={draft} onChange={setDraft} role={person.role} mode="person" disabled={saving} />
      </FormSection>
      {error ? <FormError error={error} t={t} /> : null}
    </FormShell>
  );
}
