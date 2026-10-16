'use client';

import { useEffect, useState } from 'react';
import { MultiSelect, SegmentedControl, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { isAbortError } from './client';
import { directoryApi, type ProjectChoice } from './directoryApi';
import { PROJECT_ROLE_CHOICES, setProjectRole, type ProjectRoleChoice, type ProjectSelection } from './projectGrantModel';

/**
 * Pick several projects with a role in each (the projects a new person or service account joins).
 * Loads the workspace's projects itself; a failure to load leaves the field empty and optional.
 */
export default function ProjectRolesField({
  value,
  onChange,
  disabled,
}: {
  value: ProjectSelection;
  onChange: (next: ProjectSelection) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('iamDirectory');
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    directoryApi
      .listProjects(controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setProjects(res.projects);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setProjects([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const select = (ids: string[]) =>
    onChange(ids.map((projectId) => value.find((s) => s.projectId === projectId) ?? { projectId, role: 'member' as ProjectRoleChoice }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <MultiSelect
        aria-label={t('invite.projects.label')}
        searchable
        clearable
        value={value.map((s) => s.projectId)}
        onChange={select}
        disabled={disabled || loading}
        data={projects.map((p) => ({ value: p.id, label: p.name }))}
        placeholder={loading ? t('project.loading') : t('invite.projects.placeholder')}
        nothingFoundMessage={t('project.nothing')}
        comboboxProps={{ withinPortal: true }}
      />
      {value.map((s) => (
        <div key={s.projectId} style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }} data-testid="project-role-row">
          <Text size="sm" fw={500} style={{ wordBreak: 'break-word' }}>
            {nameOf(s.projectId)}
          </Text>
          <SegmentedControl
            size="xs"
            aria-label={t('multi.roleIn', { project: nameOf(s.projectId) })}
            data={PROJECT_ROLE_CHOICES.map((r) => ({ value: r, label: t(`project.roles.${r}`) }))}
            value={s.role}
            disabled={disabled}
            onChange={(role) => onChange(setProjectRole(value, s.projectId, role as ProjectRoleChoice))}
          />
        </div>
      ))}
    </div>
  );
}
