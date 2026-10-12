'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconLock, IconUser } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { isManaged, nameProblem, profileChange, type AccountMe } from './accountModel';
import { AccountApiError, requestJson } from './accountApi';

interface ProfileCardProps {
  me: AccountMe;
  /** After the name was saved (the page reloads the account). */
  onSaved: () => void;
}

const KNOWN_ERRORS = ['directory_managed', 'invalid_body', 'rate_limited'];

/** Name (editable for local accounts), email, role and sign-in source. A directory account is read-only. */
export default function ProfileCard({ me, onSaved }: ProfileCardProps) {
  const t = useTranslations('accountPage');
  const tCommon = useTranslations('common');
  const tNotifications = useTranslations('notifications');
  const [name, setName] = useState(me.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const managed = isManaged(me);
  const provider = t(`providers.${me.authProvider}`);

  useEffect(() => setName(me.name), [me.name]);

  const change = profileChange(me, name);
  const invalid = name !== '' && nameProblem(name) !== null;

  const save = async () => {
    if (!change || saving) return;
    setSaving(true);
    setError(null);
    try {
      await requestJson('PATCH', '/api/auth/profile', change);
      notifications.show({ title: tCommon('success'), message: t('profile.saved'), color: 'green' });
      onSaved();
    } catch (err) {
      const code = err instanceof AccountApiError ? err.code : undefined;
      const message = code && KNOWN_ERRORS.includes(code) ? t(`errors.${code}`) : t('errors.generic');
      setError(message);
      notifications.show({ title: tNotifications('errorTitle'), message, color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper withBorder p="lg" radius="md" data-testid="profile-card">
      <Stack gap="md">
        <div>
          <Text fw={600}>{t('profile.title')}</Text>
          <Text size="sm" c="dimmed">
            {t('profile.hint')}
          </Text>
        </div>

        {managed ? (
          <Alert color="blue" variant="light" icon={<IconLock size={16} />} title={t('managed.title', { provider })} data-testid="managed-note">
            {t('managed.body')}
          </Alert>
        ) : null}

        <Group grow align="flex-start" wrap="wrap">
          {managed ? (
            <Tooltip label={t('managed.title', { provider })} withArrow>
              <div>
                <TextInput label={t('profile.name')} value={me.name} readOnly disabled leftSection={<IconLock size={14} />} data-testid="name-locked" />
              </div>
            </Tooltip>
          ) : (
            <TextInput
              label={t('profile.name')}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              leftSection={<IconUser size={14} />}
              error={invalid ? t('profile.nameInvalid') : undefined}
              maxLength={120}
              data-testid="name-input"
            />
          )}
          <TextInput
            label={t('profile.email')}
            value={me.email || t('profile.noEmail')}
            readOnly
            disabled
            description={managed ? undefined : t('profile.emailHint')}
            leftSection={<IconLock size={14} />}
          />
        </Group>

        <Group gap="xl" wrap="wrap">
          <div>
            <Text size="xs" c="dimmed">
              {t('profile.role')}
            </Text>
            <Badge variant="light" radius="sm" mt={4}>
              {t(`roles.${me.role}`)}
            </Badge>
            <Text size="xs" c="dimmed" mt={4}>
              {t('profile.roleHint')}
            </Text>
          </div>
          <div>
            <Text size="xs" c="dimmed">
              {t('profile.source')}
            </Text>
            <Badge variant="default" radius="sm" mt={4} tt="none">
              {provider}
            </Badge>
          </div>
        </Group>

        {error ? (
          <Text size="sm" c="red" role="alert">
            {error}
          </Text>
        ) : null}

        {!managed ? (
          <Group justify="flex-end">
            <Button loading={saving} disabled={!change} onClick={() => void save()}>
              {t('profile.save')}
            </Button>
          </Group>
        ) : null}
      </Stack>
    </Paper>
  );
}
