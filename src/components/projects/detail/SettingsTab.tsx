'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle, IconTrash } from '@tabler/icons-react';
import ConfirmModal from '@/components/common/ui/ConfirmModal';
import { DetailCard } from '@/components/common/ui/DetailShell';
import { FormField, FormRow } from '@/components/common/ui/FormShell';
import { notifyActiveProjectChanged } from '@/components/layout/useEffectivePermissions';
import { useLocale, useTranslations } from '@/lib/i18n';

export interface ProjectSummary {
  _id: string;
  name: string;
  key: string;
  description?: string;
  createdAt?: string;
}

interface SettingsTabProps {
  project: ProjectSummary;
  /** Tenant owners and admins: the only people who can edit or delete a project. */
  canManage: boolean;
  /** Where to go after deleting (the stored list URL). */
  backHref: string;
  /** The project changed on the server: reload it. */
  onSaved: () => void;
}

const DEFAULT_PROJECT_KEY = 'default';

const failure = async (res: Response, fallback: string): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || fallback;
};

export default function SettingsTab({ project, canManage, backHref, onSaved }: SettingsTabProps) {
  const t = useTranslations('projectsAccess.settings');
  const locale = useLocale();
  const router = useRouter();

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);

  // The saved project changed (a reload after saving, or a switch to another project).
  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? '');
  }, [project._id, project.name, project.description]);

  const dirty = name.trim() !== project.name || description.trim() !== (project.description ?? '');
  const nameValid = name.trim().length >= 2;
  const isDefault = project.key === DEFAULT_PROJECT_KEY;

  const save = async () => {
    if (!canManage || saving || !dirty || !nameValid) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project._id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      });
      if (!res.ok) throw new Error(await failure(res, t('saveFailed')));
      notifications.show({ color: 'green', message: t('saved') });
      onSaved();
    } catch (err) {
      notifications.show({ color: 'red', title: t('saveFailed'), message: err instanceof Error ? err.message : '' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (deleting || typed.trim() !== project.name) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project._id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await failure(res, t('danger.failed')));
      notifications.show({ color: 'green', message: t('danger.deleted') });
      notifyActiveProjectChanged();
      router.push(backHref);
    } catch (err) {
      notifications.show({ color: 'red', title: t('danger.failed'), message: err instanceof Error ? err.message : '' });
      setDeleting(false);
    }
  };

  const created = project.createdAt ? new Date(project.createdAt) : null;

  return (
    <Stack gap="md">
      {!canManage ? (
        <Alert color="gray" icon={<IconInfoCircle size={16} />}>
          {t('readOnly')}
        </Alert>
      ) : null}

      <DetailCard title={t('title')} description={t('description')}>
        <FormRow cols={1}>
          <FormField label={t('name')} required>
            <TextInput
              aria-label={t('name')}
              value={name}
              disabled={!canManage}
              error={canManage && !nameValid ? t('nameTooShort') : undefined}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label={t('descriptionLabel')} optional>
            <Textarea
              aria-label={t('descriptionLabel')}
              minRows={3}
              value={description}
              disabled={!canManage}
              onChange={(e) => setDescription(e.currentTarget.value)}
            />
          </FormField>
        </FormRow>
        <FormRow cols={2}>
          <FormField label={t('key')}>
            <TextInput aria-label={t('key')} value={project.key} readOnly disabled className="ds-mono" />
          </FormField>
          <FormField label={t('created')}>
            <TextInput
              aria-label={t('created')}
              value={created && !Number.isNaN(created.getTime()) ? created.toLocaleString(locale) : '—'}
              readOnly
              disabled
            />
          </FormField>
        </FormRow>
        {canManage ? (
          <div style={{ marginTop: 12 }}>
            <Button color="teal" size="xs" loading={saving} disabled={!dirty || !nameValid} onClick={() => void save()}>
              {t('save')}
            </Button>
          </div>
        ) : null}
      </DetailCard>

      {canManage ? (
        <DetailCard title={t('danger.title')} description={t('danger.description')} danger>
          {isDefault ? (
            <Text size="sm" c="dimmed">
              {t('danger.defaultProject')}
            </Text>
          ) : (
            <Button
              color="red"
              variant="light"
              size="xs"
              leftSection={<IconTrash size={13} stroke={1.7} />}
              onClick={() => {
                setTyped('');
                setConfirmOpen(true);
              }}
            >
              {t('danger.button')}
            </Button>
          )}
        </DetailCard>
      ) : null}

      <ConfirmModal
        opened={confirmOpen}
        title={t('danger.confirmTitle', { name: project.name })}
        message={
          <Stack gap="xs">
            <span>{t('danger.confirmBody')}</span>
            <TextInput
              aria-label={t('danger.confirmLabel')}
              placeholder={t('danger.confirmPlaceholder', { name: project.name })}
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              data-autofocus
            />
          </Stack>
        }
        confirmLabel={t('danger.confirmButton')}
        cancelLabel={t('danger.cancel')}
        loading={deleting}
        confirmDisabled={typed.trim() !== project.name}
        onConfirm={() => void remove()}
        onClose={() => {
          if (!deleting) setConfirmOpen(false);
        }}
      />
    </Stack>
  );
}
