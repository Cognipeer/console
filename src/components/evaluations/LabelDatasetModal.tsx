'use client';

/**
 * LabelDatasetModal — start an AI labeling pass over a dataset.
 *
 * Labeling reuses the Analysis module: an analysis definition's field set IS
 * the label taxonomy, and its extract mode already assigns those fields to a
 * transcript. So this modal picks a definition, picks which items to cover, and
 * enqueues an analysis run targeting the dataset. Results land on each item as
 * `labels`.
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, Anchor, Group, NumberInput, Select, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle, IconTags } from '@tabler/icons-react';
import FormShell, {
  ChipPicker,
  Checklist,
  FormField,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { AnalysisDefinitionView } from '@/components/analysis/types';

export type LabelStrategy = 'unanalyzed' | 'all' | 'random';

export interface LabelSelectionPayload {
  strategy: LabelStrategy;
  sampleSize?: number;
}

interface LabelDatasetModalProps {
  opened: boolean;
  datasetName: string;
  itemCount: number;
  /** Items that already carry labels — drives the "left to label" count. */
  labeledCount: number;
  definitions: AnalysisDefinitionView[];
  definitionsLoading?: boolean;
  onClose: () => void;
  /** Resolves to the started run id, or null when the request failed. */
  onRun: (definitionKey: string, selection: LabelSelectionPayload) => Promise<string | null>;
}

const STRATEGY_OPTIONS: Array<{ value: LabelStrategy; label: string }> = [
  { value: 'unanalyzed', label: 'Only unlabeled' },
  { value: 'all', label: 'All items' },
  { value: 'random', label: 'Random sample' },
];

export default function LabelDatasetModal({
  opened,
  datasetName,
  itemCount,
  labeledCount,
  definitions,
  definitionsLoading,
  onClose,
  onRun,
}: LabelDatasetModalProps) {
  const [definitionKey, setDefinitionKey] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<LabelStrategy>('unanalyzed');
  const [sampleSize, setSampleSize] = useState(50);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!opened) {
      setDefinitionKey(null);
      setStrategy('unanalyzed');
      setSampleSize(50);
      setLoading(false);
    }
  }, [opened]);

  const definition = useMemo(
    () => definitions.find((d) => d.key === definitionKey) ?? null,
    [definitions, definitionKey],
  );

  const unlabeled = Math.max(0, itemCount - labeledCount);
  const matchCount = strategy === 'unanalyzed'
    ? unlabeled
    : strategy === 'random'
      ? Math.min(sampleSize, itemCount)
      : itemCount;

  const valid = !!definitionKey && matchCount > 0;

  const handleRun = async () => {
    if (!definitionKey || !valid) return;
    setLoading(true);
    try {
      const runId = await onRun(definitionKey, {
        strategy,
        ...(strategy === 'random' ? { sampleSize } : {}),
      });
      if (runId) onClose();
    } catch (err) {
      notifications.show({
        title: 'Labeling failed',
        message: err instanceof Error ? err.message : 'Could not start labeling',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const fieldSummary = definition
    ? definition.fieldSet.map((f) => f.key).join(', ')
    : '—';

  const summary = (
    <SummaryGroup title="Labeling run">
      <SummaryKV label="Dataset" value={datasetName} />
      <SummaryKV label="Definition" value={definition?.name ?? '—'} />
      <SummaryKV label="Labels" value={fieldSummary} />
      <SummaryKV label="Model" value={definition?.extractionModelKey ?? 'definition default'} />
      <SummaryKV label="Will label" value={`${matchCount} item(s)`} />
      <Checklist
        items={[
          { id: 'def', label: definition ? `Using "${definition.name}"` : 'Pick a label definition', done: !!definition },
          { id: 'sel', label: matchCount > 0 ? `${matchCount} item(s) selected` : 'Nothing matches this selection', done: matchCount > 0 },
        ]}
      />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconTags size={16} />}
      title={`Label with AI · ${datasetName}`}
      subtitle="An analysis definition's fields become each item's labels. The run happens in the background; labels appear on the items as it progresses."
      summary={summary}
      footerStatus={valid ? `${matchCount} item(s) will be labeled` : 'Pick a definition to continue'}
      primaryAction={{
        label: 'Start labeling',
        icon: <IconTags size={13} />,
        loading,
        disabled: !valid,
        onClick: () => void handleRun(),
      }}
    >
      <FormSection number={1} title="Label definition" done={!!definition}>
        <FormField
          label="Analysis definition"
          hint="Its field set is the label taxonomy — e.g. an enum field 'intent' becomes the intent label."
        >
          <Select
            placeholder={definitionsLoading ? 'Loading definitions…' : 'Select a definition'}
            data={definitions.map((d) => ({ value: d.key, label: d.name }))}
            value={definitionKey}
            onChange={setDefinitionKey}
            searchable
            disabled={definitionsLoading || definitions.length === 0}
            nothingFoundMessage="No definitions"
          />
        </FormField>

        {!definitionsLoading && definitions.length === 0 ? (
          <Alert color="orange" variant="light" icon={<IconInfoCircle size={16} />}>
            No analysis definitions yet. Create one under{' '}
            <Anchor href="/dashboard/analysis" size="sm">Analysis</Anchor> — its fields become the labels applied here.
          </Alert>
        ) : null}

        {definition ? (
          <Group gap={6} wrap="wrap">
            {definition.fieldSet.map((field) => (
              <span key={field.key} className="ds-badge" title={field.description}>
                {field.key}
                <span className="ds-faint"> · {field.type}</span>
              </span>
            ))}
          </Group>
        ) : null}

        {definition?.modes.judge ? (
          <Text size="xs" c="dimmed">
            This definition also runs an LLM judge; each item&apos;s verdict is stored alongside its labels.
          </Text>
        ) : null}
      </FormSection>

      <FormSection number={2} title="Which items?" done={matchCount > 0}>
        <FormField label="Selection">
          <ChipPicker<LabelStrategy>
            value={strategy}
            onChange={(v) => setStrategy(v as LabelStrategy)}
            options={STRATEGY_OPTIONS}
          />
        </FormField>

        {strategy === 'random' ? (
          <FormField label="Sample size" hint="Good for trying a definition out before labeling everything.">
            <NumberInput min={1} max={Math.max(1, itemCount)} value={sampleSize} onChange={(v) => setSampleSize(Number(v) || 1)} />
          </FormField>
        ) : null}

        <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
          {strategy === 'unanalyzed'
            ? `${unlabeled} of ${itemCount} item(s) have no labels yet.`
            : `This run covers ${matchCount} of ${itemCount} item(s).`}{' '}
          Items you corrected by hand are never overwritten — with accuracy mode on they are used to score the labeler instead.
        </Alert>
      </FormSection>
    </FormShell>
  );
}
