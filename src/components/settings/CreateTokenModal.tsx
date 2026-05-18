'use client';

import { useState } from 'react';
import {
  TextInput,
  Alert,
  Group,
  Text,
  CopyButton,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconKey,
  IconAlertCircle,
  IconCopy,
  IconCheck,
} from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';

interface CreateTokenModalProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
  createUrl?: string;
}

export default function CreateTokenModal({
  opened,
  onClose,
  onSuccess,
  createUrl = '/api/tokens',
}: CreateTokenModalProps) {
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
      label: (value) =>
        value.length >= 3 ? null : tValidation('tokenLabelMinLength'),
    },
  });

  const labelValue = form.values.label;
  const validLabel = labelValue.length >= 3;

  const checklist = [{ id: 1, label: t('form.label'), done: validLabel }];

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;

    setLoading(true);
    try {
      const response = await fetch(createUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(form.values),
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
    const hadToken = Boolean(createdToken);
    setCreatedToken(null);
    form.reset();
    onClose();
    if (hadToken) {
      onSuccess();
    }
  };

  if (createdToken) {
    const successSummary = (
      <>
        <SummaryGroup title={t('titles.newToken')}>
          <SummaryKV
            label={t('form.label')}
            value={labelValue || <span className="ds-faint">—</span>}
          />
          <SummaryKV
            label="Status"
            value={<span className="ds-badge ds-badge-ok">Created</span>}
          />
        </SummaryGroup>
      </>
    );

    return (
      <FormShell
        open={opened}
        onClose={handleClose}
        icon={<IconKey size={16} />}
        title={t('titles.newToken')}
        subtitle={t('important.message')}
        summary={successSummary}
        disableEscape
        primaryAction={{
          label: t('actions.copied'),
          color: 'teal',
          onClick: handleClose,
        }}
        secondaryAction={{
          label: 'Close',
          onClick: handleClose,
        }}
      >
        <FormSection
          number={1}
          title={t('important.title')}
          description={t('important.message')}
          done
        >
          <Alert
            icon={<IconAlertCircle size={16} />}
            title={t('important.title')}
            color="orange"
          >
            {t('important.message')}
          </Alert>
        </FormSection>

        <FormSection number={2} title={t('display.label')} done>
          <FormRow cols={1}>
            <FormField label={t('display.label')}>
              <Group gap="xs" wrap="nowrap">
                <Text
                  ff="monospace"
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    wordBreak: 'break-all',
                    fontSize: 12,
                    backgroundColor: 'var(--ds-surface-2, #f5f5f5)',
                    borderRadius: 6,
                    border: '1px solid var(--ds-border, #e0e0e0)',
                  }}
                >
                  {createdToken}
                </Text>
                <CopyButton value={createdToken}>
                  {({ copied, copy }) => (
                    <Tooltip
                      label={copied ? t('copy.copied') : t('copy.copyToClipboard')}
                    >
                      <ActionIcon
                        color={copied ? 'teal' : 'blue'}
                        variant="filled"
                        onClick={copy}
                        size="lg"
                      >
                        {copied ? (
                          <IconCheck size={18} />
                        ) : (
                          <IconCopy size={18} />
                        )}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
              </Group>
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection number={3} title="Usage" done>
          <Alert icon={<IconAlertCircle size={16} />} color="blue">
            {t('usage.instructions')}
            <Text
              ff="monospace"
              size="sm"
              mt="xs"
              p="xs"
              style={{
                backgroundColor: 'var(--ds-surface-2, #f5f5f5)',
                borderRadius: 6,
              }}
            >
              {t('usage.example')}
            </Text>
          </Alert>
        </FormSection>
      </FormShell>
    );
  }

  const summary = (
    <>
      <SummaryGroup title={t('titles.createToken')}>
        <SummaryKV
          label={t('form.label')}
          value={labelValue || <span className="ds-faint">—</span>}
        />
      </SummaryGroup>
      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={opened}
      onClose={handleClose}
      icon={<IconKey size={16} />}
      title={t('titles.createToken')}
      subtitle="Generate a programmatic API token for SDK and HTTP integrations."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: t('form.submit'),
        loading: loading,
        disabled: !validLabel,
        onClick: () => {
          void handleSubmit();
        },
      }}
    >
      <FormSection
        number={1}
        title={t('form.label')}
        description={t('form.description')}
        done={validLabel}
      >
        <FormRow cols={1}>
          <FormField label={t('form.label')} required hint={t('form.description')}>
            <TextInput
              placeholder={t('form.placeholder')}
              leftSection={<IconKey size={16} />}
              {...form.getInputProps('label')}
            />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}
