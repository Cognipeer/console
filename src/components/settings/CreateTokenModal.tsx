'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import ExpiryField from '@/components/iam/tokens/ExpiryField';
import IpAllowlistField from '@/components/iam/tokens/IpAllowlistField';
import { readJsonObject, tokenErrorMessage } from '@/components/iam/tokens/tokenErrors';
import {
  defaultExpiryChoice,
  expiryPayload,
  expiryPreview,
  expiryProblem,
  parseAllowlistText,
  type ExpiryChoice,
} from '@/components/iam/tokens/tokenModel';
import { useTokenPolicy } from '@/components/iam/tokens/useTokenPolicy';
import { formatDateTime } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';

interface CreateTokenModalProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
  createUrl?: string;
  /** Extra fields merged into the POST body alongside the form values — e.g. `{ userId, projectId }` to mint on behalf of another person from the IAM center. */
  extraBody?: Record<string, unknown>;
  /**
   * A form section shown before the label (the owner and project of the token).
   * Pass a `FormSection` numbered 1: the sections of the form itself are numbered from 2 then.
   */
  leadSection?: ReactNode;
  /** The lead section is complete; false keeps the submit disabled. Default true. */
  extraValid?: boolean;
}

interface CreatedInfo {
  token: string;
  expiresAt: string | null;
  allowedIpRanges: string[] | null;
}

export default function CreateTokenModal({
  opened,
  onClose,
  onSuccess,
  createUrl = '/api/tokens',
  extraBody,
  leadSection,
  extraValid = true,
}: CreateTokenModalProps) {
  const [created, setCreated] = useState<CreatedInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const t = useTranslations('settings.tokenManagement.createModal');
  const tIam = useTranslations('iamTokens');
  const tValidation = useTranslations('validation');
  const tCommon = useTranslations('common');
  const tNotifications = useTranslations('notifications');
  const locale = useLocale();

  const form = useForm({
    initialValues: {
      label: '',
    },
    validate: {
      label: (value) =>
        value.length >= 3 ? null : tValidation('tokenLabelMinLength'),
    },
  });

  // The tenant's rules (maximum lifetime, required expiry) shape the expiry
  // choices; the server applies them again on submit.
  const { policy, ready: policyReady } = useTokenPolicy(opened);
  const [expiry, setExpiry] = useState<ExpiryChoice>({ kind: 'none' });
  const [ipText, setIpText] = useState('');
  const touched = useRef(false);

  useEffect(() => {
    if (!opened) {
      touched.current = false;
      return;
    }
    // Seed the choice once the rules are known, unless the user already picked one.
    if (policyReady && !touched.current) {
      setExpiry(defaultExpiryChoice({ mode: 'create', policy }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, policyReady]);

  const labelValue = form.values.label;
  const validLabel = labelValue.length >= 3;
  const ctx = useMemo(() => ({ policy }), [policy]);
  const expiryError = expiryProblem(expiry, ctx);
  const allowlist = useMemo(() => parseAllowlistText(ipText, policy.maxIpRanges), [ipText, policy.maxIpRanges]);
  const ipValid = allowlist.issues.length === 0 && !allowlist.tooMany;
  const ready = validLabel && !expiryError && ipValid && extraValid;
  // The numbered sections follow the lead section, when there is one.
  const offset = leadSection ? 1 : 0;

  const checklist = [
    { id: 1, label: t('form.label'), done: validLabel },
    { id: 2, label: tIam('form.check.expiry'), done: !expiryError },
    { id: 3, label: tIam('form.check.network'), done: ipValid },
  ];

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors || !ready) return;

    setLoading(true);
    try {
      const response = await fetch(createUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...form.values,
          ...expiryPayload(expiry, 'create'),
          ...(allowlist.ranges.length > 0 ? { allowedIpRanges: allowlist.ranges } : {}),
          ...extraBody,
        }),
      });

      const data = await readJsonObject(response);

      if (!response.ok) {
        throw new Error(tokenErrorMessage(data, tIam, t('errors.create')));
      }

      setCreated({
        token: String(data.token ?? ''),
        expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : null,
        allowedIpRanges: Array.isArray(data.allowedIpRanges) ? (data.allowedIpRanges as string[]) : null,
      });
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
    const hadToken = Boolean(created);
    setCreated(null);
    setExpiry({ kind: 'none' });
    setIpText('');
    touched.current = false;
    form.reset();
    onClose();
    if (hadToken) {
      onSuccess();
    }
  };

  const networkSummary = (ranges: string[] | null) =>
    ranges && ranges.length > 0
      ? tIam(ranges.length === 1 ? 'network.countOne' : 'network.countMany', { count: ranges.length })
      : tIam('detail.summary.anyAddress');

  if (created) {
    const successSummary = (
      <>
        <SummaryGroup title={t('titles.newToken')}>
          <SummaryKV
            label={t('form.label')}
            value={labelValue || <span className="ds-faint">—</span>}
          />
          <SummaryKV
            label={tIam('detail.summary.expires')}
            value={created.expiresAt ? formatDateTime(created.expiresAt, locale) : tIam('detail.summary.noExpiry')}
          />
          <SummaryKV label={tIam('detail.summary.network')} value={networkSummary(created.allowedIpRanges)} />
          <SummaryKV
            label={tIam('detail.summary.status')}
            value={<span className="ds-badge ds-badge-ok">{tIam('create.created')}</span>}
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
          label: tIam('detail.close'),
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
                  {created.token}
                </Text>
                <CopyButton value={created.token}>
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

        <FormSection number={3} title={tIam('create.usage')} done>
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

  const preview = expiryPreview(expiry);
  const summary = (
    <>
      <SummaryGroup title={t('titles.createToken')}>
        <SummaryKV
          label={t('form.label')}
          value={labelValue || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label={tIam('detail.summary.expires')}
          value={
            expiry.kind === 'none'
              ? tIam('detail.summary.noExpiry')
              : preview
                ? formatDateTime(preview.toISOString(), locale)
                : <span className="ds-faint">—</span>
          }
        />
        <SummaryKV label={tIam('detail.summary.network')} value={networkSummary(allowlist.ranges)} />
      </SummaryGroup>
      <SummaryGroup title={tIam('detail.summary.preflight')}>
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
      subtitle={tIam('create.subtitle')}
      summary={summary}
      footerStatus={tIam('create.ready', { done: checklist.filter((c) => c.done).length, total: checklist.length })}
      primaryAction={{
        label: t('form.submit'),
        loading: loading,
        disabled: !ready,
        onClick: () => {
          void handleSubmit();
        },
      }}
    >
      {leadSection}

      <FormSection
        number={1 + offset}
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

      <FormSection
        number={2 + offset}
        title={tIam('expiry.title')}
        description={tIam('expiry.description')}
        done={!expiryError}
      >
        <ExpiryField
          mode="create"
          policy={policy}
          value={expiry}
          onChange={(next) => {
            touched.current = true;
            setExpiry(next);
          }}
        />
      </FormSection>

      <FormSection
        number={3 + offset}
        title={tIam('network.title')}
        description={tIam('network.description')}
        done={ipValid}
      >
        <IpAllowlistField text={ipText} onChange={setIpText} policy={policy} />
      </FormSection>
    </FormShell>
  );
}
