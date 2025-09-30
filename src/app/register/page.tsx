'use client';

import { useMemo, useState } from 'react';
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
  Select,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconUserPlus } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

export default function RegisterPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const t = useTranslations('register');
  const tValidation = useTranslations('validation');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');
  const licenseOptions = useMemo(
    () => [
      { value: 'FREE', label: t('form.license.options.free') },
      { value: 'STARTER', label: t('form.license.options.starter') },
      { value: 'PROFESSIONAL', label: t('form.license.options.professional') },
      { value: 'ENTERPRISE', label: t('form.license.options.enterprise') },
    ],
    [t],
  );

  const form = useForm({
    initialValues: {
      name: '',
      email: '',
      companyName: '',
      password: '',
      confirmPassword: '',
      licenseType: 'FREE',
    },
    validate: {
      name: (value) => (value.length >= 2 ? null : tValidation('nameMinLength')),
      email: (value) => (/^\S+@\S+$/.test(value) ? null : tValidation('invalidEmail')),
      companyName: (value) => (value.length >= 2 ? null : tValidation('companyNameMinLength')),
      password: (value) => (value.length >= 8 ? null : tValidation('passwordMinLength')),
      confirmPassword: (value, values) =>
        value === values.password ? null : tValidation('passwordsDoNotMatch'),
    },
  });

  const handleSubmit = async (values: typeof form.values) => {
    setLoading(true);

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          companyName: values.companyName,
          password: values.password,
          licenseType: values.licenseType,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        notifications.show({
          title: tNotifications('registrationFailedTitle'),
          message: data.error || tNotifications('registrationFailedMessage'),
          color: 'red',
        });
        return;
      }

      notifications.show({
        title: tCommon('success'),
        message: tNotifications('registrationSuccess'),
        color: 'green',
      });

      router.push('/dashboard');
    } catch (error) {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: tNotifications('registrationGenericError'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container size={420} my={60}>
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
                label={t('form.name.label')}
                placeholder={t('form.name.placeholder')}
                required
                {...form.getInputProps('name')}
              />

              <TextInput
                label={t('form.email.label')}
                placeholder={t('form.email.placeholder')}
                required
                {...form.getInputProps('email')}
              />

              <TextInput
                label={t('form.companyName.label')}
                placeholder={t('form.companyName.placeholder')}
                required
                description={t('form.companyName.description')}
                {...form.getInputProps('companyName')}
              />

              <PasswordInput
                label={t('form.password.label')}
                placeholder={t('form.password.placeholder')}
                required
                {...form.getInputProps('password')}
              />

              <PasswordInput
                label={t('form.confirmPassword.label')}
                placeholder={t('form.confirmPassword.placeholder')}
                required
                {...form.getInputProps('confirmPassword')}
              />

              <Select
                label={t('form.license.label')}
                placeholder={t('form.license.placeholder')}
                data={licenseOptions}
                {...form.getInputProps('licenseType')}
              />

              <Button
                type="submit"
                fullWidth
                loading={loading}
                leftSection={<IconUserPlus size={18} />}
              >
                {t('form.submit')}
              </Button>
            </Stack>
          </form>
        </Paper>

        <Group justify="center">
          <Text size="sm" c="dimmed">
            {t('footer.cta')}{' '}
            <Anchor href="/login" size="sm">
              {t('footer.link')}
            </Anchor>
          </Text>
        </Group>
      </Stack>
    </Container>
  );
}
