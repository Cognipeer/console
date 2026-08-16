'use client';

/**
 * LabelItemModal — review and correct ONE item's labels.
 *
 * This is the human half of the labeling loop: the AI proposes, a reviewer
 * confirms or fixes. Saving marks the labels human-owned, which means later AI
 * runs leave them alone and (with accuracy mode on) score themselves against
 * them. Fields come from the analysis definition when one is known, so a
 * reviewer picks from the same enum the labeler had; free-form rows are there
 * for items labeled by a definition that has since changed.
 */

import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Alert, Group, Select, Stack, Text, TextInput } from '@mantine/core';
import { IconInfoCircle, IconPlus, IconTags, IconTrash } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { AnalysisDefinitionView } from '@/components/analysis/types';
import type { EvalDatasetItemView } from './types';

interface LabelRow {
  key: string;
  value: string;
}

interface LabelItemModalProps {
  opened: boolean;
  item: EvalDatasetItemView | null;
  /** Definition that labeled this item, when it is still available. */
  definition: AnalysisDefinitionView | null;
  saving?: boolean;
  onClose: () => void;
  onSave: (labels: Record<string, string>) => void;
}

function toRows(item: EvalDatasetItemView | null, definition: AnalysisDefinitionView | null): LabelRow[] {
  const labels = item?.labels ?? {};
  const rows: LabelRow[] = [];
  // Definition order first so the form reads the same way every time.
  for (const field of definition?.fieldSet ?? []) {
    rows.push({ key: field.key, value: labels[field.key] == null ? '' : String(labels[field.key]) });
  }
  for (const [key, value] of Object.entries(labels)) {
    if (rows.some((r) => r.key === key)) continue;
    rows.push({ key, value: value == null ? '' : String(value) });
  }
  return rows.length > 0 ? rows : [{ key: '', value: '' }];
}

export default function LabelItemModal({
  opened,
  item,
  definition,
  saving,
  onClose,
  onSave,
}: LabelItemModalProps) {
  const [rows, setRows] = useState<LabelRow[]>([]);

  useEffect(() => {
    if (opened) setRows(toRows(item, definition));
  }, [opened, item, definition]);

  const fieldByKey = useMemo(
    () => new Map((definition?.fieldSet ?? []).map((f) => [f.key, f])),
    [definition],
  );

  const patchRow = (index: number, patch: Partial<LabelRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const filled = rows.filter((row) => row.key.trim() !== '' && row.value.trim() !== '');
  const duplicateKey = filled.some(
    (row, i) => filled.findIndex((other) => other.key.trim() === row.key.trim()) !== i,
  );
  const valid = !duplicateKey;

  const handleSave = () => {
    if (!valid) return;
    const labels: Record<string, string> = {};
    for (const row of filled) labels[row.key.trim()] = row.value.trim();
    onSave(labels);
  };

  const meta = item?.labelMeta;
  const summary = (
    <SummaryGroup title="Labels">
      <SummaryKV label="Item" value={item?.id ?? '—'} />
      <SummaryKV label="Current source" value={meta?.source === 'human' ? 'human' : meta ? 'AI' : 'unlabeled'} />
      {meta?.definitionKey ? <SummaryKV label="Definition" value={meta.definitionKey} /> : null}
      {meta?.modelKey ? <SummaryKV label="Model" value={meta.modelKey} /> : null}
      {meta?.judge ? <SummaryKV label="Judge score" value={meta.judge.score.toFixed(2)} /> : null}
      <SummaryKV label="After saving" value="human" />
      <Checklist
        items={[
          { id: 'rows', label: `${filled.length} label(s) set`, done: filled.length > 0 },
          { id: 'dup', label: duplicateKey ? 'Duplicate label key' : 'Keys are unique', done: !duplicateKey },
        ]}
      />
    </SummaryGroup>
  );

  const firstUserTurn = item?.input.find((m) => m.role === 'user')?.content ?? item?.input[0]?.content ?? '';

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconTags size={16} />}
      title={`Labels · ${item?.id ?? 'item'}`}
      subtitle="Your corrections outrank the model: saved labels are marked human-owned, so later AI runs keep them and measure themselves against them."
      summary={summary}
      footerStatus={duplicateKey ? 'Label keys must be unique' : `${filled.length} label(s)`}
      primaryAction={{
        label: 'Save labels',
        icon: <IconTags size={13} />,
        loading: saving,
        disabled: !valid,
        onClick: handleSave,
      }}
    >
      <FormSection number={1} title="Item" collapsible defaultOpen={false}>
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {firstUserTurn || 'This item has no user turn.'}
        </Text>
      </FormSection>

      <FormSection number={2} title="Labels" done={filled.length > 0}>
        {meta?.source === 'ai' && meta.judge?.reasoning ? (
          <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
            Judge note: {meta.judge.reasoning}
          </Alert>
        ) : null}

        <Stack gap="xs">
          {rows.map((row, index) => {
            const field = fieldByKey.get(row.key.trim());
            return (
              <FormRow key={`${row.key}-${index}`} cols={2}>
                <FormField label={index === 0 ? 'Key' : ''}>
                  <TextInput
                    value={row.key}
                    placeholder="intent"
                    onChange={(e) => patchRow(index, { key: e.currentTarget.value })}
                    readOnly={!!field}
                  />
                </FormField>
                <FormField
                  label={index === 0 ? 'Value' : ''}
                  action={
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="sm"
                      aria-label="Remove label"
                      onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  }
                >
                  {field?.type === 'enum' && field.enumValues?.length ? (
                    <Select
                      data={field.enumValues}
                      value={row.value || null}
                      placeholder="Not set"
                      clearable
                      onChange={(v) => patchRow(index, { value: v ?? '' })}
                    />
                  ) : field?.type === 'boolean' ? (
                    <Select
                      data={['true', 'false']}
                      value={row.value || null}
                      placeholder="Not set"
                      clearable
                      onChange={(v) => patchRow(index, { value: v ?? '' })}
                    />
                  ) : (
                    <TextInput
                      value={row.value}
                      placeholder="Not set"
                      onChange={(e) => patchRow(index, { value: e.currentTarget.value })}
                    />
                  )}
                </FormField>
              </FormRow>
            );
          })}
        </Stack>

        <Group>
          <ActionIcon
            variant="light"
            aria-label="Add label"
            onClick={() => setRows((prev) => [...prev, { key: '', value: '' }])}
          >
            <IconPlus size={14} />
          </ActionIcon>
          <Text size="xs" c="dimmed">Add a label not covered by the definition</Text>
        </Group>

        <Text size="xs" c="dimmed">Rows left empty are dropped when you save.</Text>
      </FormSection>
    </FormShell>
  );
}
