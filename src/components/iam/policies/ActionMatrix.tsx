'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Checkbox, Collapse, Group, Pill, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconSearch } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { CatalogService, IamCatalog } from '../api';
import {
  LEVELS,
  SERVICE_CATEGORY_ORDER,
  matchesQuery,
  serviceCategory,
  sortActionIds,
  type CatalogIndex,
  type ServiceCategory,
} from '../catalogModel';
import type { IamLabels } from '../useIamLabels';
import classes from './policyEditor.module.css';

interface ActionMatrixProps {
  catalog: IamCatalog;
  index: CatalogIndex;
  labels: IamLabels;
  /** Selected catalog action ids (level groups, service actions, resource actions). */
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  error?: ReactNode;
}

function LevelChip({
  on,
  label,
  disabled,
  onClick,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${classes.chip} ${on ? classes.chipOn : ''}`}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * "What does the policy cover": a service x level grid (the common case), the
 * three level shortcuts that span every service, and an advanced list of the
 * individual catalog actions (invoke an agent, execute a tool...).
 */
export default function ActionMatrix({ catalog, index, labels, value, onChange, disabled, error }: ActionMatrixProps) {
  const t = useTranslations('iamCenter');
  const [query, setQuery] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const selected = useMemo(() => new Set(value), [value]);

  const toggle = (id: string) => {
    if (disabled) return;
    onChange(selected.has(id) ? value.filter((x) => x !== id) : sortActionIds([...value, id], catalog));
  };

  const categories = useMemo(() => {
    const byCategory = new Map<ServiceCategory, CatalogService[]>();
    for (const service of index.services) {
      if (!index.serviceActions.has(service.id)) continue;
      if (!matchesQuery(`${labels.service(service.id)} ${service.id}`, query)) continue;
      const category = serviceCategory(service.id, service.category);
      byCategory.set(category, [...(byCategory.get(category) ?? []), service]);
    }
    return SERVICE_CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => ({
      category,
      services: byCategory.get(category) ?? [],
    }));
  }, [index, labels, query]);

  const advancedGroups = useMemo(
    () =>
      index.services
        .map((service) => ({
          service,
          actions: (index.resourceActions.get(service.id) ?? []).filter((a) =>
            matchesQuery(`${labels.action(a.id)} ${a.id} ${labels.service(service.id)}`, query),
          ),
        }))
        .filter((g) => g.actions.length > 0),
    [index, labels, query],
  );

  return (
    <div>
      <TextInput
        mb="xs"
        size="xs"
        leftSection={<IconSearch size={14} />}
        placeholder={t('matrix.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        disabled={disabled}
        aria-label={t('matrix.searchPlaceholder')}
      />

      <div className={classes.matrix}>
        <div className={classes.matrixScroll}>
          <div className={`${classes.row} ${classes.rowAll}`}>
            <div className={classes.rowName}>
              <strong>{t('matrix.allServices')}</strong>
              <small>{t('matrix.allServicesHint')}</small>
            </div>
            <div className={classes.chips}>
              {index.groupActions.map((action) => (
                <LevelChip
                  key={action.id}
                  on={selected.has(action.id)}
                  label={labels.level(action.level)}
                  disabled={disabled}
                  onClick={() => toggle(action.id)}
                />
              ))}
            </div>
          </div>

          {categories.map(({ category, services }) => (
            <div key={category}>
              <div className={classes.category}>{t(`matrix.categories.${category}`)}</div>
              {services.map((service) => {
                const levels = index.serviceActions.get(service.id);
                return (
                  <div key={service.id} className={classes.row}>
                    <div className={classes.rowName}>
                      {labels.service(service.id)}
                      {service.adminService ? <small>{t('matrix.adminService')}</small> : null}
                    </div>
                    <div className={classes.chips}>
                      {LEVELS.map((level) => {
                        const action = levels?.[level];
                        if (!action) return null;
                        return (
                          <LevelChip
                            key={level}
                            on={selected.has(action.id)}
                            label={labels.level(level)}
                            disabled={disabled}
                            onClick={() => toggle(action.id)}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {categories.length === 0 && advancedGroups.length === 0 ? (
            <Text size="sm" c="dimmed" p="md">
              {t('matrix.noMatches')}
            </Text>
          ) : null}
        </div>
      </div>

      {advancedGroups.length > 0 || advanced ? (
        <div style={{ marginTop: 10 }}>
          <UnstyledButton onClick={() => setAdvanced((o) => !o)} aria-expanded={advanced}>
            <Group gap={4}>
              {advanced ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              <Text size="sm" fw={500}>
                {t('matrix.advanced')}
              </Text>
              <Text size="xs" c="dimmed">
                {t('matrix.advancedHint')}
              </Text>
            </Group>
          </UnstyledButton>
          <Collapse in={advanced || query.trim() !== ''}>
            <div className={classes.matrix} style={{ marginTop: 8 }}>
              <div className={classes.matrixScroll}>
                {advancedGroups.map(({ service, actions }) => (
                  <div key={service.id} className={classes.advancedGroup}>
                    <div className={classes.advancedTitle}>{labels.service(service.id)}</div>
                    <div className={classes.advancedGrid}>
                      {actions.map((action) => (
                        <Checkbox
                          key={action.id}
                          size="xs"
                          className={classes.advancedItem}
                          checked={selected.has(action.id)}
                          disabled={disabled}
                          onChange={() => toggle(action.id)}
                          label={
                            <>
                              {labels.action(action.id)}
                              <code>{action.id}</code>
                            </>
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Collapse>
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Text size="xs" c="dimmed" mb={4}>
          {t('matrix.selected', { count: value.length })}
        </Text>
        {value.length > 0 ? (
          <div className={classes.selectedBox}>
            {value.map((id) => (
              <Pill
                key={id}
                withRemoveButton={!disabled}
                onRemove={() => toggle(id)}
                title={id}
                removeButtonProps={{ 'aria-label': t('common.remove') }}
              >
                {labels.action(id)}
              </Pill>
            ))}
          </div>
        ) : (
          <Text size="xs" c="dimmed">
            {t('matrix.nothingSelected')}
          </Text>
        )}
      </div>
      {error ? (
        <Text size="xs" c="red" mt={6}>
          {error}
        </Text>
      ) : null}
    </div>
  );
}
