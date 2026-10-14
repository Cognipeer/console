'use client';

import { useMemo, useState } from 'react';
import { Button, Group, MultiSelect, Pill, SegmentedControl, Select, Stack, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { IamCatalog } from '../api';
import { isOfferableService } from '../catalogModel';
import ResourceSelect from '../pickers/ResourceSelect';
import { useProjects } from '../pickers/lookups';
import type { IamLabels } from '../useIamLabels';
import { resourceKey, type PolicyDraft, type ResourceRef, type WhereMode } from './specModel';

interface WhereSectionProps {
  draft: PolicyDraft;
  patch: (change: Partial<PolicyDraft>) => void;
  catalog: IamCatalog;
  labels: IamLabels;
  showError?: boolean;
}

/**
 * "Where does it apply": anywhere, or limited to services, projects or specific
 * resources. The editor offers one restriction kind at a time; a stored policy
 * that combines several keeps showing all of them ('multiple').
 */
export default function WhereSection({ draft, patch, catalog, labels, showError }: WhereSectionProps) {
  const t = useTranslations('iamCenter');
  const { projects, loading: projectsLoading, error: projectsError } = useProjects();
  const [pendingType, setPendingType] = useState<string | null>(null);
  const [pending, setPending] = useState<ResourceRef | null>(null);

  const modes: Array<{ value: WhereMode; label: string }> = [
    { value: 'any', label: t('where.any') },
    { value: 'services', label: t('where.services') },
    { value: 'projects', label: t('where.projects') },
    { value: 'resources', label: t('where.resources') },
    ...(draft.whereMode === 'multiple' ? [{ value: 'multiple' as const, label: t('where.multiple') }] : []),
  ];

  const showServices = draft.whereMode === 'services' || draft.whereMode === 'multiple';
  const showProjects = draft.whereMode === 'projects' || draft.whereMode === 'multiple';
  const showResources = draft.whereMode === 'resources' || draft.whereMode === 'multiple';

  const serviceOptions = useMemo(
    () =>
      catalog.services
        .filter((s) => isOfferableService(s) || draft.services.includes(s.id))
        .map((s) => ({ value: s.id, label: labels.service(s.id) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [catalog.services, labels, draft.services],
  );

  const projectOptions = useMemo(() => {
    const known = new Map(projects.map((p) => [p.id, p.name]));
    // A project the caller cannot list (or that was deleted) stays removable by its id.
    for (const id of draft.projects) if (!known.has(id)) known.set(id, id);
    return [...known.entries()].map(([value, label]) => ({ value, label }));
  }, [projects, draft.projects]);

  const typeOptions = useMemo(
    () =>
      catalog.resourceTypes
        .map((rt) => ({ value: rt.type, label: labels.resourceType(rt.type) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [catalog.resourceTypes, labels],
  );

  const addPending = () => {
    if (!pending) return;
    const exists = draft.resources.some((r) => resourceKey(r) === resourceKey(pending));
    if (!exists) patch({ resources: [...draft.resources, pending] });
    setPending(null);
  };

  return (
    <Stack gap="md">
      <SegmentedControl
        fullWidth
        value={draft.whereMode}
        onChange={(v) => patch({ whereMode: v as WhereMode })}
        data={modes}
        orientation="horizontal"
      />
      {draft.whereMode === 'any' ? (
        <Text size="sm" c="dimmed">
          {t('where.anyHelp')}
        </Text>
      ) : null}

      {showServices ? (
        <MultiSelect
          label={t('where.servicesLabel')}
          description={t('where.servicesHelp')}
          placeholder={draft.services.length === 0 ? t('where.servicesPlaceholder') : undefined}
          data={serviceOptions}
          value={draft.services}
          onChange={(services) => patch({ services })}
          searchable
          clearable
          hidePickedOptions
          maxDropdownHeight={260}
          error={showError && draft.whereMode === 'services' && draft.services.length === 0 ? t('validation.services') : undefined}
        />
      ) : null}

      {showProjects ? (
        <MultiSelect
          label={t('where.projectsLabel')}
          description={t('where.projectsHelp')}
          placeholder={draft.projects.length === 0 ? t('where.projectsPlaceholder') : undefined}
          data={projectOptions}
          value={draft.projects}
          onChange={(projectsValue) => patch({ projects: projectsValue })}
          searchable
          clearable
          hidePickedOptions
          maxDropdownHeight={260}
          disabled={projectsLoading && projects.length === 0 && draft.projects.length === 0}
          error={
            projectsError ??
            (showError && draft.whereMode === 'projects' && draft.projects.length === 0 ? t('validation.projects') : undefined)
          }
        />
      ) : null}

      {showResources ? (
        <Stack gap="xs">
          <Text size="sm" fw={500}>
            {t('where.resourcesLabel')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('where.resourcesHelp')}
          </Text>
          <Group align="flex-end" gap="xs" wrap="wrap">
            <Select
              style={{ flex: '1 1 180px' }}
              label={t('where.resourceType')}
              placeholder={t('where.resourceTypePlaceholder')}
              data={typeOptions}
              value={pendingType}
              onChange={(v) => {
                setPendingType(v);
                setPending(null);
              }}
              searchable
              clearable
              maxDropdownHeight={260}
            />
            <div style={{ flex: '2 1 240px' }}>
              <ResourceSelect type={pendingType} label={t('where.resource')} value={pending} onChange={setPending} />
            </div>
            <Button variant="default" leftSection={<IconPlus size={14} />} disabled={!pending} onClick={addPending}>
              {t('common.add')}
            </Button>
          </Group>
          {draft.resources.length > 0 ? (
            <Group gap={6}>
              {draft.resources.map((r) => (
                <Pill
                  key={resourceKey(r)}
                  withRemoveButton
                  title={resourceKey(r)}
                  onRemove={() => patch({ resources: draft.resources.filter((x) => resourceKey(x) !== resourceKey(r)) })}
                  removeButtonProps={{ 'aria-label': t('common.remove') }}
                >
                  {labels.resourceType(r.type)}: {r.label}
                </Pill>
              ))}
            </Group>
          ) : (
            <Text size="xs" c="dimmed">
              {t('where.noResources')}
            </Text>
          )}
          {showError && draft.whereMode === 'resources' && draft.resources.length === 0 ? (
            <Text size="xs" c="red">
              {t('validation.resources')}
            </Text>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
