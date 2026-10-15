'use client';

import { ActionIcon, Button, Group, NumberInput, Paper, SegmentedControl, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { IAgentKnowledgeBinding } from '@/lib/database/provider/types.domain';

interface Props {
  modules: Array<{ key: string; name: string }>;
  bindings: IAgentKnowledgeBinding[];
  mode: 'combined' | 'separate';
  onBindingsChange: (next: IAgentKnowledgeBinding[]) => void;
  onModeChange: (mode: 'combined' | 'separate') => void;
}

/** Compact list editor: several knowledge bases per agent + combined/separate tool mode. */
export function KnowledgeBindingsEditor({ modules, bindings, mode, onBindingsChange, onModeChange }: Props) {
  const t = useTranslations('agents');
  const patch = (index: number, change: Partial<IAgentKnowledgeBinding>) =>
    onBindingsChange(bindings.map((b, i) => (i === index ? { ...b, ...change } : b)));
  const taken = new Set(bindings.map((b) => b.key));

  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">{t('config.knowledgeBindingsDescription')}</Text>
      {bindings.map((binding, index) => (
        <Paper key={index} withBorder p="xs">
          <Stack gap={6}>
            <Group gap="xs" wrap="nowrap" align="flex-end">
              <Select
                style={{ flex: 1 }}
                placeholder={t('config.knowledgeEnginePlaceholder')}
                data={modules
                  .filter((m) => m.key === binding.key || !taken.has(m.key))
                  .map((m) => ({ value: m.key, label: m.name }))}
                searchable
                value={binding.key || null}
                onChange={(value) => patch(index, { key: value ?? '' })}
              />
              <Switch
                label={t('config.knowledgeBindingEnabled')}
                checked={binding.enabled !== false}
                onChange={(e) => patch(index, { enabled: e.currentTarget.checked })}
              />
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={t('config.knowledgeBindingRemove')}
                onClick={() => onBindingsChange(bindings.filter((_, i) => i !== index))}
              >
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
            <TextInput
              size="xs"
              placeholder={t('config.knowledgeBindingDescriptionPlaceholder')}
              value={binding.description ?? ''}
              onChange={(e) => patch(index, { description: e.currentTarget.value || undefined })}
            />
            <Group gap="xs">
              <NumberInput
                size="xs"
                w={110}
                min={1}
                max={50}
                allowDecimal={false}
                placeholder="topK"
                value={binding.topK ?? ''}
                onChange={(v) => patch(index, { topK: typeof v === 'number' ? v : undefined })}
              />
              <NumberInput
                size="xs"
                w={110}
                min={0}
                max={1}
                step={0.05}
                decimalScale={2}
                placeholder="minScore"
                value={binding.minScore ?? ''}
                onChange={(v) => patch(index, { minScore: typeof v === 'number' ? v : undefined })}
              />
            </Group>
          </Stack>
        </Paper>
      ))}
      <Group justify="space-between">
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={modules.every((m) => taken.has(m.key))}
          onClick={() => onBindingsChange([...bindings, { key: '' }])}
        >
          {t('config.knowledgeBindingAdd')}
        </Button>
        {bindings.length > 1 && (
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={(v) => onModeChange(v as 'combined' | 'separate')}
            data={[
              { value: 'combined', label: t('config.knowledgeModeCombined') },
              { value: 'separate', label: t('config.knowledgeModeSeparate') },
            ]}
          />
        )}
      </Group>
    </Stack>
  );
}
