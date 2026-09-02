'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, CopyButton, Group, Select, Text, ActionIcon, Tooltip } from '@mantine/core';
import { TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconCheck,
  IconCopy,
  IconMail,
  IconUser,
  IconUserPlus,
} from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import type { PermissionService, ServicePermissionLevel, UserServicePermissions } from '@/lib/security/rbac';

interface AddUserModalProps {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface PermissionServiceOption {
  id: PermissionService;
  label: string;
  description: string;
  category: string;
  adminService?: boolean;
}

type RoleValue = 'user' | 'project_admin' | 'admin';

export default function AddUserModal({ opened, onClose, onSuccess }: AddUserModalProps) {
  const t = useTranslations('settings.addUserModal');
  const tValidation = useTranslations('validation');
  const tNotifications = useTranslations('notifications');
  const [submitting, setSubmitting] = useState(false);
  const [permissionServices, setPermissionServices] = useState<PermissionServiceOption[]>([]);
  const [permissionDraft, setPermissionDraft] = useState<UserServicePermissions>({});
  // Set only when the server generated a one-time password (no-invite path).
  // Its presence switches the whole modal into the "shown once" success view,
  // mirroring CreateTokenModal's plaintext-token-shown-once panel.
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);
  const [createdSummary, setCreatedSummary] = useState<{ name: string; email: string } | null>(null);

  const form = useForm({
    initialValues: {
      name: '',
      email: '',
      role: 'user' as RoleValue,
      canLogin: true,
      sendInvite: true,
    },
  });

  useEffect(() => {
    if (!opened || permissionServices.length > 0) return;
    (async () => {
      try {
        const response = await fetch('/api/users/permissions/services');
        if (!response.ok) return;
        const data = await response.json() as { services?: PermissionServiceOption[] };
        setPermissionServices(data.services ?? []);
      } catch {
        setPermissionServices([]);
      }
    })();
  }, [opened, permissionServices.length]);

  // Reset local state whenever the modal is (re)opened fresh.
  useEffect(() => {
    if (opened) return;
    form.reset();
    setPermissionDraft({});
    setGeneratedPassword(null);
    setCreatedSummary(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const values = form.values;
  const validName = values.name.trim().length >= 2;
  const emailRegex = /^\S+@\S+\.\S+$/;
  const trimmedEmail = values.email.trim();
  // Email is required unless the account can't log in at all — a
  // "Programmatic User" has no login capability, so there's nothing to
  // reach with an email address.
  const validEmail = values.canLogin
    ? emailRegex.test(trimmedEmail)
    : trimmedEmail.length === 0 || emailRegex.test(trimmedEmail);
  const validRole = Boolean(values.role);
  const sendInviteActive = values.canLogin && values.sendInvite;

  const checklist = [
    { id: 1, label: t('form.name.label'), done: validName },
    { id: 2, label: t('form.email.label'), done: validEmail },
    { id: 3, label: t('form.role.label'), done: validRole },
  ];

  const canSubmit = validName && validEmail && validRole;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const response = await fetch('/api/users/invite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          canLogin: values.canLogin,
          email: trimmedEmail,
          name: values.name,
          role: values.role,
          sendInvite: sendInviteActive,
          servicePermissions: permissionDraft,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || t('errors.create'));
      }

      if (data.generatedPassword) {
        // No-invite path: show the plaintext password once instead of
        // closing — the user must copy it now.
        setCreatedSummary({ email: values.email, name: values.name });
        setGeneratedPassword(data.generatedPassword as string);
      } else {
        notifications.show({
          title: tNotifications('inviteSuccessTitle'),
          message: t('messages.inviteSuccess', { email: values.email }),
          color: 'green',
        });
        form.reset();
        onClose();
        onSuccess();
      }
    } catch (error: unknown) {
      notifications.show({
        title: tNotifications('errorTitle'),
        message: error instanceof Error ? error.message : t('errors.create'),
        color: 'red',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    const hadGeneratedPassword = Boolean(generatedPassword);
    onClose();
    if (hadGeneratedPassword) {
      onSuccess();
    }
  };

  const roleOptions: Array<{ value: RoleValue; label: string }> = [
    { value: 'user', label: t('form.role.options.user') },
    { value: 'project_admin', label: t('form.role.options.project_admin') },
    { value: 'admin', label: t('form.role.options.admin') },
  ];

  const roleLabel = roleOptions.find((o) => o.value === values.role)?.label;

  // ── One-time "generated password" success view ──────────────────────────
  if (generatedPassword && createdSummary) {
    const successSummary = (
      <SummaryGroup title={t('passwordPanel.title')}>
        <SummaryKV label={t('form.name.label')} value={createdSummary.name} />
        <SummaryKV
          label={t('form.email.label')}
          value={createdSummary.email || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Status"
          value={<span className="ds-badge ds-badge-ok">{t('passwordPanel.created')}</span>}
        />
      </SummaryGroup>
    );

    return (
      <FormShell
        open={opened}
        onClose={handleClose}
        icon={<IconUserPlus size={16} />}
        title={t('passwordPanel.title')}
        subtitle={t('passwordPanel.warning')}
        summary={successSummary}
        disableEscape
        primaryAction={{
          label: t('passwordPanel.done'),
          color: 'teal',
          onClick: handleClose,
        }}
      >
        <FormSection
          number={1}
          title={t('passwordPanel.warningTitle')}
          description={t('passwordPanel.warning')}
          done
        >
          <Alert icon={<IconAlertCircle size={16} />} title={t('passwordPanel.warningTitle')} color="orange">
            {t('passwordPanel.warning')}
          </Alert>
        </FormSection>

        <FormSection number={2} title={t('passwordPanel.passwordLabel')} done>
          <FormRow cols={1}>
            <FormField label={t('passwordPanel.passwordLabel')}>
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
                  {generatedPassword}
                </Text>
                <CopyButton value={generatedPassword}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? t('passwordPanel.copied') : t('passwordPanel.copy')}>
                      <ActionIcon color={copied ? 'teal' : 'blue'} variant="filled" onClick={copy} size="lg">
                        {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
              </Group>
            </FormField>
          </FormRow>
        </FormSection>
      </FormShell>
    );
  }

  const summary = (
    <>
      <SummaryGroup title={t('title')}>
        <SummaryKV
          label={t('form.name.label')}
          value={values.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label={t('form.email.label')}
          value={values.email || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label={t('form.role.label')}
          value={
            roleLabel ? (
              <span className="ds-badge ds-badge-info">{roleLabel}</span>
            ) : (
              <span className="ds-faint">—</span>
            )
          }
        />
        <SummaryKV
          label={t('form.canLogin.label')}
          value={
            values.canLogin ? (
              <span className="ds-badge ds-badge-ok">{t('form.canLogin.on')}</span>
            ) : (
              <span className="ds-badge">{t('form.canLogin.off')}</span>
            )
          }
        />
        <SummaryKV
          label={t('form.sendInvite.label')}
          value={
            sendInviteActive ? (
              <span className="ds-badge ds-badge-ok">{t('form.sendInvite.on')}</span>
            ) : (
              <span className="ds-badge">{t('form.sendInvite.off')}</span>
            )
          }
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
      icon={<IconUserPlus size={16} />}
      title={t('title')}
      subtitle={t('subtitle')}
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: t('form.submit'),
        loading: submitting,
        disabled: !canSubmit,
        onClick: () => {
          void handleSubmit();
        },
      }}
    >
      <FormSection
        number={1}
        title={t('form.name.label')}
        description={t('sections.identity')}
        done={validName && validEmail}
      >
        <FormRow cols={2}>
          <FormField label={t('form.name.label')} required>
            <TextInput
              placeholder={t('form.name.placeholder')}
              leftSection={<IconUser size={16} />}
              {...form.getInputProps('name')}
            />
          </FormField>
          <FormField
            label={t('form.email.label')}
            required={values.canLogin}
            optional={!values.canLogin}
          >
            <TextInput
              placeholder={t('form.email.placeholder')}
              type="email"
              leftSection={<IconMail size={16} />}
              {...form.getInputProps('email')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title={t('form.role.label')}
        description={t('sections.role')}
        done={validRole}
      >
        <ChipPicker<RoleValue>
          options={roleOptions}
          value={values.role}
          onChange={(v) => form.setFieldValue('role', v as RoleValue)}
        />
      </FormSection>

      <FormSection number={3} title={t('sections.accessTitle')} description={t('sections.access')} done>
        <ToggleList>
          <ToggleRow
            label={t('form.canLogin.label')}
            description={t('form.canLogin.description')}
            checked={values.canLogin}
            onChange={(checked) => {
              form.setFieldValue('canLogin', checked);
              if (!checked) {
                form.setFieldValue('sendInvite', false);
              }
            }}
          />
          {values.canLogin ? (
            <ToggleRow
              label={t('form.sendInvite.label')}
              description={t('form.sendInvite.description')}
              checked={values.sendInvite}
              onChange={(checked) => form.setFieldValue('sendInvite', checked)}
            />
          ) : null}
        </ToggleList>
      </FormSection>

      <FormSection
        number={4}
        title={t('sections.permissionsTitle')}
        description={t('sections.permissions')}
        done
        collapsible
        defaultOpen={false}
      >
        <div className="ds-tbl-wrap" style={{ border: '1px solid var(--ds-border-soft)', borderRadius: 8 }}>
          <table className="ds-tbl">
            <thead>
              <tr>
                <th>Service</th>
                <th style={{ width: 140 }}>Category</th>
                <th style={{ width: 200 }}>Permission</th>
              </tr>
            </thead>
            <tbody>
              {permissionServices.length === 0 ? (
                <tr>
                  <td colSpan={3}>
                    <Text size="sm" c="dimmed" ta="center" py="md">
                      No permission services
                    </Text>
                  </td>
                </tr>
              ) : (
                permissionServices.map((service) => (
                  <tr key={service.id}>
                    <td>
                      <div>
                        <Text size="sm" fw={500}>{service.label}</Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>{service.description}</Text>
                      </div>
                    </td>
                    <td>
                      <Badge variant="light" color={service.adminService ? 'grape' : 'gray'}>
                        {service.category}
                      </Badge>
                    </td>
                    <td>
                      <Select
                        size="xs"
                        value={permissionDraft[service.id] ?? 'none'}
                        data={[
                          { value: 'none', label: 'None' },
                          { value: 'read', label: 'Read' },
                          { value: 'write', label: 'Write' },
                          { value: 'admin', label: 'Admin' },
                        ]}
                        onChange={(value) =>
                          setPermissionDraft((current) => ({
                            ...current,
                            [service.id]: (value ?? 'none') as ServicePermissionLevel,
                          }))
                        }
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </FormSection>
    </FormShell>
  );
}
