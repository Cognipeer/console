'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Loader,
  PasswordInput,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconAlertTriangle, IconPlus, IconTrash, IconUserShare } from '@tabler/icons-react';
import { FormField } from '@/components/common/ui/FormShell';
import { useConfirm } from '@/components/common/confirm';
import { formatDateTime } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import { DelegationApiError, delegationApi, type DelegationState } from './delegationApi';
import {
  DELEGATION_ALGORITHMS,
  delegationDirty,
  delegationProblems,
  emptyDelegationForm,
  formFromView,
  formToPayload,
  needsPublicKey,
  needsSecret,
  type DelegationAlgorithm,
  type DelegationForm,
  type DelegationJit,
  type DelegationProblem,
} from './delegationModel';

/** The header an application sends the signed statement about the person in. */
const HEADER_NAME = 'X-Cognipeer-User-Token';
/** The same statement for clients that can only set the API key: both values in the `Authorization` header. */
const COMBINED_EXAMPLE = 'Authorization: Bearer <api token>~<jwt>';

interface Props {
  tokenId: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'failed' }
  | ({ status: 'ready' } & DelegationState);

/**
 * "Acting for users" of one API token: whether an application may use the token on behalf of the people it signs in, and
 * which issuer's signed statements it takes for the truth. Saved on its own (the settings above belong to the token
 * itself). Only owners and admins reach it; anyone else is told so.
 */
export default function TokenDelegationSection({ tokenId }: Props) {
  const t = useTranslations('iamTokens');
  const tCommon = useTranslations('common');
  const tNotifications = useTranslations('notifications');
  const locale = useLocale();
  const { confirmAction } = useConfirm();

  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [form, setForm] = useState<DelegationForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    (signal?: AbortSignal) => {
      setLoad({ status: 'loading' });
      delegationApi
        .get(tokenId, signal)
        .then((state) => setLoad({ status: 'ready', ...state }))
        .catch((cause: unknown) => {
          if (signal?.aborted) return;
          setLoad({ status: cause instanceof DelegationApiError && (cause.status === 403 || cause.status === 401) ? 'forbidden' : 'failed' });
        });
    },
    [tokenId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setForm(null);
    setError(null);
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const view = load.status === 'ready' ? load.delegation : null;
  const problems = useMemo(() => (form ? delegationProblems(form) : []), [form]);
  const dirty = form ? delegationDirty(form, view) : false;

  const problemText = (problem: DelegationProblem): string =>
    t(`delegation.problems.${problem.code}`, { at: problem.at ?? '' });
  const patch = (changes: Partial<DelegationForm>) => setForm((current) => (current ? { ...current, ...changes } : current));

  const startEditing = () => {
    setError(null);
    setForm(view ? formFromView(view) : emptyDelegationForm());
  };

  const save = async () => {
    if (!form || problems.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const state = await delegationApi.save(tokenId, formToPayload(form));
      setLoad({ status: 'ready', ...state });
      setForm(null);
      notifications.show({ title: tCommon('success'), message: t('delegation.saved'), color: 'green' });
    } catch (cause) {
      const message = cause instanceof DelegationApiError
        ? (cause.problems[0]?.message ?? cause.message)
        : t('delegation.errors.save');
      setError(message);
      notifications.show({ title: tNotifications('errorTitle'), message, color: 'red' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    await confirmAction({
      tone: 'danger',
      title: t('delegation.confirmRemove.title'),
      message: t('delegation.confirmRemove.message'),
      confirmLabel: t('delegation.confirmRemove.confirm'),
      action: async () => {
        try {
          await delegationApi.remove(tokenId);
        } catch {
          throw new Error(t('delegation.errors.remove'));
        }
        setForm(null);
        refresh();
        notifications.show({ title: tCommon('success'), message: t('delegation.removed'), color: 'green' });
      },
    });
  };

  if (load.status === 'loading') {
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">{t('delegation.loading')}</Text>
      </Group>
    );
  }
  if (load.status === 'forbidden' || load.status === 'failed') {
    return (
      <Alert color={load.status === 'forbidden' ? 'gray' : 'red'} variant="light" icon={<IconAlertCircle size={16} />}>
        <Text size="sm">{load.status === 'forbidden' ? t('delegation.forbidden') : t('delegation.failed')}</Text>
      </Alert>
    );
  }

  const scopeWarning = !load.tokenScoped ? (
    <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={14} />} data-testid="delegation-unscoped">
      <Text size="xs">{t('delegation.unscoped')}</Text>
    </Alert>
  ) : null;

  // ── reading ────────────────────────────────────────────────────────────

  if (!form) {
    return (
      <Stack gap="sm" data-testid="delegation-section">
        <Text size="sm" c="dimmed">{t('delegation.description', { header: HEADER_NAME })}</Text>
        {scopeWarning}
        {view ? (
          <Stack gap={6}>
            <Group gap="xs">
              <Badge color={view.enabled ? 'teal' : 'gray'} variant="light" data-testid="delegation-status">
                {view.enabled ? t('delegation.status.on') : t('delegation.status.off')}
              </Badge>
              {view.allowPrivileged ? <Badge color="orange" variant="light">{t('delegation.summary.privileged')}</Badge> : null}
            </Group>
            <SummaryLine label={t('delegation.summary.issuer')} value={view.trust.issuer} mono />
            <SummaryLine label={t('delegation.summary.audience')} value={(Array.isArray(view.trust.audience) ? view.trust.audience : [view.trust.audience]).join(', ')} mono />
            <SummaryLine label={t('delegation.summary.algorithms')} value={view.trust.algorithms.join(', ')} />
            <SummaryLine
              label={t('delegation.summary.keys')}
              value={[
                ...(view.trust.keys.hsSecrets?.length ? [t('delegation.summary.secrets', { count: view.trust.keys.hsSecrets.length })] : []),
                ...(view.trust.keys.jwksUrl ? [t('delegation.summary.keySet')] : []),
                ...(view.trust.keys.pem ? [t('delegation.summary.publicKey')] : []),
              ].join(', ')}
            />
            <SummaryLine
              label={t('delegation.summary.matching')}
              value={view.mapping.matchBy.map((strategy) => t(`delegation.match.${strategy}`)).join(', ')}
            />
            <SummaryLine label={t('delegation.summary.newPeople')} value={t(`delegation.jit.${view.mapping.jit}`)} />
            {view.mapping.groupMap?.length ? (
              <SummaryLine label={t('delegation.summary.groups')} value={t('delegation.summary.groupCount', { count: view.mapping.groupMap.length })} />
            ) : null}
            <Text size="xs" c="dimmed">{t('delegation.summary.updated', { when: formatDateTime(view.updatedAt, locale) })}</Text>
          </Stack>
        ) : (
          <Text size="sm">{t('delegation.none')}</Text>
        )}
        <Group gap="xs">
          <Button size="xs" variant="default" leftSection={<IconUserShare size={14} />} onClick={startEditing} data-testid="delegation-edit">
            {view ? t('delegation.edit') : t('delegation.setUp')}
          </Button>
          {view ? (
            <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => void remove()}>
              {t('delegation.remove')}
            </Button>
          ) : null}
        </Group>
      </Stack>
    );
  }

  // ── editing ────────────────────────────────────────────────────────────

  const hint = (codes: DelegationProblem['code'][]) => {
    const found = problems.find((problem) => codes.includes(problem.code));
    return found ? problemText(found) : undefined;
  };
  const toggleAlgorithm = (algorithm: DelegationAlgorithm, on: boolean) =>
    patch({ algorithms: DELEGATION_ALGORITHMS.filter((candidate) => (candidate === algorithm ? on : form.algorithms.includes(candidate))) });
  const setSecret = (index: number, changes: Partial<DelegationForm['secrets'][number]>) =>
    patch({ secrets: form.secrets.map((row, at) => (at === index ? { ...row, ...changes } : row)) });

  return (
    <Stack gap="md" data-testid="delegation-form">
      <Text size="sm" c="dimmed">{t('delegation.description', { header: HEADER_NAME })}</Text>
      {scopeWarning}
      {error ? (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
          <Text size="sm">{error}</Text>
        </Alert>
      ) : null}

      <Switch
        checked={form.enabled}
        onChange={(event) => patch({ enabled: event.currentTarget.checked })}
        label={t('delegation.fields.enabled')}
        data-testid="delegation-enabled"
      />

      <FormField label={t('delegation.fields.issuer')} hint={t('delegation.fields.issuerHint')} required>
        <TextInput
          value={form.issuer}
          onChange={(event) => patch({ issuer: event.currentTarget.value })}
          placeholder="https://idp.example.com/realms/acme"
          error={hint(['issuer_required'])}
          autoComplete="off"
          spellCheck={false}
          data-testid="delegation-issuer"
        />
      </FormField>

      <FormField label={t('delegation.fields.audience')} hint={t('delegation.fields.audienceHint')} required>
        <Textarea
          value={form.audience}
          onChange={(event) => patch({ audience: event.currentTarget.value })}
          autosize
          minRows={1}
          maxRows={4}
          placeholder="cognipeer-console"
          error={hint(['audience_required'])}
          spellCheck={false}
          data-testid="delegation-audience"
        />
      </FormField>

      <FormField label={t('delegation.fields.algorithms')} hint={t('delegation.fields.algorithmsHint')} required>
        <Stack gap={6}>
          <Group gap="md">
            {DELEGATION_ALGORITHMS.map((algorithm) => (
              <Checkbox
                key={algorithm}
                label={t(`delegation.algorithm.${algorithm}`)}
                checked={form.algorithms.includes(algorithm)}
                onChange={(event) => toggleAlgorithm(algorithm, event.currentTarget.checked)}
                data-testid={`delegation-alg-${algorithm}`}
              />
            ))}
          </Group>
          {hint(['algorithm_required']) ? <Text size="xs" c="red">{hint(['algorithm_required'])}</Text> : null}
        </Stack>
      </FormField>

      {needsSecret(form) ? (
        <FormField label={t('delegation.fields.secrets')} hint={t('delegation.fields.secretsHint')} required>
          <Stack gap="xs">
            {form.secrets.map((row, index) => (
              <Group key={`${index}`} gap="xs" align="flex-start" wrap="nowrap">
                <TextInput
                  value={row.kid}
                  onChange={(event) => setSecret(index, { kid: event.currentTarget.value })}
                  placeholder={t('delegation.fields.secretKid')}
                  w={160}
                  disabled={row.stored}
                  aria-label={t('delegation.fields.secretKid')}
                  autoComplete="off"
                  spellCheck={false}
                  data-testid={`delegation-secret-kid-${index}`}
                />
                <PasswordInput
                  value={row.secret}
                  onChange={(event) => setSecret(index, { secret: event.currentTarget.value })}
                  placeholder={row.stored ? t('delegation.fields.secretKeep') : t('delegation.fields.secretValue')}
                  style={{ flex: 1 }}
                  aria-label={t('delegation.fields.secretValue')}
                  autoComplete="new-password"
                  data-testid={`delegation-secret-value-${index}`}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={() => patch({ secrets: form.secrets.filter((_, at) => at !== index) })}
                  aria-label={t('delegation.fields.removeSecret')}
                  mt={4}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            ))}
            {problems.filter((problem) => problem.code.startsWith('secret_')).slice(0, 3).map((problem) => (
              <Text key={`${problem.code}:${problem.at ?? ''}`} size="xs" c="red">{problemText(problem)}</Text>
            ))}
            <div>
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={<IconPlus size={12} />}
                onClick={() => patch({ secrets: [...form.secrets, { kid: form.secrets.length === 0 ? 'k1' : '', secret: '', stored: false }] })}
                data-testid="delegation-add-secret"
              >
                {t('delegation.fields.addSecret')}
              </Button>
            </div>
          </Stack>
        </FormField>
      ) : null}

      {needsPublicKey(form) ? (
        <>
          <FormField label={t('delegation.fields.jwksUrl')} hint={t('delegation.fields.jwksUrlHint')}>
            <TextInput
              value={form.jwksUrl}
              onChange={(event) => patch({ jwksUrl: event.currentTarget.value })}
              placeholder="https://idp.example.com/.well-known/jwks.json"
              error={hint(['jwks_url_invalid'])}
              autoComplete="off"
              spellCheck={false}
              data-testid="delegation-jwks"
            />
          </FormField>
          <FormField label={t('delegation.fields.pem')} hint={t('delegation.fields.pemHint')}>
            <Textarea
              value={form.pem}
              onChange={(event) => patch({ pem: event.currentTarget.value })}
              autosize
              minRows={3}
              maxRows={8}
              placeholder={'-----BEGIN PUBLIC KEY-----'}
              error={hint(['pem_invalid'])}
              spellCheck={false}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
              data-testid="delegation-pem"
            />
          </FormField>
          {hint(['public_key_required']) ? <Text size="xs" c="red">{hint(['public_key_required'])}</Text> : null}
        </>
      ) : null}

      <Group grow align="flex-start">
        <FormField label={t('delegation.fields.maxAge')} hint={t('delegation.fields.maxAgeHint')} optional>
          <TextInput
            value={form.maxTokenAgeSeconds}
            onChange={(event) => patch({ maxTokenAgeSeconds: event.currentTarget.value })}
            inputMode="numeric"
            error={hint(['max_age_invalid'])}
            data-testid="delegation-max-age"
          />
        </FormField>
        <FormField label={t('delegation.fields.skew')} hint={t('delegation.fields.skewHint')} optional>
          <TextInput
            value={form.clockSkewSeconds}
            onChange={(event) => patch({ clockSkewSeconds: event.currentTarget.value })}
            inputMode="numeric"
            placeholder="60"
            error={hint(['skew_invalid'])}
          />
        </FormField>
      </Group>

      <FormField label={t('delegation.fields.matching')} hint={t('delegation.fields.matchingHint')} required>
        <Stack gap={6}>
          <Checkbox
            label={t('delegation.match.externalId')}
            checked={form.matchIdentity}
            onChange={(event) => patch({ matchIdentity: event.currentTarget.checked })}
            data-testid="delegation-match-identity"
          />
          <Checkbox
            label={t('delegation.match.verifiedEmail')}
            checked={form.matchEmail}
            onChange={(event) => patch({ matchEmail: event.currentTarget.checked })}
            data-testid="delegation-match-email"
          />
          {hint(['match_required']) ? <Text size="xs" c="red">{hint(['match_required'])}</Text> : null}
        </Stack>
      </FormField>

      <FormField label={t('delegation.fields.jit')} hint={t(`delegation.jitHint.${form.jit}`)} required>
        <SegmentedControl
          fullWidth
          value={form.jit}
          onChange={(value) => patch({ jit: value as DelegationJit })}
          data={(['none', 'external', 'person'] as const).map((mode) => ({ value: mode, label: t(`delegation.jitShort.${mode}`) }))}
          data-testid="delegation-jit"
        />
      </FormField>

      <FormField label={t('delegation.fields.groupMap')} hint={t('delegation.fields.groupMapHint')} optional>
        <Textarea
          value={form.groupMapText}
          onChange={(event) => patch({ groupMapText: event.currentTarget.value })}
          autosize
          minRows={2}
          maxRows={8}
          placeholder="sales => Sales (verified)"
          error={hint(['group_map_invalid'])}
          spellCheck={false}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
          data-testid="delegation-groupmap"
        />
      </FormField>

      <Stack gap={4}>
        <Switch
          checked={form.allowPrivileged}
          onChange={(event) => patch({ allowPrivileged: event.currentTarget.checked })}
          label={t('delegation.fields.allowPrivileged')}
          data-testid="delegation-privileged"
        />
        <Text size="xs" c="dimmed">{t('delegation.fields.allowPrivilegedHint')}</Text>
      </Stack>

      <Alert color="gray" variant="light" p="xs">
        <Stack gap={4}>
          <Text size="xs" fw={600}>{t('delegation.usage.title')}</Text>
          <Text size="xs">{t('delegation.usage.body', { header: HEADER_NAME })}</Text>
          <Code block fz={11}>{`${HEADER_NAME}: <jwt>\n${COMBINED_EXAMPLE}\n${t('delegation.usage.claims')}`}</Code>
        </Stack>
      </Alert>

      <Group justify="space-between" gap="xs">
        <Text size="xs" c="dimmed">{t('delegation.savedSeparately')}</Text>
        <Group gap="xs">
          <Button size="xs" variant="default" onClick={() => { setForm(null); setError(null); }} disabled={saving}>
            {t('delegation.cancel')}
          </Button>
          <Button
            size="xs"
            onClick={() => void save()}
            loading={saving}
            disabled={problems.length > 0 || !dirty}
            data-testid="delegation-save"
          >
            {t('delegation.save')}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

function SummaryLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="xs" c="dimmed" w={110} style={{ flexShrink: 0 }}>{label}</Text>
      <Text size="xs" ff={mono ? 'monospace' : undefined} style={{ wordBreak: 'break-all' }}>{value || '—'}</Text>
    </Group>
  );
}
