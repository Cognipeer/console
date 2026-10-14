'use client';

import { useState } from 'react';
import { Alert, Button, Group, List, Paper, PasswordInput, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconCircle, IconLock } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { AccountApiError, requestJson } from './accountApi';
import { PASSWORD_RULES, passwordIssue, passwordProblems, passwordUnavailable, type AccountMe, type PasswordForm } from './accountModel';

const EMPTY: PasswordForm = { current: '', next: '', confirm: '' };

/**
 * Change the signed-in person's own password. Offered to local accounts that can
 * sign in; a directory account is told where its password lives and a service
 * account that it has none.
 */
export default function PasswordCard({ me }: { me: AccountMe }) {
  const t = useTranslations('accountPage');
  const tCommon = useTranslations('common');
  const tNotifications = useTranslations('notifications');
  const [form, setForm] = useState<PasswordForm>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unavailable = passwordUnavailable(me);
  if (unavailable) {
    return (
      <Paper withBorder p="lg" radius="md" data-testid="password-card">
        <Stack gap="sm">
          <Text fw={600}>{t('password.title')}</Text>
          <Alert
            color="blue"
            variant="light"
            icon={<IconLock size={16} />}
            title={t(unavailable === 'managed' ? 'password.managedTitle' : 'password.serviceTitle')}
            data-testid={`password-${unavailable}`}
          >
            {unavailable === 'managed'
              ? t('password.managedBody', { provider: t(`providers.${me.authProvider}`) })
              : t('password.serviceBody')}
          </Alert>
        </Stack>
      </Paper>
    );
  }

  const issue = passwordIssue(form);
  const missing = new Set(passwordProblems(form.next));
  const mismatch = form.confirm !== '' && form.next !== form.confirm;

  const submit = async () => {
    if (issue || saving) return;
    setSaving(true);
    setError(null);
    try {
      await requestJson('POST', '/api/auth/change-password', {
        currentPassword: form.current,
        newPassword: form.next,
      });
      notifications.show({ title: tCommon('success'), message: t('password.changed'), color: 'green' });
      setForm(EMPTY);
    } catch (err) {
      const e = err as AccountApiError;
      const message =
        e.status === 401 || e.code === 'invalid_current_password'
          ? t('errors.wrongCurrent')
          : e.code === 'password_managed_externally' || e.code === 'rate_limited' || e.code === 'invalid_password' || e.code === 'invalid_body'
            ? t(`errors.${e.code}`)
            : e.status === 429
              ? t('errors.rate_limited')
              : e.status === 400
                ? t('errors.invalid_password')
                : t('errors.generic');
      setError(message);
      notifications.show({ title: tNotifications('errorTitle'), message, color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper withBorder p="lg" radius="md" data-testid="password-card">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="md">
          <div>
            <Text fw={600}>{t('password.title')}</Text>
            <Text size="sm" c="dimmed">
              {t('password.hint')}
            </Text>
          </div>

          <PasswordInput
            label={t('password.current')}
            autoComplete="current-password"
            value={form.current}
            onChange={(e) => setForm({ ...form, current: e.currentTarget.value })}
          />
          <PasswordInput
            label={t('password.next')}
            autoComplete="new-password"
            value={form.next}
            onChange={(e) => setForm({ ...form, next: e.currentTarget.value })}
          />
          <List
            size="xs"
            spacing={2}
            aria-label={t('password.rules')}
            icon={<IconCircle size={10} />}
            data-testid="password-rules"
          >
            {PASSWORD_RULES.map((rule) => (
              <List.Item
                key={rule}
                icon={missing.has(rule) ? <IconCircle size={10} /> : <IconCheck size={10} color="var(--mantine-color-teal-6)" />}
                data-rule={rule}
                data-met={!missing.has(rule) || undefined}
              >
                <Text size="xs" c={missing.has(rule) || form.next === '' ? 'dimmed' : 'teal'} component="span">
                  {t(`password.rule.${rule}`)}
                </Text>
              </List.Item>
            ))}
          </List>
          <PasswordInput
            label={t('password.confirm')}
            autoComplete="new-password"
            value={form.confirm}
            error={mismatch ? t('password.mismatch') : undefined}
            onChange={(e) => setForm({ ...form, confirm: e.currentTarget.value })}
          />

          {error ? (
            <Text size="sm" c="red" role="alert">
              {error}
            </Text>
          ) : null}

          <Group justify="flex-end">
            <Button type="submit" loading={saving} disabled={issue !== null}>
              {t('password.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}
