'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  MultiSelect,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

const SUPPORTED_LANGUAGES = ['global', 'en', 'tr', 'de', 'fr', 'es', 'it', 'pt', 'ar', 'ja', 'zh'] as const;

export interface PiiCustomPatternForm {
  id: string;
  categoryId: string;
  label: string;
  pattern: string;
  flags?: string;
  severity?: 'low' | 'medium' | 'high';
  languages?: string[];
  enabled: boolean;
}

export interface PiiCatalogEntry {
  id: string;
  label: string;
  description: string;
  languages: string[];
  severity: 'low' | 'medium' | 'high';
  defaultEnabled: boolean;
}

interface Props {
  /** Categories on/off map. */
  categories: Record<string, boolean>;
  onCategoriesChange: (next: Record<string, boolean>) => void;
  customPatterns: PiiCustomPatternForm[];
  onCustomPatternsChange: (next: PiiCustomPatternForm[]) => void;
  languages: string[];
  onLanguagesChange: (next: string[]) => void;
  defaultAction: 'detect' | 'redact' | 'mask' | 'block' | 'tokenize';
  onDefaultActionChange: (next: 'detect' | 'redact' | 'mask' | 'block' | 'tokenize') => void;
  /** Loaded category catalog from /api/pii/categories. */
  catalog: PiiCatalogEntry[];
}

function makePatternId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

function isValidRegex(source: string, flags?: string): boolean {
  if (!source) return false;
  try {
    new RegExp(source, flags ?? 'g');
    return true;
  } catch {
    return false;
  }
}

export default function PiiPolicyEditor(props: Props) {
  const t = useTranslations('pii');
  const tAct = useTranslations('pii.actions');
  const tLang = useTranslations('pii.languages');
  const tSev = useTranslations('pii.severity');

  const filteredCatalog = useMemo(() => {
    if (!props.languages.length) return props.catalog;
    const set = new Set(props.languages);
    return props.catalog.filter((c) =>
      c.languages.includes('global') || c.languages.some((l) => set.has(l)),
    );
  }, [props.catalog, props.languages]);

  const toggleCategory = (id: string, value: boolean) => {
    props.onCategoriesChange({ ...props.categories, [id]: value });
  };

  const addPattern = () => {
    props.onCustomPatternsChange([
      ...props.customPatterns,
      {
        id: makePatternId(),
        categoryId: 'custom_pattern',
        label: 'Custom pattern',
        pattern: '',
        flags: 'g',
        severity: 'medium',
        languages: [],
        enabled: true,
      },
    ]);
  };

  const updatePattern = (id: string, partial: Partial<PiiCustomPatternForm>) => {
    props.onCustomPatternsChange(
      props.customPatterns.map((p) => (p.id === id ? { ...p, ...partial } : p)),
    );
  };

  const removePattern = (id: string) => {
    props.onCustomPatternsChange(props.customPatterns.filter((p) => p.id !== id));
  };

  return (
    <Stack gap="lg">
      {/* Default action + Languages */}
      <Paper p="md" withBorder radius="sm">
        <Group grow align="flex-start">
          <Select
            label={t('detail.basics.defaultAction')}
            value={props.defaultAction}
            onChange={(v) => v && props.onDefaultActionChange(v as Props['defaultAction'])}
            data={[
              { value: 'detect', label: tAct('detect') },
              { value: 'redact', label: tAct('redact') },
              { value: 'mask', label: tAct('mask') },
              { value: 'tokenize', label: tAct('tokenize') },
              { value: 'block', label: tAct('block') },
            ]}
            allowDeselect={false}
          />
          <MultiSelect
            label={t('detail.basics.languages')}
            description={t('detail.basics.languagesHelper')}
            value={props.languages}
            onChange={props.onLanguagesChange}
            data={SUPPORTED_LANGUAGES.map((l) => ({ value: l, label: tLang(l) }))}
            searchable
            clearable
          />
        </Group>
      </Paper>

      {/* Built-in categories */}
      <Paper p="md" withBorder radius="sm">
        <Stack gap="xs">
          <div>
            <Text fw={600} size="sm">{t('detail.categories.title')}</Text>
            <Text size="xs" c="dimmed">{t('detail.categories.subtitle')}</Text>
          </div>
          {filteredCatalog.length === 0 ? (
            <Text size="sm" c="dimmed">{t('detail.categories.empty')}</Text>
          ) : (
            <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
              {filteredCatalog.map((c) => {
                const isOn = props.categories[c.id] === true;
                return (
                  <Paper key={c.id} p="sm" withBorder radius="sm" style={{ opacity: isOn ? 1 : 0.75 }}>
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <div style={{ minWidth: 0 }}>
                        <Group gap={6} mb={2}>
                          <Text size="sm" fw={500} style={{ wordBreak: 'break-word' }}>{c.label}</Text>
                          <Badge size="xs" variant="light" color={c.severity === 'high' ? 'red' : c.severity === 'medium' ? 'orange' : 'gray'}>
                            {tSev(c.severity)}
                          </Badge>
                        </Group>
                        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-word' }}>{c.description}</Text>
                        <Group gap={4} mt={4}>
                          {c.languages.map((l) => (
                            <Badge key={l} size="xs">{tLang(l)}</Badge>
                          ))}
                        </Group>
                      </div>
                      <Switch checked={isOn} onChange={(e) => toggleCategory(c.id, e.currentTarget.checked)} />
                    </Group>
                  </Paper>
                );
              })}
            </Box>
          )}
        </Stack>
      </Paper>

      {/* Custom patterns */}
      <Paper p="md" withBorder radius="sm">
        <Stack gap="xs">
          <Group justify="space-between">
            <div>
              <Text fw={600} size="sm">{t('detail.customPatterns.title')}</Text>
              <Text size="xs" c="dimmed">{t('detail.customPatterns.subtitle')}</Text>
            </div>
            <Button size="xs" leftSection={<IconPlus size={12} />} variant="light" onClick={addPattern}>
              {t('detail.customPatterns.addRow')}
            </Button>
          </Group>
          {props.customPatterns.length === 0 ? (
            <Text size="sm" c="dimmed">{t('detail.customPatterns.emptyHint')}</Text>
          ) : (
            <Stack gap="xs">
              {props.customPatterns.map((p) => {
                const valid = isValidRegex(p.pattern, p.flags);
                return (
                  <Paper key={p.id} p="sm" withBorder radius="sm">
                    <Group align="flex-end" wrap="wrap" gap="xs">
                      <TextInput
                        label={t('detail.customPatterns.categoryId')}
                        value={p.categoryId}
                        onChange={(e) => updatePattern(p.id, { categoryId: e.currentTarget.value })}
                        style={{ minWidth: 140 }}
                      />
                      <TextInput
                        label={t('detail.customPatterns.label')}
                        value={p.label}
                        onChange={(e) => updatePattern(p.id, { label: e.currentTarget.value })}
                        style={{ minWidth: 160 }}
                      />
                      <TextInput
                        label={t('detail.customPatterns.regex')}
                        value={p.pattern}
                        onChange={(e) => updatePattern(p.id, { pattern: e.currentTarget.value })}
                        style={{ minWidth: 260, flex: 1 }}
                        error={p.pattern && !valid ? t('detail.customPatterns.invalidRegex') : undefined}
                        styles={{ input: { fontFamily: 'var(--ds-font-mono, monospace)' } }}
                      />
                      <TextInput
                        label={t('detail.customPatterns.flags')}
                        value={p.flags ?? ''}
                        onChange={(e) => updatePattern(p.id, { flags: e.currentTarget.value })}
                        style={{ width: 70 }}
                      />
                      <Select
                        label={t('detail.customPatterns.severity')}
                        value={p.severity ?? 'medium'}
                        onChange={(v) => v && updatePattern(p.id, { severity: v as PiiCustomPatternForm['severity'] })}
                        data={[
                          { value: 'low', label: tSev('low') },
                          { value: 'medium', label: tSev('medium') },
                          { value: 'high', label: tSev('high') },
                        ]}
                        style={{ width: 110 }}
                        allowDeselect={false}
                      />
                      <MultiSelect
                        label={t('detail.customPatterns.languages')}
                        value={p.languages ?? []}
                        onChange={(v) => updatePattern(p.id, { languages: v })}
                        data={SUPPORTED_LANGUAGES.map((l) => ({ value: l, label: tLang(l) }))}
                        style={{ minWidth: 170 }}
                        clearable
                      />
                      <Switch
                        label={t('detail.customPatterns.enabled')}
                        checked={p.enabled}
                        onChange={(e) => updatePattern(p.id, { enabled: e.currentTarget.checked })}
                      />
                      <Tooltip label={t('detail.customPatterns.remove')}>
                        <ActionIcon color="red" variant="subtle" onClick={() => removePattern(p.id)}>
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Paper>
                );
              })}
            </Stack>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
