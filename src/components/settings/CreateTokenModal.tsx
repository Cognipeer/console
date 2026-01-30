'use client';

import { useState } from 'react';
import { Modal, TextInput, Button, Stack, Alert, Group, Text, CopyButton, ActionIcon, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconKey, IconAlertCircle, IconCopy, IconCheck } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

interface CreateTokenModalProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
  createUrl?: string;
}

export default function CreateTokenModal({ opened, onClose, onSuccess, createUrl = '/api/tokens' }: CreateTokenModalProps) {
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const t = useTranslations('settings.tokenManagement.createModal');
  const tValidation = useTranslations('validation');
  const tCommon = useTranslations('common');
  const tNotifications = useTranslations('notifications');

  const form = useForm({
    initialValues: {
      label: '',
    },
    validate: {
      label: (value) => (value.length >= 3 ? null : tValidation('tokenLabelMinLength')),
    },
  });

  const handleSubmit = async (values: typeof form.values) => {
    setLoading(true);
    try {
      const response = await fetch(createUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || t('errors.create'));
      }

      setCreatedToken(data.token);
      notifications.show({
        title: tCommon('success'),
        message: t('messages.createSuccess'),
        color: 'green',
      });
    } catch (error: unknown) {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: error instanceof Error ? error.message : t('errors.create'),
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setCreatedToken(null);
    form.reset();
    onClose();
    if (createdToken) {
      onSuccess();
    }
  };

  return (
    <Modal 
      opened={opened} 
      onClose={handleClose} 
      title={createdToken ? t('titles.newToken') : t('titles.createToken')} 
      size="md"
      closeOnClickOutside={!createdToken}
      closeOnEscape={!createdToken}
    >
      {!createdToken ? (
        <form onSubmit={form.onSubmit(handleSubmit)}>
          <Stack gap="md">
            <TextInput
              label={t('form.label')}
              placeholder={t('form.placeholder')}
              required
              description={t('form.description')}
              leftSection={<IconKey size={16} />}
              {...form.getInputProps('label')}
            />

            <Button type="submit" fullWidth loading={loading}>
              {t('form.submit')}
            </Button>
          </Stack>
        </form>
      ) : (
        <Stack gap="md">
          <Alert icon={<IconAlertCircle size={16} />} title={t('important.title')} color="orange">
            {t('important.message')}
          </Alert>

          <div>
            <Text size="sm" fw={500} mb="xs">
              {t('display.label')}
            </Text>
            <Group gap="xs">
              <Text 
                ff="monospace"
                style={{ 
                  flex: 1, 
                  padding: '8px 12px',
                  wordBreak: 'break-all',
                  fontSize: '12px',
                  backgroundColor: '#f5f5f5',
                  borderRadius: '4px',
                  border: '1px solid #e0e0e0'
                }}
              >
                {createdToken}
              </Text>
              <CopyButton value={createdToken}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? t('copy.copied') : t('copy.copyToClipboard')}>
                    <ActionIcon
                      color={copied ? 'teal' : 'blue'}
                      variant="filled"
                      onClick={copy}
                      size="lg"
                    >
                      {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
          </div>

          <Alert icon={<IconAlertCircle size={16} />} color="blue">
            {t('usage.instructions')}
            <Text ff="monospace" size="sm" mt="xs" p="xs" style={{ backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
              {t('usage.example')}
            </Text>
          </Alert>

          <Button onClick={handleClose} fullWidth>
            {t('actions.copied')}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}
