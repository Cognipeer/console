'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Switch, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconKey, IconLock } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import { formatDateTime } from '@/components/iam/timeFormat';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { useLocale, useTranslations } from '@/lib/i18n';
import ExpiryField from './ExpiryField';
import IpAllowlistField from './IpAllowlistField';
import TokenAccessSection from './TokenAccessSection';
import TokenDelegationSection from './TokenDelegationSection';
import TokenStatusBadges from './TokenStatusBadges';
import { readErrorBody, tokenErrorMessage } from './tokenErrors';
import {
  allowlistToText,
  expiryPayload,
  expiryProblem,
  parseAllowlistText,
  sameRanges,
  tokenStatuses,
  type ApiTokenRow,
  type ExpiryChoice,
} from './tokenModel';
import { useTokenPolicy } from './useTokenPolicy';

interface TokenDetailModalProps {
  /** The token to show; null closes the form. */
  token: ApiTokenRow | null;
  onClose: () => void;
  /** Called with the token as the server saved it. */
  onSaved: (token: ApiTokenRow) => void;
  /** `PUT` URL of one token. */
  updateUrl: (id: string) => string;
}

/**
 * One token in a full-screen form: its label, expiry and IP allowlist (editable
 * for whoever may edit it) and what it can actually reach (the Access section,
 * read-only). Only the fields that changed are sent, so saving a rename never
 * trips a rule that tightened after the token was created.
 */
export default function TokenDetailModal({ token, onClose, onSaved, updateUrl }: TokenDetailModalProps) {
  const t = useTranslations('iamTokens');
  const tCommon = useTranslations('common');
  const tNotifications = useTranslations('notifications');
  const locale = useLocale();
  const viewer = useDashboardUser();
  // Setting up acting for users lets the token act as other accounts: owners and admins only (the server decides again).
  const canSetUpDelegation = viewer?.role === 'owner' || viewer?.role === 'admin';

  const open = token !== null;
  const { policy } = useTokenPolicy(open);

  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState<ExpiryChoice>({ kind: 'keep' });
  const [ipText, setIpText] = useState('');
  const [requireUserToken, setRequireUserToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenId = token?._id;
  useEffect(() => {
    if (!token) return;
    setLabel(token.label);
    setExpiry({ kind: 'keep' });
    setIpText(allowlistToText(token.allowedIpRanges));
    setRequireUserToken(token.requireUserToken === true);
    setError(null);
    setSaving(false);
    // Re-seed only when a different token is opened; saving replaces the object under the same id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenId]);

  const canEdit = token?.canEdit !== false;
  const ctx = useMemo(
    () => ({ policy, createdAt: token?.createdAt ?? null }),
    [policy, token?.createdAt],
  );
  const allowlist = useMemo(() => parseAllowlistText(ipText, policy.maxIpRanges), [ipText, policy.maxIpRanges]);

  if (!token) return null;

  const labelValid = label.trim().length >= 3;
  const expiryError = expiryProblem(expiry, ctx);
  const ipValid = allowlist.issues.length === 0 && !allowlist.tooMany;
  const labelChanged = label.trim() !== token.label;
  const expiryChanged = expiry.kind !== 'keep';
  const ipChanged = !sameRanges(allowlist.ranges, token.allowedIpRanges);
  const requireChanged = requireUserToken !== (token.requireUserToken === true);
  const dirty = labelChanged || expiryChanged || ipChanged || requireChanged;
  const canSave = canEdit && dirty && labelValid && !expiryError && ipValid;

  const save = async () => {
    if (!canSave) return;
    const body: Record<string, unknown> = {};
    if (labelChanged) body.label = label.trim();
    if (expiryChanged) Object.assign(body, expiryPayload(expiry, 'edit'));
    if (ipChanged) body.allowedIpRanges = allowlist.ranges;
    if (requireChanged) body.requireUserToken = requireUserToken;

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(updateUrl(token._id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(tokenErrorMessage(await readErrorBody(response), t, t('detail.errors.save')));
      }
      const saved = (await response.json()) as ApiTokenRow;
      notifications.show({ title: tCommon('success'), message: t('detail.saved'), color: 'green' });
      onSaved({ ...token, ...saved });
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('detail.errors.save');
      setError(message);
      notifications.show({ title: tNotifications('errorTitle'), message, color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  const checklist = [
    { id: 'label', label: t('detail.check.label'), done: labelValid },
    { id: 'expiry', label: t('detail.check.expiry'), done: !expiryError },
    { id: 'network', label: t('detail.check.network'), done: ipValid },
  ];

  const lastUsed = token.lastUsedAt ?? token.lastUsed ?? null;
  const summary = (
    <>
      <SummaryGroup title={t('detail.summary.token')}>
        <SummaryKV label={t('detail.summary.label')} value={token.label} />
        <SummaryKV label={t('detail.summary.prefix')} value={token.tokenPrefix ? `${token.tokenPrefix}…` : '—'} mono />
        <SummaryKV label={t('detail.summary.created')} value={formatDateTime(token.createdAt, locale)} />
        <SummaryKV
          label={t('detail.summary.lastUsed')}
          value={lastUsed ? formatDateTime(lastUsed, locale) : t('detail.summary.never')}
        />
        <SummaryKV
          label={t('detail.summary.expires')}
          value={token.expiresAt ? formatDateTime(token.expiresAt, locale) : t('detail.summary.noExpiry')}
        />
        <SummaryKV
          label={t('detail.summary.network')}
          value={
            token.allowedIpRanges && token.allowedIpRanges.length > 0
              ? t(token.allowedIpRanges.length === 1 ? 'network.countOne' : 'network.countMany', { count: token.allowedIpRanges.length })
              : t('detail.summary.anyAddress')
          }
        />
        <SummaryKV
          label={t('detail.summary.status')}
          value={tokenStatuses(token).length > 0 ? <TokenStatusBadges token={token} /> : '—'}
        />
      </SummaryGroup>
      {canEdit ? (
        <SummaryGroup title={t('detail.summary.preflight')}>
          <Checklist items={checklist} />
        </SummaryGroup>
      ) : null}
    </>
  );

  return (
    <FormShell
      open={open}
      onClose={onClose}
      icon={<IconKey size={16} />}
      title={token.label}
      subtitle={t('detail.subtitle')}
      summary={summary}
      footerStatus={canEdit ? (dirty ? t('detail.unsaved') : t('detail.noChanges')) : undefined}
      primaryAction={
        canEdit
          ? {
            label: t('detail.save'),
            loading: saving,
            disabled: !canSave,
            onClick: () => {
              void save();
            },
          }
          : undefined
      }
      secondaryAction={{ label: canEdit ? t('detail.cancel') : t('detail.close'), onClick: onClose }}
    >
      {!canEdit ? (
        <Alert color="gray" variant="light" icon={<IconLock size={16} />} mb="md">
          <Text size="sm">{t('detail.readOnly')}</Text>
        </Alert>
      ) : null}

      {error ? (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />} mb="md">
          <Text size="sm">{error}</Text>
        </Alert>
      ) : null}

      <FormSection number={1} title={t('detail.basics.title')} description={t('detail.basics.description')} done={labelValid}>
        <FormRow cols={1}>
          <FormField label={t('form.label')} required>
            <TextInput
              value={label}
              onChange={(event) => setLabel(event.currentTarget.value)}
              leftSection={<IconKey size={16} />}
              disabled={!canEdit}
              error={labelValid ? undefined : t('form.labelTooShort')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={2} title={t('expiry.title')} description={t('expiry.description')} done={!expiryError}>
        <ExpiryField
          mode="edit"
          policy={policy}
          value={expiry}
          onChange={setExpiry}
          createdAt={token.createdAt}
          currentExpiresAt={token.expiresAt}
          disabled={!canEdit}
        />
      </FormSection>

      <FormSection number={3} title={t('network.title')} description={t('network.description')} done={ipValid}>
        <IpAllowlistField text={ipText} onChange={setIpText} policy={policy} disabled={!canEdit} />
      </FormSection>

      <FormSection number={4} title={t('userToken.title')} description={t('userToken.description')}>
        <Switch
          checked={requireUserToken}
          onChange={(event) => setRequireUserToken(event.currentTarget.checked)}
          disabled={!canEdit}
          label={t('userToken.label')}
          data-testid="token-require-user-token"
        />
        <Text size="xs" c="dimmed" mt={4}>{t('userToken.hint')}</Text>
      </FormSection>

      {canSetUpDelegation && canEdit ? (
        <FormSection number={5} title={t('delegation.title')} description={t('delegation.sectionDescription')} collapsible defaultOpen={false}>
          <TokenDelegationSection tokenId={token._id} />
        </FormSection>
      ) : null}

      <FormSection number={canSetUpDelegation && canEdit ? 5 : 4} title={t('access.title')} description={t('access.description')} collapsible defaultOpen>
        <TokenAccessSection tokenId={token._id} />
      </FormSection>
    </FormShell>
  );
}
