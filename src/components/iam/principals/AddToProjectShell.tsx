'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Select } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFolderPlus, IconInfoCircle } from '@tabler/icons-react';
import FormShell, { ChipPicker, FormField, FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { isAbortError } from './client';
import { directoryApi, type ProjectChoice } from './directoryApi';
import { FormError } from './errors';

export type ProjectRoleChoice = 'member' | 'project_admin';

export interface ProjectMembershipSubject {
  /** A person joins as a project member; a group is assigned to the project. */
  kind: 'user' | 'group';
  id: string;
  name: string;
  /** Projects they already reach directly (left out of the offer). */
  projectIds: readonly string[];
}

interface AddToProjectShellProps {
  open: boolean;
  subject: ProjectMembershipSubject | null;
  onClose: () => void;
  onDone: () => void;
}

/** A project and a role: a person becomes a member of it, or a group is assigned to it. */
export default function AddToProjectShell({ open, subject, onClose, onDone }: AddToProjectShellProps) {
  const t = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [role, setRole] = useState<ProjectRoleChoice>('member');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const subjectId = subject?.id;
  useEffect(() => {
    if (!open) return;
    setProjectId(null);
    setRole('member');
    setError(null);
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
  }, [open, subjectId]);

  const offered = useMemo(
    () => projects.filter((p) => !(subject?.projectIds ?? []).includes(p.id)),
    [projects, subject],
  );
  const chosen = offered.find((p) => p.id === projectId) ?? null;

  if (!subject) return null;

  const save = async () => {
    if (!chosen || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (subject.kind === 'user') {
        await directoryApi.addProjectMember(chosen.id, { userId: subject.id, role });
      } else {
        await directoryApi.assignGroupProject(subject.id, { projectId: chosen.id, role });
      }
      notifications.show({
        title: tCommon('success'),
        message: t(subject.kind === 'user' ? 'project.addedPerson' : 'project.addedGroup', {
          name: subject.name,
          project: chosen.name,
        }),
        color: 'green',
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const summary = (
    <SummaryGroup title={t('project.summary')}>
      <SummaryKV label={t(subject.kind === 'user' ? 'project.person' : 'project.group')} value={subject.name} />
      <SummaryKV label={t('project.project')} value={chosen?.name ?? <span className="ds-faint">—</span>} />
      <SummaryKV label={t('project.role')} value={t(`project.roles.${role}`)} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={open}
      onClose={onClose}
      icon={<IconFolderPlus size={16} />}
      title={t(subject.kind === 'user' ? 'project.titlePerson' : 'project.titleGroup', { name: subject.name })}
      subtitle={t('project.subtitle')}
      summary={summary}
      disableEscape={saving}
      primaryAction={{
        label: t(subject.kind === 'user' ? 'project.addPerson' : 'project.addGroup'),
        loading: saving,
        disabled: !chosen,
        onClick: () => void save(),
      }}
      secondaryAction={{ label: t('common.cancel'), onClick: onClose, disabled: saving }}
    >
      <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
        {t(subject.kind === 'user' ? 'project.notePerson' : 'project.noteGroup')}
      </Alert>
      <FormSection number={1} title={t('project.section')} description={t('project.sectionHint')} done={Boolean(chosen)}>
        <FormField label={t('project.project')} required>
          <Select
            searchable
            value={projectId}
            onChange={setProjectId}
            disabled={loading || saving}
            data={offered.map((p) => ({ value: p.id, label: p.name }))}
            placeholder={loading ? t('project.loading') : t('project.placeholder')}
            nothingFoundMessage={t('project.nothing')}
            comboboxProps={{ withinPortal: true }}
          />
        </FormField>
      </FormSection>
      <FormSection number={2} title={t('project.roleSection')} description={t('project.roleHint')} done>
        <ChipPicker<ProjectRoleChoice>
          options={[
            { value: 'member', label: t('project.roles.member') },
            { value: 'project_admin', label: t('project.roles.project_admin') },
          ]}
          value={role}
          onChange={(v) => setRole(v as ProjectRoleChoice)}
        />
      </FormSection>
      {error ? <FormError error={error} t={t} /> : null}
    </FormShell>
  );
}
