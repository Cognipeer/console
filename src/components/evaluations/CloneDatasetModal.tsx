'use client';

/**
 * CloneDatasetModal — copy a filtered slice of a dataset into a new one.
 *
 * This is the step that turns labeling into leverage. A labeling run tags a
 * captured corpus by segment; a reviewer corrects the labels that matter.
 * Cloning the reviewed slice produces a GOLDEN SET: a small, trustworthy
 * dataset a suite can be run against on every change, without re-running the
 * labeler or curating items by hand.
 *
 * A copy, not a view. A golden set has to be stable — if it tracked the source
 * dataset, tomorrow's traffic capture would silently change what "the
 * regression suite" means and two runs a week apart would not be comparable.
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, Checkbox, NumberInput, Select, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCopy, IconInfoCircle } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { EvalLabelSummaryView } from './types';

export type CloneLabelSource = 'any' | 'human' | 'ai';

export interface CloneDatasetPayload {
  name: string;
  description?: string;
  tags?: string[];
  filter: {
    label?: { key: string; value?: string };
    labelSource?: 'human' | 'ai';
    requireExpected?: boolean;
    limit?: number;
  };
}

export interface CloneDatasetResult {
  dataset: { id: string; name: string };
  copied: number;
}

interface CloneDatasetModalProps {
  opened: boolean;
  datasetName: string;
  itemCount: number;
  /** Label distribution of the source, used to offer real segment choices. */
  labelSummary: EvalLabelSummaryView | null;
  onClose: () => void;
  onClone: (payload: CloneDatasetPayload) => Promise<CloneDatasetResult | null>;
}

const SOURCE_OPTIONS: Array<{ value: CloneLabelSource; label: string }> = [
  { value: 'human', label: 'Reviewed by a human' },
  { value: 'ai', label: 'AI-labeled only' },
  { value: 'any', label: 'Any item' },
];

const ANY_VALUE = '__any__';

export default function CloneDatasetModal({
  opened,
  datasetName,
  itemCount,
  labelSummary,
  onClose,
  onClone,
}: CloneDatasetModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [labelSource, setLabelSource] = useState<CloneLabelSource>('human');
  const [labelKey, setLabelKey] = useState<string | null>(null);
  const [labelValue, setLabelValue] = useState<string | null>(null);
  const [requireExpected, setRequireExpected] = useState(true);
  const [limit, setLimit] = useState<number | ''>('');
  const [tagGolden, setTagGolden] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setName(`${datasetName} · golden set`);
    setDescription('');
    setLabelSource('human');
    setLabelKey(null);
    setLabelValue(null);
    setRequireExpected(true);
    setLimit('');
    setTagGolden(true);
    setLoading(false);
  }, [opened, datasetName]);

  const labelKeys = useMemo(
    () => (labelSummary?.keys ?? []).map((entry) => ({ value: entry.key, label: entry.key })),
    [labelSummary],
  );
  const labelValues = useMemo(() => {
    const entry = labelSummary?.keys?.find((k) => k.key === labelKey);
    return [
      { value: ANY_VALUE, label: 'Any value' },
      ...(entry?.values ?? []).map((v) => ({ value: String(v.value), label: `${v.value} (${v.count})` })),
    ];
  }, [labelSummary, labelKey]);

  // Deliberately NOT an estimate: the label distribution says nothing about
  // which items carry a reference, and a confident wrong number is worse than
  // none. The result reports what was actually copied.
  const reviewedCount = labelSummary?.humanLabeled;

  const valid = name.trim().length > 0;

  const handleClone = async () => {
    if (!valid) return;
    setLoading(true);
    try {
      const result = await onClone({
        name: name.trim(),
        description: description.trim() || undefined,
        tags: tagGolden ? ['golden'] : undefined,
        filter: {
          ...(labelKey
            ? {
                label: {
                  key: labelKey,
                  ...(labelValue && labelValue !== ANY_VALUE ? { value: labelValue } : {}),
                },
              }
            : {}),
          ...(labelSource !== 'any' ? { labelSource } : {}),
          ...(requireExpected ? { requireExpected: true } : {}),
          ...(typeof limit === 'number' && limit > 0 ? { limit } : {}),
        },
      });
      if (result) onClose();
    } catch (err) {
      notifications.show({
        title: 'Clone failed',
        message: err instanceof Error ? err.message : 'Could not clone the dataset',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const summary = (
    <SummaryGroup title="New dataset">
      <SummaryKV label="Name" value={name || '—'} />
      <SummaryKV label="From" value={`${datasetName} (${itemCount} items)`} />
      <SummaryKV label="Items" value={SOURCE_OPTIONS.find((o) => o.value === labelSource)?.label ?? '—'} />
      <SummaryKV label="Segment" value={labelKey ? `${labelKey}${labelValue && labelValue !== ANY_VALUE ? ` = ${labelValue}` : ''}` : 'all segments'} />
      <SummaryKV label="Gradeable only" value={requireExpected ? 'yes' : 'no'} />
      <Checklist
        items={[
          { id: 'name', label: 'Name provided', done: valid },
          {
            id: 'reviewed',
            label: labelSource === 'human'
              ? `${reviewedCount ?? 0} reviewed item(s) in the source`
              : 'Filtering on any label source',
            done: labelSource !== 'human' || (reviewedCount ?? 0) > 0,
          },
        ]}
      />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconCopy size={16} />}
      title={`Clone · ${datasetName}`}
      subtitle="Copy a filtered slice into a new dataset — the way a labeled corpus becomes a golden set."
      summary={summary}
      footerStatus={valid ? 'Ready to clone' : 'Name the new dataset to continue'}
      primaryAction={{
        label: 'Create dataset',
        icon: <IconCopy size={13} />,
        loading,
        disabled: !valid,
        onClick: () => void handleClone(),
      }}
    >
      <FormSection number={1} title="New dataset" done={valid}>
        <FormField label="Name" required>
          <TextInput value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </FormField>
        <FormField label="Description" optional>
          <TextInput
            placeholder="What is this slice for?"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
        </FormField>
        <Checkbox
          label="Tag every copied item “golden”"
          checked={tagGolden}
          onChange={(e) => setTagGolden(e.currentTarget.checked)}
        />
      </FormSection>

      <FormSection number={2} title="Which items?" done>
        <FormField
          label="Label source"
          hint="An AI labeling run is a hypothesis; a reviewer's correction is ground truth. A golden set that mixes the two is not golden."
        >
          <ChipPicker<CloneLabelSource>
            value={labelSource}
            onChange={(v) => setLabelSource(v as CloneLabelSource)}
            options={SOURCE_OPTIONS}
          />
        </FormField>

        {labelKeys.length > 0 ? (
          <Stack gap="xs">
            <FormField label="Segment" optional hint="Narrow to one label — e.g. only the refund-intent conversations.">
              <Select
                placeholder="All segments"
                data={labelKeys}
                value={labelKey}
                onChange={(value) => { setLabelKey(value); setLabelValue(null); }}
                clearable
                searchable
              />
            </FormField>
            {labelKey ? (
              <FormField label="Value" optional>
                <Select
                  placeholder="Any value"
                  data={labelValues}
                  value={labelValue}
                  onChange={setLabelValue}
                  searchable
                />
              </FormField>
            ) : null}
          </Stack>
        ) : (
          <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
            This dataset has no labels yet. Run <strong>Label with AI</strong> first to be able to slice it by segment —
            you can still clone by label source and expectations.
          </Alert>
        )}

        <Checkbox
          label="Only items with an expected answer"
          description="An item with nothing to compare against scores 0 for every reference-based scorer, silently dragging the suite's pass rate down."
          checked={requireExpected}
          onChange={(e) => setRequireExpected(e.currentTarget.checked)}
        />

        <FormField label="Maximum items" optional hint="Leave empty to copy everything that matches.">
          <NumberInput
            min={1}
            value={limit}
            onChange={(value) => setLimit(typeof value === 'number' ? value : '')}
            placeholder="No limit"
          />
        </FormField>

        <Text size="xs" c="dimmed">
          The copy is independent: later changes to “{datasetName}” do not reach it, so runs stay comparable over time.
          Item ids are preserved, and the filter is recorded on the new dataset.
        </Text>
      </FormSection>
    </FormShell>
  );
}
