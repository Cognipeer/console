'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Checkbox, Loader, SegmentedControl, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFolderPlus, IconInfoCircle, IconLock, IconSearch } from '@tabler/icons-react';
import FormShell, { ChipPicker, FormSection, SummaryGroup, SummaryKV, ToggleRow } from '@/components/common/ui/FormShell';
import ProjectPermissionsEditor from '@/components/projects/ProjectPermissionsEditor';
import { useTranslations } from '@/lib/i18n';
import type { UserServicePermissions } from '@/lib/security/rbac';
import type { ProjectMembershipSubject } from './AddToProjectShell';
import { iamLinks, isAbortError } from './client';
import { directoryApi, type ProjectChoice } from './directoryApi';
import { FormError } from './errors';
import {
  buildAddRequest,
  buildOffers,
  isPickable,
  PROJECT_ROLE_CHOICES,
  pruneSelection,
  setAllRoles,
  setProjectRole,
  skipReasonKey,
  summarizeAddResult,
  toggleProject,
  type AddProjectsOutcome,
  type ProjectOffer,
  type ProjectRoleChoice,
  type ProjectSelection,
} from './projectGrantModel';

interface Props {
  open: boolean;
  subject: ProjectMembershipSubject;
  onClose: () => void;
  onDone: () => void;
}

/** Past this many projects the list gets a search box. */
const SEARCH_FROM = 8;

type Access = 'default' | 'custom';

/**
 * Add one person to several projects at once: a role per project, projects they are already in
 * shown locked with the reason, the service access they get (each project's default, or one custom
 * set applied to all), and an optional notification. External accounts never join a project.
 */
export default function AddUserProjectsShell({ open, subject, onClose, onDone }: Props) {
  const t = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<ProjectSelection>([]);
  const [filter, setFilter] = useState('');
  const [access, setAccess] = useState<Access>('default');
  const [custom, setCustom] = useState<UserServicePermissions | null>(null);
  const [editingAccess, setEditingAccess] = useState(false);
  const [notify, setNotify] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<AddProjectsOutcome | null>(null);

  const subjectId = subject.id;
  const external = subject.external === true;
  useEffect(() => {
    if (!open || external) return;
    setSelection([]);
    setFilter('');
    setAccess('default');
    setCustom(null);
    setNotify(false);
    setError(null);
    setOutcome(null);
    setSaving(false);
    const controller = new AbortController();
    setLoading(true);
    directoryApi
      .listProjects(controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setProjects(res.projects);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, subjectId, external]);

  const offers = useMemo(() => buildOffers(projects, subject.memberships ?? []), [projects, subject.memberships]);
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? offers.filter((o) => o.name.toLowerCase().includes(needle)) : offers;
  }, [offers, filter]);
  const picked = useMemo(() => pruneSelection(selection, offers), [selection, offers]);
  const roleOf = (id: string) => picked.find((s) => s.projectId === id)?.role;
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

  const sourceText = (offer: ProjectOffer): string => {
    const source = offer.source;
    if (!source) return '';
    if (source.kind === 'group') return t('drawer.projects.source.group', { name: source.groupName ?? t('drawer.projects.source.groupUnnamed') });
    return t(`drawer.projects.source.${source.kind}`);
  };

  const save = async () => {
    if (picked.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body = buildAddRequest({ selection: picked, custom: access === 'custom' ? custom : null, notify });
      const result = await directoryApi.addUserProjects(subject.id, body);
      const summary = summarizeAddResult(result, nameOf);
      notifications.show({
        title: tCommon('success'),
        message: t('multi.done', { name: subject.name, added: summary.added, updated: summary.updated }),
        color: summary.skipped.length > 0 ? 'yellow' : 'green',
      });
      onDone();
      if (summary.skipped.length === 0) onClose();
      else {
        setOutcome(summary);
        setSelection([]);
      }
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  if (external) {
    return (
      <FormShell
        open={open}
        onClose={onClose}
        icon={<IconFolderPlus size={16} />}
        title={t('project.titlePerson', { name: subject.name })}
        subtitle={t('project.subtitle')}
        secondaryAction={{ label: t('common.cancel'), onClick: onClose }}
      >
        <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />} data-testid="external-no-projects">
          {t('multi.externalNote')}
        </Alert>
      </FormShell>
    );
  }

  const summary = (
    <SummaryGroup title={t('project.summary')}>
      <SummaryKV label={t('project.person')} value={subject.name} />
      <SummaryKV label={t('multi.projects')} value={picked.length > 0 ? String(picked.length) : <span className="ds-faint">—</span>} />
      {picked.map((s) => (
        <SummaryKV key={s.projectId} label={nameOf(s.projectId)} value={t(`project.roles.${s.role}`)} />
      ))}
      <SummaryKV label={t('multi.accessLabel')} value={access === 'custom' ? t('multi.access.custom') : t('multi.access.default')} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={open}
      onClose={onClose}
      icon={<IconFolderPlus size={16} />}
      title={t('project.titlePerson', { name: subject.name })}
      subtitle={t('multi.subtitle')}
      summary={summary}
      disableEscape={saving}
      primaryAction={{
        label: t('multi.submit', { count: picked.length }),
        loading: saving,
        disabled: picked.length === 0 || (access === 'custom' && !custom),
        onClick: () => void save(),
      }}
      secondaryAction={{ label: t('common.cancel'), onClick: onClose, disabled: saving }}
    >
      <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
        {t('project.notePerson')}
      </Alert>

      <FormSection number={1} title={t('multi.section')} description={t('multi.sectionHint')} done={picked.length > 0}>
        {loading ? (
          <Loader size="sm" aria-label={t('project.loading')} />
        ) : offers.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('project.nothing')}
          </Text>
        ) : (
          <>
            {offers.length > SEARCH_FROM ? (
              <TextInput
                aria-label={t('multi.search')}
                placeholder={t('multi.search')}
                leftSection={<IconSearch size={14} />}
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value)}
              />
            ) : null}
            {picked.length > 1 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Text size="xs" c="dimmed">
                  {t('multi.sameRole')}
                </Text>
                <SegmentedControl
                  size="xs"
                  aria-label={t('multi.sameRole')}
                  data={PROJECT_ROLE_CHOICES.map((r) => ({ value: r, label: t(`project.roles.${r}`) }))}
                  value={picked.every((s) => s.role === picked[0]!.role) ? picked[0]!.role : ''}
                  onChange={(value) => setSelection(setAllRoles(picked, value as ProjectRoleChoice))}
                />
              </div>
            ) : null}
            <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--ds-border)', borderRadius: 8 }} data-testid="project-offers">
              {visible.map((offer) => {
                const role = roleOf(offer.id);
                const locked = !isPickable(offer);
                return (
                  <div
                    key={offer.id}
                    data-testid="project-offer"
                    data-state={offer.state}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--ds-border)', opacity: locked ? 0.75 : 1 }}
                  >
                    <Checkbox
                      aria-label={offer.name}
                      checked={Boolean(role)}
                      disabled={locked || saving}
                      onChange={() => setSelection(toggleProject(picked, offer.id))}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text size="sm" fw={500} style={{ wordBreak: 'break-word' }}>
                        {offer.name}
                      </Text>
                      {offer.state !== 'free' ? (
                        <Text size="xs" c="dimmed" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {locked ? <IconLock size={11} aria-hidden /> : null}
                          {locked
                            ? t('multi.locked', { role: offer.currentRole ? t(`project.roles.${offer.currentRole === 'project_admin' ? 'project_admin' : 'member'}`) : '' })
                            : t('multi.inherited', { source: sourceText(offer) })}
                          {offer.source?.kind === 'group' && offer.source.groupId ? (
                            <Link href={iamLinks.principal('group', offer.source.groupId)} style={{ color: 'inherit' }}>
                              {t('multi.openGroup')}
                            </Link>
                          ) : null}
                        </Text>
                      ) : null}
                    </div>
                    {locked ? (
                      <Badge size="sm" variant="default" tt="none">
                        {t('multi.member')}
                      </Badge>
                    ) : role ? (
                      <SegmentedControl
                        size="xs"
                        aria-label={t('multi.roleIn', { project: offer.name })}
                        data={PROJECT_ROLE_CHOICES.map((r) => ({ value: r, label: t(`project.roles.${r}`) }))}
                        value={role}
                        disabled={saving}
                        onChange={(value) => setSelection(setProjectRole(picked, offer.id, value as ProjectRoleChoice))}
                      />
                    ) : null}
                  </div>
                );
              })}
              {visible.length === 0 ? (
                <Text size="sm" c="dimmed" p="sm">
                  {t('project.nothing')}
                </Text>
              ) : null}
            </div>
          </>
        )}
      </FormSection>

      <FormSection number={2} title={t('multi.accessSection')} description={t('multi.accessHint')} done>
        <ChipPicker<Access>
          options={[
            { value: 'default', label: t('multi.access.default') },
            { value: 'custom', label: t('multi.access.custom') },
          ]}
          value={access}
          onChange={(value) => setAccess(value as Access)}
        />
        {access === 'custom' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Button size="xs" variant="light" disabled={picked.length === 0} onClick={() => setEditingAccess(true)}>
              {t('multi.editAccess')}
            </Button>
            <Text size="xs" c="dimmed">
              {picked.length === 0 ? t('multi.pickFirst') : custom ? t('multi.customSet', { count: picked.length }) : t('multi.customUnset')}
            </Text>
          </div>
        ) : null}
      </FormSection>

      <FormSection number={3} title={t('multi.notifySection')} done>
        <ToggleRow label={t('multi.notify')} description={t('multi.notifyHint')} checked={notify} onChange={setNotify} disabled={saving} />
      </FormSection>

      {outcome ? (
        <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />} title={t('multi.skippedTitle')} data-testid="skipped">
          {outcome.skipped.map((s) => (
            <div key={s.projectId}>
              {s.name}
              {': '}
              {t(`multi.skip.${skipReasonKey(s.reason)}`)}
            </div>
          ))}
        </Alert>
      ) : null}
      {error ? <FormError error={error} t={t} /> : null}

      {editingAccess && picked[0] ? (
        <ProjectPermissionsEditor
          member={{ userId: subject.id, name: subject.name, email: '', role: 'user', servicePermissions: custom, ignoredServices: [] }}
          projectId={picked[0].projectId}
          saving={false}
          onClose={() => setEditingAccess(false)}
          onSave={(permissions) => {
            setCustom(permissions);
            setEditingAccess(false);
          }}
        />
      ) : null}
    </FormShell>
  );
}
