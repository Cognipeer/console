'use client';

import { useEffect, useState } from 'react';
import { Alert, Loader, Select, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconInfoCircle, IconLink, IconUserPlus } from '@tabler/icons-react';
import FormShell, { Checklist, FormField, FormRow, FormSection, SummaryGroup, SummaryKV, ToggleList, ToggleRow } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import AccountTypeCards, { type AccountKind } from './AccountTypeCards';
import { IamApiError, isAbortError } from './client';
import { directoryApi, type DelegationIssuerChoice, type InviteResult } from './directoryApi';
import { FormError } from './errors';
import { buildExternalBody, checkExternal, conflictField, EXTERNAL_SUBJECT_MAX } from './externalModel';
import LocalGroupSelect, { type GroupChoice } from './LocalGroupSelect';

interface Props {
  open: boolean;
  kind: AccountKind;
  onKind: (kind: AccountKind) => void;
  onCreated: (created: InviteResult) => void;
  onClose: (created?: InviteResult) => void;
}

/**
 * Add an external identity by hand: a person of a host application, known by (issuer, subject).
 * They cannot sign in, hold no tokens, always have the User role and join no project: their access
 * is the project of the token that acts for them, plus policies.
 */
export default function ExternalPersonShell({ open, kind, onKind, onCreated, onClose }: Props) {
  const t = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const [issuers, setIssuers] = useState<DelegationIssuerChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [issuer, setIssuer] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [groups, setGroups] = useState<GroupChoice[]>([]);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<InviteResult | null>(null);

  useEffect(() => {
    if (!open) {
      setIssuer(null);
      setSubject('');
      setName('');
      setEmail('');
      setGroups([]);
      setActive(true);
      setSaving(false);
      setError(null);
      setCreated(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    directoryApi
      .externalIssuers(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setIssuers(list);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open]);

  const draft = { issuer, subject, name, email, active };
  const checks = checkExternal(draft);
  const conflict = error instanceof IamApiError ? conflictField(error.code) : null;
  const checklist = [
    { id: 1, label: t('external.issuer'), done: checks.issuer },
    { id: 2, label: t('external.subject'), done: checks.subject },
    { id: 3, label: t('invite.form.email'), done: checks.email },
  ];

  const submit = async () => {
    if (!checks.ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await directoryApi.createExternal(buildExternalBody(draft, groups.map((g) => g.id)));
      setCreated(result);
      onCreated(result);
      notifications.show({ title: tCommon('success'), message: t('external.created', { name: result.name || subject.trim() }), color: 'green' });
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

  if (created) {
    return (
      <FormShell
        open={open}
        onClose={close}
        icon={<IconUserPlus size={16} />}
        title={t('external.doneTitle')}
        subtitle={t('external.doneSubtitle')}
        primaryAction={{ label: t('invite.done'), color: 'teal', onClick: close }}
        secondaryAction={{ label: t('common.close'), onClick: close }}
      >
        <FormSection number={1} title={t('external.doneTitle')} done>
          <Alert icon={<IconCheck size={16} />} color="teal">
            {t('external.doneBody', { name: created.name || subject.trim() })}
          </Alert>
        </FormSection>
      </FormShell>
    );
  }

  const noIssuers = !loading && issuers.length === 0 && !error;

  return (
    <FormShell
      open={open}
      onClose={close}
      icon={<IconLink size={16} />}
      title={t('external.title')}
      subtitle={t('external.subtitle')}
      disableEscape={saving}
      summary={
        <>
          <SummaryGroup title={t('external.summary')}>
            <SummaryKV label={t('external.issuer')} value={issuer ?? <span className="ds-faint">—</span>} />
            <SummaryKV label={t('external.subject')} value={subject.trim() || <span className="ds-faint">—</span>} />
            <SummaryKV label={t('invite.form.name')} value={name.trim() || <span className="ds-faint">—</span>} />
            <SummaryKV label={t('invite.form.role')} value={t('roles.user')} />
            <SummaryKV label={t('external.groups')} value={groups.length} />
            <SummaryKV label={t('external.active')} value={t(active ? 'external.activeYes' : 'external.activeNo')} />
          </SummaryGroup>
          <SummaryGroup title={t('invite.preflight')}>
            <Checklist items={checklist} />
          </SummaryGroup>
        </>
      }
      footerStatus={t('invite.ready', { done: checklist.filter((c) => c.done).length, total: checklist.length })}
      primaryAction={{ label: t('external.submit'), loading: saving, disabled: !checks.ready, onClick: () => void submit() }}
      secondaryAction={{ label: t('common.cancel'), onClick: close, disabled: saving }}
    >
      <FormSection number={1} title={t('invite.kinds.title')} description={t('invite.kinds.hint')} done>
        <AccountTypeCards value={kind} onChange={onKind} disabled={saving} />
      </FormSection>

      <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />} data-testid="external-note">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>{t('external.notes.noSignIn')}</li>
          <li>{t('external.notes.noTokens')}</li>
          <li>{t('external.notes.role')}</li>
          <li>{t('external.notes.noProjects')}</li>
        </ul>
      </Alert>

      <FormSection number={2} title={t('external.identity')} description={t('external.identityHint')} done={checks.issuer && checks.subject}>
        <FormRow cols={2}>
          <FormField label={t('external.issuer')} required hint={t('external.issuerHint')}>
            <Select
              searchable
              value={issuer}
              onChange={setIssuer}
              disabled={loading || saving || issuers.length === 0}
              data={issuers.map((i) => ({ value: i.issuer, label: i.enabled ? i.issuer : `${i.issuer} (${t('external.issuerOff')})` }))}
              placeholder={loading ? t('project.loading') : t('external.issuerPlaceholder')}
              rightSection={loading ? <Loader size={12} /> : undefined}
              nothingFoundMessage={t('external.noIssuers')}
              comboboxProps={{ withinPortal: true }}
              aria-label={t('external.issuer')}
            />
          </FormField>
          <FormField label={t('external.subject')} required hint={t('external.subjectHint')}>
            <TextInput
              value={subject}
              onChange={(e) => setSubject(e.currentTarget.value)}
              maxLength={EXTERNAL_SUBJECT_MAX}
              placeholder={t('external.subjectPlaceholder')}
              error={conflict === 'subject' ? t('errors.identity_taken') : undefined}
              disabled={saving}
            />
          </FormField>
        </FormRow>
        {noIssuers ? (
          <Alert color="orange" variant="light" data-testid="no-issuers">
            {t('external.noIssuersHelp')}
          </Alert>
        ) : null}
        <FormRow cols={2}>
          <FormField label={t('invite.form.name')} optional>
            <TextInput value={name} onChange={(e) => setName(e.currentTarget.value)} disabled={saving} />
          </FormField>
          <FormField label={t('invite.form.email')} optional>
            <TextInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              disabled={saving}
              error={email.trim() !== '' && !checks.email ? t('invite.form.emailInvalid') : conflict === 'email' ? t('errors.email_taken') : undefined}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={3} title={t('external.groupsSection')} description={t('external.groupsHint')} done>
        <LocalGroupSelect multiple value={groups} onChange={setGroups} disabled={saving} />
      </FormSection>

      <FormSection number={4} title={t('external.statusSection')} done>
        <ToggleList>
          <ToggleRow label={t('external.active')} description={t('external.activeHint')} checked={active} onChange={setActive} disabled={saving} />
        </ToggleList>
      </FormSection>

      {error && !conflict ? <FormError error={error} t={t} /> : null}
    </FormShell>
  );
}
