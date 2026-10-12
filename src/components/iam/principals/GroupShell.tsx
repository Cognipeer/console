'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Text, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle, IconUsersGroup } from '@tabler/icons-react';
import FormShell, {
  ChipPicker,
  FormField,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import type { UserServicePermissions } from '@/lib/security/rbac';
import { directoryApi } from './directoryApi';
import { FormError } from './errors';
import { ManagedBanner } from './managed';
import { overrideCount, readDraft, sameDraft, toPermissions, type MatrixDraft } from './permissionModel';
import ServicePermissionMatrix from './ServicePermissionMatrix';

export interface GroupEditTarget {
  id: string;
  name: string;
  description: string;
  /** The workspace role every member gets; '' = none. */
  tenantRole: string;
  /** The group's per-service grants; null when the server did not send them (then they are left alone). */
  servicePermissions: UserServicePermissions | null;
  /** local, or ldap (a directory group: its name is the directory's). */
  source: string;
  memberCount: number | null;
}

interface GroupShellProps {
  open: boolean;
  /** The group to edit; null creates a new one. */
  group: GroupEditTarget | null;
  onClose: () => void;
  /** After a save; `id` is the id of a group that was just created. */
  onSaved: (id?: string) => void;
}

type RoleChoice = '' | 'user' | 'project_admin' | 'admin';
const ROLE_CHOICES: readonly RoleChoice[] = ['', 'user', 'project_admin', 'admin'];

/** The PATCH body of an edit: only what changed (a missing grants map is never written). */
export function groupPatch(
  stored: GroupEditTarget,
  draft: { name: string; description: string; tenantRole: RoleChoice; matrix: MatrixDraft },
  baseline: MatrixDraft | null,
): { name?: string; description?: string; tenantRole?: string | null; servicePermissions?: UserServicePermissions } {
  const patch: ReturnType<typeof groupPatch> = {};
  if (stored.source === 'local' && draft.name.trim() !== stored.name) patch.name = draft.name.trim();
  if (draft.description.trim() !== stored.description) patch.description = draft.description.trim();
  if (draft.tenantRole !== stored.tenantRole) patch.tenantRole = draft.tenantRole === '' ? null : draft.tenantRole;
  if (baseline && !sameDraft(baseline, draft.matrix)) patch.servicePermissions = toPermissions(draft.matrix);
  return patch;
}

/** Create or edit a group: its name, the workspace role it gives, and per-service grants. */
export default function GroupShell({ open, group, onClose, onSaved }: GroupShellProps) {
  const t = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const editing = group !== null;
  const directory = editing && group.source !== 'local';

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tenantRole, setTenantRole] = useState<RoleChoice>('');
  const [matrix, setMatrix] = useState<MatrixDraft>(() => readDraft({}));
  const [baseline, setBaseline] = useState<MatrixDraft | null>(() => readDraft({}));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const groupId = group?.id;
  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setDescription(group?.description ?? '');
    setTenantRole(((group?.tenantRole ?? '') as RoleChoice) || '');
    const stored = group ? (group.servicePermissions ? readDraft(group.servicePermissions) : null) : readDraft({});
    setMatrix(stored ?? readDraft({}));
    setBaseline(stored);
    setError(null);
    setSaving(false);
    // Re-seed only when the form is (re)opened or another group is edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groupId]);

  const validName = name.trim().length > 0;
  const patch = useMemo(
    () => (group ? groupPatch(group, { name, description, tenantRole, matrix }, baseline) : null),
    [group, name, description, tenantRole, matrix, baseline],
  );
  const dirty = editing ? Object.keys(patch ?? {}).length > 0 : validName;
  const canSave = validName && dirty && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (group && patch) {
        await directoryApi.patchGroup(group.id, patch);
        notifications.show({ title: tCommon('success'), message: t('group.updated', { name: name.trim() }), color: 'green' });
        onSaved();
      } else {
        const id = await directoryApi.createGroup({
          name: name.trim(),
          description: description.trim() || undefined,
          tenantRole: tenantRole === '' ? null : tenantRole,
          servicePermissions: toPermissions(matrix),
        });
        notifications.show({ title: tCommon('success'), message: t('group.created', { name: name.trim() }), color: 'green' });
        onSaved(id || undefined);
      }
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const summary = (
    <>
      <SummaryGroup title={t('group.summary')}>
        <SummaryKV label={t('group.name')} value={name.trim() || <span className="ds-faint">—</span>} />
        <SummaryKV
          label={t('group.role')}
          value={tenantRole ? t(`roles.${tenantRole}`) : <span className="ds-faint">{t('group.noRole')}</span>}
        />
        <SummaryKV label={t('group.grants')} value={overrideCount(matrix.choices)} />
        {editing && group?.memberCount !== null && group?.memberCount !== undefined ? (
          <SummaryKV label={t('group.members')} value={group.memberCount.toLocaleString()} />
        ) : null}
        {editing ? <SummaryKV label={t('group.source')} value={t(`badges.sources.${group.source}`)} /> : null}
      </SummaryGroup>
      <SummaryGroup title={t('group.raiseOnly')}>
        <Text size="xs" c="dimmed">
          {t('group.raiseOnlyBody')}
        </Text>
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={open}
      onClose={onClose}
      icon={<IconUsersGroup size={16} />}
      title={editing ? t('group.editTitle', { name: group.name }) : t('group.createTitle')}
      subtitle={t(editing ? 'group.editSubtitle' : 'group.createSubtitle')}
      summary={summary}
      disableEscape={saving}
      primaryAction={{
        label: t(editing ? 'group.save' : 'group.create'),
        loading: saving,
        disabled: !canSave,
        onClick: () => void save(),
      }}
      secondaryAction={{ label: t('common.cancel'), onClick: onClose, disabled: saving }}
    >
      {directory ? <ManagedBanner provider={group.source} fields={t('group.directoryFields')} /> : null}

      <FormSection number={1} title={t('group.identity')} description={t('group.identityHint')} done={validName}>
        <FormField label={t('group.name')} required>
          <TextInput value={name} onChange={(e) => setName(e.currentTarget.value)} disabled={directory} maxLength={120} />
        </FormField>
        <FormField label={t('group.description')} optional>
          <Textarea value={description} onChange={(e) => setDescription(e.currentTarget.value)} autosize minRows={2} />
        </FormField>
      </FormSection>

      <FormSection number={2} title={t('group.roleSection')} description={t('group.roleHint')} done>
        <ChipPicker<RoleChoice>
          options={ROLE_CHOICES.map((r) => ({
            value: r,
            label: (
              <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left' }}>
                <span>{r === '' ? t('group.noRole') : t(`roles.${r}`)}</span>
                <span className="ds-faint" style={{ fontSize: 11, fontWeight: 400 }}>
                  {r === '' ? t('group.noRoleHint') : t(`roles.hints.${r}`)}
                </span>
              </span>
            ),
          }))}
          value={tenantRole}
          onChange={(v) => setTenantRole(v as RoleChoice)}
        />
      </FormSection>

      <FormSection number={3} title={t('group.grantsSection')} description={t('group.grantsHint')} done collapsible defaultOpen>
        {baseline === null ? (
          <Alert color="orange" variant="light" icon={<IconInfoCircle size={16} />} data-testid="grants-unavailable">
            {t('group.grantsUnavailable')}
          </Alert>
        ) : (
          <ServicePermissionMatrix draft={matrix} onChange={setMatrix} role={tenantRole || null} mode="group" disabled={saving} />
        )}
      </FormSection>

      {error ? <FormError error={error} t={t} /> : null}
    </FormShell>
  );
}
