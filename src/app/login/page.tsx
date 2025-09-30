'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  TextInput,
  PasswordInput,
  Button,
  Paper,
  Title,
  Text,
  Container,
  Anchor,
  Stack,
  Group,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconLogin } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const t = useTranslations('login');
  const tValidation = useTranslations('validation');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');

  const form = useForm({
    initialValues: {
      slug: '',
      email: '',
      password: '',
    },
    validate: {
      slug: (value) => (value.length >= 2 ? null : tValidation('companySlugRequired')),
      email: (value) => (/^\S+@\S+$/.test(value) ? null : tValidation('invalidEmail')),
      password: (value) => (value.length >= 8 ? null : tValidation('passwordMinLength')), 
    },
  });

  const handleSubmit = async (values: typeof form.values) => {
    setLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });

      const data = await response.json();

      if (!response.ok) {
        notifications.show({
          title: tNotifications('loginFailedTitle'),
          message: data.error || tNotifications('invalidCredentials'),
          color: 'red',
        });
        return;
      }

      notifications.show({
        title: tCommon('success'),
        message: tNotifications('loginSuccess'),
        color: 'green',
      });

      router.push('/dashboard');
    } catch (error) {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: tNotifications('loginGenericError'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container size={420} my={100}>
      <Stack gap="lg">
        <div style={{ textAlign: 'center' }}>
          <Title order={1} style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>
            {t('hero.emoji')}
          </Title>
          <Title order={2} mb="xs">
            {t('hero.title')}
          </Title>
          <Text c="dimmed" size="sm">
            {t('hero.subtitle')}
          </Text>
        </div>

        <Paper withBorder shadow="md" p={30} radius="md">
          <form onSubmit={form.onSubmit(handleSubmit)}>
            <Stack gap="md">
              <TextInput
                label={t('form.slug.label')}
                placeholder={t('form.slug.placeholder')}
                required
                description={t('form.slug.description')}
                {...form.getInputProps('slug')}
              />

              <TextInput
                label={t('form.email.label')}
                placeholder={t('form.email.placeholder')}
                required
                {...form.getInputProps('email')}
              />

              <PasswordInput
                label={t('form.password.label')}
                placeholder={t('form.password.placeholder')}
                required
                {...form.getInputProps('password')}
              />

              <Button type="submit" fullWidth loading={loading} leftSection={<IconLogin size={18} />}>
                {t('form.submit')}
              </Button>
            </Stack>
          </form>
        </Paper>

        <Group justify="center">
          <Text size="sm" c="dimmed">
            {t('footer.cta')}{' '}
            <Anchor href="/register" size="sm">
              {t('footer.link')}
            </Anchor>
          </Text>
        </Group>
      </Stack>
    </Container>
  );
}
