'use client';

import { useMemo } from 'react';
import { ActionIcon, Button, Group, MultiSelect, Select, Tooltip } from '@mantine/core';
import { IconSortAscending, IconSortDescending, IconX } from '@tabler/icons-react';
import PrincipalSelect from '@/components/iam/pickers/PrincipalSelect';
import { useTranslations } from '@/lib/i18n';
import type { ProjectChoice } from './directoryApi';
import {
  activeFilterCount,
  GROUP_SOURCES,
  SCOPED_FILTERS,
  TOKEN_STATUS_FILTERS,
  USER_KINDS,
  USER_ROLES,
  USER_SORTS,
  USER_SOURCES,
  USER_STATUS_FILTERS,
  type ListState,
  type ListType,
} from './listState';

interface FilterBarProps {
  type: ListType;
  state: ListState;
  onChange: (patch: Partial<ListState>) => void;
  onReset: () => void;
  /** The workspace's projects, for the token filter. */
  projects: readonly ProjectChoice[];
  /** The name of the person the token owner filter is set to (when it is set). */
  ownerLabel?: string | null;
  /** The name of the group the people filter is set to (when it is set). */
  groupLabel?: string | null;
}

const compact = { size: 'xs' as const };

/**
 * The filters, sort and reset of the Principals list. A pure view over the list
 * state (which lives in the address bar): every control reports a patch.
 */
export default function FilterBar({ type, state, onChange, onReset, projects, ownerLabel, groupLabel }: FilterBarProps) {
  const t = useTranslations('iamDirectory');
  const narrowed = activeFilterCount(type, state) > 0 || state.q.trim() !== '';

  const options = useMemo(
    () => ({
      roles: USER_ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) })),
      userStatus: USER_STATUS_FILTERS.map((s) => ({ value: s, label: t(`badges.statuses.${s}`) })),
      kinds: USER_KINDS.map((k) => ({ value: k, label: t(`badges.kinds.${k}`) })),
      userSources: USER_SOURCES.map((s) => ({ value: s, label: t(`badges.sources.${s}`) })),
      projects: projects.map((p) => ({ value: p.id, label: p.name })),
      groupSources: GROUP_SOURCES.map((s) => ({ value: s, label: t(`badges.sources.${s}`) })),
      tokenStatus: TOKEN_STATUS_FILTERS.map((s) => ({ value: s, label: t(`badges.statuses.${s}`) })),
      scoped: SCOPED_FILTERS.map((s) => ({ value: s, label: t(`filters.scoped.${s}`) })),
      sorts: USER_SORTS.map((s) => ({ value: s, label: t(`filters.sorts.${s}`) })),
    }),
    [t, projects],
  );

  const projectFilter = (width: number) => (
    <Select
      {...compact}
      w={width}
      clearable
      searchable
      data={options.projects}
      value={state.projectId || null}
      onChange={(projectId) => onChange({ projectId: projectId ?? '' })}
      placeholder={t('filters.project')}
      aria-label={t('filters.project')}
      comboboxProps={{ withinPortal: true }}
    />
  );

  return (
    <Group gap="xs" wrap="wrap" align="flex-end" data-testid="filter-bar">
      {type === 'user' ? (
        <>
          <MultiSelect
            {...compact}
            w={190}
            clearable
            data={options.roles}
            value={state.roles}
            onChange={(roles) => onChange({ roles })}
            placeholder={state.roles.length === 0 ? t('filters.role') : undefined}
            aria-label={t('filters.role')}
            comboboxProps={{ withinPortal: true }}
          />
          <Select
            {...compact}
            w={140}
            clearable
            data={options.userStatus}
            value={state.status || null}
            onChange={(status) => onChange({ status: status ?? '' })}
            placeholder={t('filters.status')}
            aria-label={t('filters.status')}
            comboboxProps={{ withinPortal: true }}
          />
          <Select
            {...compact}
            w={170}
            clearable
            data={options.kinds}
            value={state.kind || null}
            onChange={(kind) => onChange({ kind: kind ?? '' })}
            placeholder={t('filters.kind')}
            aria-label={t('filters.kind')}
            comboboxProps={{ withinPortal: true }}
          />
          <Select
            {...compact}
            w={150}
            clearable
            data={options.userSources}
            value={state.source || null}
            onChange={(source) => onChange({ source: source ?? '' })}
            placeholder={t('filters.source')}
            aria-label={t('filters.source')}
            comboboxProps={{ withinPortal: true }}
          />
          <div style={{ width: 210 }}>
            <PrincipalSelect
              type="group"
              placeholder={t('filters.group')}
              value={state.groupId ? { id: state.groupId, label: groupLabel ?? state.groupId } : null}
              onChange={(next) => onChange({ groupId: next?.id ?? '' })}
            />
          </div>
          {projectFilter(190)}
          <Button
            size="xs"
            variant={state.access === 'requested' ? 'light' : 'default'}
            color={state.access === 'requested' ? 'orange' : undefined}
            aria-pressed={state.access === 'requested'}
            onClick={() => onChange({ access: state.access === 'requested' ? '' : 'requested' })}
            data-testid="requested-access-filter"
          >
            {t('filters.requestedAccess')}
          </Button>
          <Group gap={4} wrap="nowrap">
            <Select
              {...compact}
              w={140}
              allowDeselect={false}
              data={options.sorts}
              value={state.sort}
              onChange={(sort) => sort && onChange({ sort: sort as ListState['sort'] })}
              aria-label={t('filters.sort')}
              comboboxProps={{ withinPortal: true }}
            />
            <Tooltip label={t(state.dir === 'asc' ? 'filters.ascending' : 'filters.descending')} withArrow>
              <ActionIcon
                variant="default"
                size={30}
                aria-label={t(state.dir === 'asc' ? 'filters.ascending' : 'filters.descending')}
                onClick={() => onChange({ dir: state.dir === 'asc' ? 'desc' : 'asc' })}
              >
                {state.dir === 'asc' ? <IconSortAscending size={16} /> : <IconSortDescending size={16} />}
              </ActionIcon>
            </Tooltip>
          </Group>
        </>
      ) : null}

      {type === 'group' ? (
        <>
          <Select
            {...compact}
            w={170}
            clearable
            data={options.groupSources}
            value={state.source || null}
            onChange={(source) => onChange({ source: source ?? '' })}
            placeholder={t('filters.source')}
            aria-label={t('filters.source')}
            comboboxProps={{ withinPortal: true }}
          />
          {projectFilter(190)}
        </>
      ) : null}

      {type === 'token' ? (
        <>
          <Select
            {...compact}
            w={140}
            clearable
            data={options.tokenStatus}
            value={state.status || null}
            onChange={(status) => onChange({ status: status ?? '' })}
            placeholder={t('filters.status')}
            aria-label={t('filters.status')}
            comboboxProps={{ withinPortal: true }}
          />
          <div style={{ width: 230 }}>
            <PrincipalSelect
              type="user"
              placeholder={t('filters.owner')}
              value={state.ownerId ? { id: state.ownerId, label: ownerLabel ?? state.ownerId } : null}
              onChange={(next) => onChange({ ownerId: next?.id ?? '' })}
            />
          </div>
          {projectFilter(190)}
          <Select
            {...compact}
            w={150}
            clearable
            data={options.scoped}
            value={state.scoped || null}
            onChange={(scoped) => onChange({ scoped: scoped ?? '' })}
            placeholder={t('filters.scope')}
            aria-label={t('filters.scope')}
            comboboxProps={{ withinPortal: true }}
          />
        </>
      ) : null}

      {narrowed ? (
        <Button size="compact-xs" variant="subtle" leftSection={<IconX size={12} />} onClick={onReset}>
          {t('filters.reset')}
        </Button>
      ) : null}
    </Group>
  );
}
