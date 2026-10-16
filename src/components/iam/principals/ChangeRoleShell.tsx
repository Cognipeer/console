'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Group, Loader, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle, IconShieldHalf } from '@tabler/icons-react';
import FormShell, { ChipPicker, FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { LEVEL_ORDER } from './permissionModel';
import type { AccessPreview } from './directoryApi';
import { directoryApi } from './directoryApi';
import { DecisionLink, FormError } from './errors';
import { useServiceLabels } from './serviceLabels';
import { useAccessPreview } from './useAccessPreview';
import type { ServicePermissionLevel } from '@/lib/security/rbac';

export interface RoleTarget {
  id: string;
  name: string;
  email: string;
  role: string;
  /** The signed-in person: nobody changes their own role. */
  isSelf: boolean;
}

interface ChangeRoleShellProps {
  open: boolean;
  person: RoleTarget | null;
  /** The roles the signed-in person may hand out (from the person's `assignableRoles`). */
  assignableRoles: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}

const ROLE_ORDER = ['admin', 'project_admin', 'user', 'portal_user'] as const;

/** Services whose level the draft raises or lowers, from the preview's `changes`. */
export function splitChanges(preview: AccessPreview | null): {
  gained: AccessPreview['changes'];
  lost: AccessPreview['changes'];
} {
  const level = (v: string) => LEVEL_ORDER[(v in LEVEL_ORDER ? v : 'none') as ServicePermissionLevel];
  const gained: AccessPreview['changes'] = [];
  const lost: AccessPreview['changes'] = [];
  for (const change of preview?.changes ?? []) {
    if (level(change.to) > level(change.from)) gained.push(change);
    else if (level(change.to) < level(change.from)) lost.push(change);
  }
  return { gained, lost };
}

/** What changing a person's role does, with the engine's own preview of the services gained and lost. */
export default function ChangeRoleShell({ open, person, assignableRoles, onClose, onSaved }: ChangeRoleShellProps) {
  const t = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const { labelOf } = useServiceLabels();
  const [role, setRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const personId = person?.id;
  useEffect(() => {
    if (!person) return;
    setRole(person.role);
    setError(null);
    setSaving(false);
    // Re-seed only when another person is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, open]);

  const current = person?.role ?? '';
  const isOwner = current === 'owner';
  const locked = isOwner || Boolean(person?.isSelf);
  const changed = role !== '' && role !== current;
  const options = useMemo(
    () =>
      ROLE_ORDER.filter((r) => assignableRoles.includes(r) || r === current).map((r) => ({
        value: r,
        label: (
          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left' }}>
            <span>{t(`roles.${r}`)}</span>
            <span className="ds-faint" style={{ fontSize: 11, fontWeight: 400 }}>
              {t(`roles.hints.${r}`)}
            </span>
          </span>
        ),
      })),
    [assignableRoles, current, t],
  );

  const preview = useAccessPreview(person?.id ?? null, open && changed && !locked ? { role } : null);
  const { gained, lost } = splitChanges(preview.preview);
  const adminChange = role === 'admin' || current === 'admin';

  if (!person) return null;

  const save = async () => {
    if (!changed || locked || saving) return;
    setSaving(true);
    setError(null);
    try {
      await directoryApi.patchUser(person.id, { role });
      notifications.show({
        title: tCommon('success'),
        message: t('role.saved', { name: person.name || person.email, role: t(`roles.${role}`) }),
        color: 'green',
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const summary = (
    <>
      <SummaryGroup title={t('role.summary.person')}>
        <SummaryKV label={t('role.summary.name')} value={person.name || person.email} />
        <SummaryKV label={t('role.summary.current')} value={<Badge variant="default" radius="sm">{t(`roles.${current}`)}</Badge>} />
        <SummaryKV
          label={t('role.summary.new')}
          value={
            changed ? (
              <Badge variant="light" radius="sm">{t(`roles.${role}`)}</Badge>
            ) : (
              <span className="ds-faint">—</span>
            )
          }
        />
      </SummaryGroup>
      <SummaryGroup title={t('role.summary.effect')}>
        <Text size="xs" c="dimmed">
          {t('role.propagation')}
        </Text>
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={open}
      onClose={onClose}
      icon={<IconShieldHalf size={16} />}
      title={t('role.title', { name: person.name || person.email })}
      subtitle={t('role.subtitle')}
      summary={summary}
      disableEscape={saving}
      primaryAction={{
        label: t('role.save'),
        loading: saving,
        disabled: !changed || locked,
        onClick: () => void save(),
      }}
      secondaryAction={{ label: t('common.cancel'), onClick: onClose, disabled: saving }}
    >
      {locked ? (
        <Alert color="orange" variant="light" icon={<IconInfoCircle size={16} />} data-testid="role-locked">
          {t(isOwner ? 'role.lockedOwner' : 'role.lockedSelf')}
        </Alert>
      ) : null}

      <FormSection number={1} title={t('role.section')} description={t('role.sectionHint')} done={changed}>
        <ChipPicker
          options={options}
          value={role}
          onChange={(next) => {
            if (!locked) setRole(next as string);
          }}
        />
        {adminChange && !locked ? (
          <Alert color="grape" variant="light" mt="sm" icon={<IconInfoCircle size={16} />} data-testid="admin-callout">
            {t(role === 'admin' ? 'role.adminGrant' : 'role.adminRemoval')}
          </Alert>
        ) : null}
      </FormSection>

      <FormSection number={2} title={t('role.impact')} description={t('role.impactHint')} done={changed && !preview.loading}>
        {!changed || locked ? (
          <Text size="sm" c="dimmed">
            {t('role.impactIdle')}
          </Text>
        ) : preview.loading ? (
          <Group gap="xs" role="status">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              {t('role.impactLoading')}
            </Text>
          </Group>
        ) : preview.error ? (
          <Alert color="orange" variant="light" icon={<IconInfoCircle size={16} />} data-testid="role-impact-failed">
            <Group gap={6} wrap="wrap" align="baseline">
              <Text size="sm" component="span">
                {t('role.impactFailed')}
              </Text>
              <DecisionLink error={preview.error} t={t} />
            </Group>
          </Alert>
        ) : preview.preview ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="role-impact">
            <ChangeList title={t('role.gained')} none={t('role.gainedNone')} items={gained} labelOf={labelOf} t={t} kind="gain" />
            <ChangeList title={t('role.lost')} none={t('role.lostNone')} items={lost} labelOf={labelOf} t={t} kind="loss" />
            {preview.preview.projects ? (
              <Text size="sm">
                {t('role.projects', { before: preview.preview.projects.before, after: preview.preview.projects.after })}
              </Text>
            ) : null}
          </div>
        ) : null}
      </FormSection>

      {error ? <FormError error={error} t={t} /> : null}
    </FormShell>
  );
}

function ChangeList({
  title,
  none,
  items,
  labelOf,
  t,
  kind,
}: {
  title: string;
  none: string;
  items: AccessPreview['changes'];
  labelOf: (service: string) => string;
  t: (key: string, values?: Record<string, string | number | undefined | null>) => string;
  kind: 'gain' | 'loss';
}) {
  return (
    <div data-testid={`role-${kind}`}>
      <Text size="sm" fw={600}>
        {title}
      </Text>
      {items.length === 0 ? (
        <Text size="sm" c="dimmed">
          {none}
        </Text>
      ) : (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {items.map((c) => (
            <li key={c.service}>
              <Text size="sm" component="span">
                {labelOf(c.service)}: {t(`matrix.levels.${c.from}`)} → {t(`matrix.levels.${c.to}`)}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
