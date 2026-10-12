'use client';

import { useMemo, useState } from 'react';
import { Badge, Button, Group, SegmentedControl, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { PermissionService, ServicePermissionLevel } from '@/lib/security/rbac';
import {
  MATRIX_SERVICES,
  overrideCount,
  PERMISSION_CHOICES,
  resetDraft,
  roleDefaultLevel,
  type MatrixDraft,
  type PermissionChoice,
} from './permissionModel';
import { useServiceLabels } from './serviceLabels';
import { LEVEL_COLOR } from './visuals';

type FilterMode = 'all' | 'overrides';

interface ServicePermissionMatrixProps {
  draft: MatrixDraft;
  onChange: (next: MatrixDraft) => void;
  /**
   * The role whose default each service shows when nothing is chosen: a person's
   * role, or the tenant role of a group (null = the group gives no role).
   */
  role: string | null;
  /** A person's access, or the grants of a group (the wording differs). */
  mode: 'person' | 'group';
  disabled?: boolean;
}

/**
 * One matrix for every place a person or a group gets per-service access: each
 * service is either "role default" (nothing is stored) or an explicit level,
 * including an explicit "no access". Unset is never shown as "None", and only
 * what was chosen is saved.
 */
export default function ServicePermissionMatrix({ draft, onChange, role, mode, disabled }: ServicePermissionMatrixProps) {
  const t = useTranslations('iamDirectory');
  const { labelOf } = useServiceLabels();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');

  const overrides = overrideCount(draft.choices);
  const inheritLabel = mode === 'group' && !role ? t('matrix.choices.noGrant') : t('matrix.choices.inherit');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return MATRIX_SERVICES.filter((service) => {
      if (filter === 'overrides' && (draft.choices[service.id] ?? 'inherit') === 'inherit') return false;
      if (!q) return true;
      return service.id.toLowerCase().includes(q) || labelOf(service.id).toLowerCase().includes(q);
    });
  }, [draft.choices, filter, query, labelOf]);

  const choiceLabel = (choice: PermissionChoice) =>
    choice === 'inherit' ? inheritLabel : t(`matrix.levels.${choice}`);

  const set = (service: PermissionService, choice: PermissionChoice) =>
    onChange({ ...draft, choices: { ...draft.choices, [service]: choice } });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Text size="sm" c="dimmed">
        {t(mode === 'group' ? 'matrix.hint.group' : 'matrix.hint.person')}
      </Text>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextInput
          size="xs"
          leftSection={<IconSearch size={14} />}
          placeholder={t('matrix.search')}
          aria-label={t('matrix.search')}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          style={{ flex: '1 1 220px', maxWidth: 320 }}
        />
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(v) => setFilter(v as FilterMode)}
          data={[
            { value: 'all', label: t('matrix.filterAll') },
            { value: 'overrides', label: t('matrix.filterOverrides', { count: overrides }) },
          ]}
        />
        <Button
          size="compact-xs"
          variant="subtle"
          disabled={disabled || overrides === 0}
          onClick={() => onChange(resetDraft(draft))}
        >
          {t(mode === 'group' ? 'matrix.resetGroup' : 'matrix.reset')}
        </Button>
      </div>

      <div className="ds-tbl-wrap" style={{ border: '1px solid var(--ds-border-soft)', borderRadius: 8, overflowX: 'auto' }}>
        <table className="ds-tbl" data-testid="permission-matrix">
          <thead>
            <tr>
              <th>{t('matrix.columns.service')}</th>
              <th style={{ width: 150 }}>{t(mode === 'group' ? 'matrix.columns.roleDefaultGroup' : 'matrix.columns.roleDefault')}</th>
              <th style={{ width: 380 }}>{t('matrix.columns.setting')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <Text size="sm" c="dimmed" ta="center" py="md">
                    {t('matrix.empty')}
                  </Text>
                </td>
              </tr>
            ) : (
              rows.map((service) => {
                const choice = draft.choices[service.id] ?? 'inherit';
                const fallback: ServicePermissionLevel = roleDefaultLevel(role, service.id);
                const label = labelOf(service.id);
                return (
                  <tr key={service.id} data-service={service.id}>
                    <td>
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm" fw={500}>
                          {label}
                        </Text>
                        {service.adminService ? (
                          <Badge size="xs" variant="light" color="grape">
                            {t('matrix.adminService')}
                          </Badge>
                        ) : null}
                      </Group>
                      <Text size="xs" c="dimmed" ff="monospace">
                        {service.id}
                      </Text>
                    </td>
                    <td>
                      <Badge variant={fallback === 'none' ? 'default' : 'light'} color={LEVEL_COLOR[fallback]} radius="sm">
                        {t(`matrix.levels.${fallback}`)}
                      </Badge>
                    </td>
                    <td>
                      <SegmentedControl
                        size="xs"
                        fullWidth
                        disabled={disabled}
                        value={choice}
                        aria-label={`${label}: ${t('matrix.columns.setting')}`}
                        onChange={(value) => set(service.id, value as PermissionChoice)}
                        data={PERMISSION_CHOICES.map((c) => ({ value: c, label: choiceLabel(c) }))}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
