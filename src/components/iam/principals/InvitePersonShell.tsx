'use client';

import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Alert, CopyButton, Group, Text, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconCheck, IconCopy, IconKey, IconMail, IconUser, IconUserPlus } from '@tabler/icons-react';
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
import AccountTypeCards, { type AccountKind } from './AccountTypeCards';
import { directoryApi, type InviteResult } from './directoryApi';
import ExternalPersonShell from './ExternalPersonShell';
import ProjectRolesField from './ProjectRolesField';
import { toGrants, type ProjectSelection } from './projectGrantModel';
import { FormError } from './errors';
import { overrideCount, readDraft, toPermissions, type MatrixDraft } from './permissionModel';
import ServicePermissionMatrix from './ServicePermissionMatrix';

export type InviteMode = AccountKind;

interface InvitePersonShellProps {
  open: boolean;
  mode: InviteMode;
  /** The roles the signed-in person may hand out. */
  assignableRoles: readonly string[];
  /** The project the new person joins as a member (optional; the active project when invited from a project). */
  projectId?: string;
  /** Called when the account was created (refresh the list while the success view is still showing). */
  onCreated: (created: InviteResult) => void;
  /** Closing the form; `created` is set when an account was made (the list opens its drawer). */
  onClose: (created?: InviteResult) => void;
  /** After a service account was created: continue to minting its first token. */
  onCreateToken?: (created: InviteResult) => void;
}

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const ROLE_ORDER = ['user', 'project_admin', 'admin', 'portal_user'] as const;
type RoleValue = (typeof ROLE_ORDER)[number];

const copyBoxStyle = {
  flex: 1,
  padding: '8px 12px',
  wordBreak: 'break-all' as const,
  fontSize: 12,
  backgroundColor: 'var(--ds-surface-2, #f5f5f5)',
  borderRadius: 6,
  border: '1px solid var(--ds-border, #e0e0e0)',
};

/**
 * Invite a person (they get a link, or a one-time password), or create a service
 * account (no sign-in; it acts through API tokens). A one-time secret is shown
 * once and the form cannot be dismissed with Escape while it is on screen.
 */
export default function InvitePersonShell({
  open,
  mode,
  assignableRoles,
  projectId,
  onCreated,
  onClose,
  onCreateToken,
}: InvitePersonShellProps) {
  const t = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const [kind, setKind] = useState<AccountKind>(mode);
  const service = kind === 'service';
  const [projectPicks, setProjectPicks] = useState<ProjectSelection>([]);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleValue>('user');
  const [sendInvite, setSendInvite] = useState(true);
  const [draft, setDraft] = useState<MatrixDraft>(() => readDraft({}));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<InviteResult | null>(null);

  useEffect(() => {
    if (open) {
      setKind(mode);
      setProjectPicks(projectId ? [{ projectId, role: 'member' }] : []);
      return;
    }
    setName('');
    setEmail('');
    setRole('user');
    setSendInvite(true);
    setDraft(readDraft({}));
    setSaving(false);
    setError(null);
    setCreated(null);
  }, [open, mode, projectId]);

  const roles = useMemo(() => ROLE_ORDER.filter((r) => assignableRoles.includes(r)), [assignableRoles]);
  // Keep the pick inside what the signed-in person may hand out.
  useEffect(() => {
    if (roles.length > 0 && !roles.includes(role)) setRole(roles[0]);
  }, [roles, role]);

  const trimmedEmail = email.trim();
  const validName = name.trim().length >= 2;
  const validEmail = service ? trimmedEmail === '' || EMAIL_PATTERN.test(trimmedEmail) : EMAIL_PATTERN.test(trimmedEmail);
  const validRole = roles.includes(role);
  const canSubmit = validName && validEmail && validRole;
  const checklist = [
    { id: 1, label: t('invite.form.name'), done: validName },
    { id: 2, label: t('invite.form.email'), done: validEmail },
    { id: 3, label: t('invite.form.role'), done: validRole },
  ];

  const submit = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await directoryApi.invite({
        name: name.trim(),
        email: trimmedEmail,
        role,
        canLogin: !service,
        sendInvite: !service && sendInvite,
        // A portal user holds no service permission by design: nothing is sent, so nothing can raise it.
        servicePermissions: role === 'portal_user' ? {} : toPermissions(draft),
        // An admin reaches every project already: nothing to assign.
        ...(role !== 'admin' && projectPicks.length > 0 ? { projects: toGrants(projectPicks) } : {}),
      });
      setCreated(result);
      onCreated(result);
      // Nothing to hand over (no link, no password): this is done.
      if (service || (!result.invitationUrl && !result.generatedPassword)) {
        notifications.show({
          title: tCommon('success'),
          message: t(service ? 'invite.serviceCreated' : 'invite.invited', { name: result.name || name.trim() }),
          color: 'green',
        });
      }
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (saving) return;
    onClose(created ?? undefined);
  };

  // ── success: an invitation link ──────────────────────────────────────────
  if (created && !service && created.invitationUrl) {
    const emailSent = created.invitationEmailSent;
    const title = emailSent ? t('invite.link.emailSentTitle') : t('invite.link.emailNotSentTitle');
    const description = emailSent ? t('invite.link.emailSentDescription') : t('invite.link.emailNotSentDescription');
    return (
      <FormShell
        open={open}
        onClose={close}
        icon={<IconUserPlus size={16} />}
        title={t('invite.link.title')}
        subtitle={description}
        summary={
          <SummaryGroup title={t('invite.link.title')}>
            <SummaryKV label={t('invite.form.name')} value={created.name} />
            <SummaryKV label={t('invite.form.email')} value={created.email} />
            <SummaryKV
              label={t('invite.link.delivery')}
              value={<span className={emailSent ? 'ds-badge ds-badge-ok' : 'ds-badge'}>{title}</span>}
            />
          </SummaryGroup>
        }
        primaryAction={{ label: t('invite.done'), color: 'teal', onClick: close }}
        secondaryAction={{ label: t('common.close'), onClick: close }}
      >
        <FormSection number={1} title={title} done>
          <Alert icon={<IconAlertCircle size={16} />} color={emailSent ? 'teal' : 'orange'}>
            {description}
          </Alert>
        </FormSection>
        <FormSection number={2} title={t('invite.link.label')} done>
          <FormRow cols={1}>
            <FormField label={t('invite.link.label')}>
              <Group gap="xs" wrap="nowrap">
                <Text ff="monospace" style={copyBoxStyle} data-testid="invitation-url">
                  {created.invitationUrl}
                </Text>
                <CopyButton value={created.invitationUrl}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? t('common.copied') : t('invite.link.copy')}>
                      <ActionIcon color={copied ? 'teal' : 'blue'} variant="filled" onClick={copy} size="lg" aria-label={t('invite.link.copy')}>
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

  // ── success: a one-time password ─────────────────────────────────────────
  if (created && !service && created.generatedPassword) {
    const password = created.generatedPassword;
    return (
      <FormShell
        open={open}
        onClose={close}
        icon={<IconUserPlus size={16} />}
        title={t('invite.password.title')}
        subtitle={t('invite.password.warning')}
        disableEscape
        summary={
          <SummaryGroup title={t('invite.password.title')}>
            <SummaryKV label={t('invite.form.name')} value={created.name} />
            <SummaryKV label={t('invite.form.email')} value={created.email || <span className="ds-faint">—</span>} />
            <SummaryKV label={t('invite.password.status')} value={<span className="ds-badge ds-badge-ok">{t('invite.password.created')}</span>} />
          </SummaryGroup>
        }
        primaryAction={{ label: t('invite.password.done'), color: 'teal', onClick: close }}
      >
        <FormSection number={1} title={t('invite.password.warningTitle')} done>
          <Alert icon={<IconAlertCircle size={16} />} color="orange">
            {t('invite.password.warning')}
          </Alert>
        </FormSection>
        <FormSection number={2} title={t('invite.password.label')} done>
          <FormRow cols={1}>
            <FormField label={t('invite.password.label')}>
              <Group gap="xs" wrap="nowrap">
                <Text ff="monospace" style={copyBoxStyle} data-testid="generated-password">
                  {password}
                </Text>
                <CopyButton value={password}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? t('common.copied') : t('invite.password.copy')}>
                      <ActionIcon color={copied ? 'teal' : 'blue'} variant="filled" onClick={copy} size="lg" aria-label={t('invite.password.copy')}>
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

  // ── success: a service account (or an invitation with nothing to hand over) ──
  if (created) {
    return (
      <FormShell
        open={open}
        onClose={close}
        icon={<IconUserPlus size={16} />}
        title={t(service ? 'invite.serviceDone.title' : 'invite.invitedDone.title')}
        subtitle={t(service ? 'invite.serviceDone.subtitle' : 'invite.invitedDone.subtitle')}
        summary={
          <SummaryGroup title={t('invite.summary')}>
            <SummaryKV label={t('invite.form.name')} value={created.name} />
            <SummaryKV label={t('invite.form.email')} value={created.email || <span className="ds-faint">—</span>} />
            <SummaryKV label={t('invite.form.role')} value={t(`roles.${created.role}`)} />
          </SummaryGroup>
        }
        primaryAction={{ label: t('invite.done'), color: 'teal', onClick: close }}
        secondaryAction={
          service && onCreateToken
            ? { label: t('invite.createToken'), icon: <IconKey size={14} />, onClick: () => onCreateToken(created) }
            : { label: t('common.close'), onClick: close }
        }
      >
        <FormSection number={1} title={t(service ? 'invite.serviceDone.title' : 'invite.invitedDone.title')} done>
          <Alert icon={<IconCheck size={16} />} color="teal">
            {t(service ? 'invite.serviceDone.body' : 'invite.invitedDone.body', { name: created.name })}
          </Alert>
        </FormSection>
      </FormShell>
    );
  }

  if (kind === 'external') {
    return <ExternalPersonShell open={open} kind={kind} onKind={setKind} onCreated={onCreated} onClose={onClose} />;
  }

  // ── the form ─────────────────────────────────────────────────────────────
  const summary = (
    <>
      <SummaryGroup title={t(service ? 'invite.summaryService' : 'invite.summary')}>
        <SummaryKV label={t('invite.form.name')} value={name.trim() || <span className="ds-faint">—</span>} />
        <SummaryKV label={t('invite.form.email')} value={trimmedEmail || <span className="ds-faint">—</span>} />
        <SummaryKV label={t('invite.form.role')} value={validRole ? t(`roles.${role}`) : <span className="ds-faint">—</span>} />
        <SummaryKV
          label={t('invite.form.type')}
          value={<span className="ds-badge">{t(service ? 'badges.kinds.service' : 'badges.kinds.person')}</span>}
        />
        {!service ? (
          <SummaryKV
            label={t('invite.form.delivery')}
            value={
              <span className={sendInvite ? 'ds-badge ds-badge-ok' : 'ds-badge'}>
                {t(sendInvite ? 'invite.form.deliveryEmail' : 'invite.form.deliveryPassword')}
              </span>
            }
          />
        ) : null}
        <SummaryKV label={t('invite.form.overrides')} value={overrideCount(draft.choices)} />
      </SummaryGroup>
      <SummaryGroup title={t('invite.preflight')}>
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={open}
      onClose={close}
      icon={<IconUserPlus size={16} />}
      title={t(service ? 'invite.titleService' : 'invite.title')}
      subtitle={t(service ? 'invite.subtitleService' : 'invite.subtitle')}
      summary={summary}
      disableEscape={saving}
      footerStatus={t('invite.ready', { done: checklist.filter((c) => c.done).length, total: checklist.length })}
      primaryAction={{
        label: t(service ? 'invite.submitService' : 'invite.submit'),
        loading: saving,
        disabled: !canSubmit,
        onClick: () => void submit(),
      }}
      secondaryAction={{ label: t('common.cancel'), onClick: close, disabled: saving }}
    >
      {service ? (
        <Alert color="blue" variant="light" icon={<IconKey size={16} />}>
          {t('invite.serviceNote')}
        </Alert>
      ) : null}

      <FormSection number={1} title={t('invite.kinds.title')} description={t('invite.kinds.hint')} done>
        <AccountTypeCards value={kind} onChange={setKind} disabled={saving} />
      </FormSection>

      <FormSection number={2} title={t('invite.form.name')} description={t(service ? 'invite.sections.identityService' : 'invite.sections.identity')} done={validName && validEmail}>
        <FormRow cols={2}>
          <FormField label={t('invite.form.name')} required>
            <TextInput
              placeholder={t(service ? 'invite.form.namePlaceholderService' : 'invite.form.namePlaceholder')}
              leftSection={<IconUser size={16} />}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </FormField>
          <FormField label={t('invite.form.email')} required={!service} optional={service}>
            <TextInput
              placeholder={t('invite.form.emailPlaceholder')}
              type="email"
              leftSection={<IconMail size={16} />}
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              error={trimmedEmail !== '' && !EMAIL_PATTERN.test(trimmedEmail) ? t('invite.form.emailInvalid') : undefined}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={3} title={t('invite.form.role')} description={t('invite.sections.role')} done={validRole}>
        {roles.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('invite.noRoles')}
          </Text>
        ) : (
          <ChipPicker<RoleValue>
            options={roles.map((r) => ({
              value: r,
              label: (
                <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left' }}>
                  <span>{t(`roles.${r}`)}</span>
                  <span className="ds-faint" style={{ fontSize: 11, fontWeight: 400 }}>
                    {t(`roles.hints.${r}`)}
                  </span>
                </span>
              ),
            }))}
            value={role}
            onChange={(v) => setRole(v as RoleValue)}
          />
        )}
      </FormSection>

      {role !== 'admin' ? (
        <FormSection number={4} title={t('invite.projects.title')} description={t('invite.projects.hint')} done={projectPicks.length > 0} collapsible defaultOpen={projectPicks.length > 0}>
          <ProjectRolesField value={projectPicks} onChange={setProjectPicks} disabled={saving} />
        </FormSection>
      ) : null}

      {!service ? (
        <FormSection number={5} title={t('invite.sections.deliveryTitle')} description={t('invite.sections.delivery')} done>
          <ToggleList>
            <ToggleRow
              label={t('invite.form.sendInvite')}
              description={t('invite.form.sendInviteHint')}
              checked={sendInvite}
              onChange={setSendInvite}
            />
          </ToggleList>
        </FormSection>
      ) : null}

      {role === 'portal_user' ? null : (
        <FormSection
          number={service ? 5 : 6}
          title={t('invite.sections.accessTitle')}
          description={t('invite.sections.access')}
          done
          collapsible
          defaultOpen={false}
        >
          <ServicePermissionMatrix draft={draft} onChange={setDraft} role={role} mode="person" disabled={saving} />
        </FormSection>
      )}

      {error ? <FormError error={error} t={t} /> : null}
    </FormShell>
  );
}
