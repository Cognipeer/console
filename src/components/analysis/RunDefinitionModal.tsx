'use client';

/**
 * Run modal — lets the user choose *which* conversations a definition runs over
 * before kicking off an (async) run, instead of blindly analyzing the whole
 * corpus. Strategies: all / by tag / random sample / only-not-yet-analyzed /
 * pick specific. A live count shows exactly how many conversations will run.
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, MultiSelect, NumberInput, Select } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle, IconPlayerPlay } from '@tabler/icons-react';
import FormShell, {
  ChipPicker,
  Checklist,
  FormField,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { AnalysisConversationView, AnalysisDefinitionView } from './types';

export type RunStrategy = 'all' | 'tag' | 'random' | 'unanalyzed' | 'keys';

export interface RunSelectionPayload {
  strategy: RunStrategy;
  tag?: string;
  sampleSize?: number;
  conversationKeys?: string[];
}

interface RunDefinitionModalProps {
  opened: boolean;
  definition: AnalysisDefinitionView | null;
  conversations: AnalysisConversationView[];
  onClose: () => void;
  /** Returns the created run id on success, or null on failure. */
  onRun: (definitionKey: string, selection: RunSelectionPayload) => Promise<string | null>;
}

const STRATEGY_OPTIONS: Array<{ value: RunStrategy; label: string }> = [
  { value: 'all', label: 'All conversations' },
  { value: 'tag', label: 'By tag' },
  { value: 'random', label: 'Random sample' },
  { value: 'unanalyzed', label: 'Not yet analyzed' },
  { value: 'keys', label: 'Pick specific' },
];

export default function RunDefinitionModal({ opened, definition, conversations, onClose, onRun }: RunDefinitionModalProps) {
  const [strategy, setStrategy] = useState<RunStrategy>('all');
  const [tag, setTag] = useState<string | null>(null);
  const [sampleSize, setSampleSize] = useState<number>(50);
  const [pickedKeys, setPickedKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!opened) {
      setStrategy('all'); setTag(null); setSampleSize(50); setPickedKeys([]); setLoading(false);
    }
  }, [opened]);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    conversations.forEach((c) => (c.tags ?? []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [conversations]);

  const keyOptions = useMemo(
    () => conversations.map((c) => ({ value: c.key, label: `${c.name || c.key} (${c.transcript.length} turns)` })),
    [conversations],
  );

  // How many conversations the current selection would cover.
  const matchCount = useMemo(() => {
    const byTag = tag ? conversations.filter((c) => (c.tags ?? []).includes(tag)) : conversations;
    switch (strategy) {
      case 'all': return conversations.length;
      case 'tag': return tag ? byTag.length : 0;
      case 'random': return Math.min(sampleSize, byTag.length);
      case 'unanalyzed': return byTag.filter((c) => !c.lastAnalyzedAt).length;
      case 'keys': return pickedKeys.length;
      default: return 0;
    }
  }, [strategy, tag, sampleSize, pickedKeys, conversations]);

  const valid = matchCount > 0 && (strategy !== 'tag' || !!tag) && (strategy !== 'keys' || pickedKeys.length > 0);

  const buildSelection = (): RunSelectionPayload => {
    switch (strategy) {
      case 'tag': return { strategy: 'tag', tag: tag ?? undefined };
      case 'random': return { strategy: 'random', sampleSize, tag: tag ?? undefined };
      case 'unanalyzed': return { strategy: 'unanalyzed', tag: tag ?? undefined };
      case 'keys': return { strategy: 'keys', conversationKeys: pickedKeys };
      default: return { strategy: 'all' };
    }
  };

  const handleRun = async () => {
    if (!definition || !valid) return;
    setLoading(true);
    try {
      const runId = await onRun(definition.key, buildSelection());
      if (runId) onClose();
    } catch (err) {
      notifications.show({ title: 'Run failed', message: err instanceof Error ? err.message : 'Run failed', color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const strategyLabel = STRATEGY_OPTIONS.find((s) => s.value === strategy)?.label ?? '';

  const summary = (
    <SummaryGroup title="Run">
      <SummaryKV label="Definition" value={definition?.name ?? '—'} />
      <SummaryKV label="Selection" value={strategyLabel} />
      {tag ? <SummaryKV label="Tag" value={tag} /> : null}
      <SummaryKV label="Will analyze" value={`${matchCount} conversation(s)`} />
      <Checklist items={[{ id: 'sel', label: valid ? `${matchCount} conversation(s) selected` : 'Pick conversations to run', done: valid }]} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconPlayerPlay size={16} />}
      title={`Run · ${definition?.name ?? 'definition'}`}
      subtitle="Choose which conversations to analyze, then start the run. It executes in the background — you'll jump to the live run view."
      summary={summary}
      footerStatus={valid ? `${matchCount} will be analyzed` : 'Select conversations to continue'}
      primaryAction={{
        label: 'Start run',
        icon: <IconPlayerPlay size={13} />,
        loading,
        disabled: !valid,
        onClick: () => void handleRun(),
      }}
    >
      <FormSection number={1} title="Which conversations?" done={valid}>
        <FormField label="Selection strategy">
          <ChipPicker<RunStrategy>
            value={strategy}
            onChange={(v) => setStrategy(v as RunStrategy)}
            options={STRATEGY_OPTIONS}
          />
        </FormField>

        {(strategy === 'tag' || strategy === 'random' || strategy === 'unanalyzed') && (
          <FormField
            label={strategy === 'tag' ? 'Tag' : 'Tag filter (optional)'}
            hint={availableTags.length === 0 ? 'No tags yet — add tags when ingesting conversations.' : undefined}
          >
            <Select
              placeholder={strategy === 'tag' ? 'Select a tag' : 'All tags'}
              data={availableTags}
              value={tag}
              onChange={setTag}
              clearable={strategy !== 'tag'}
              searchable
              nothingFoundMessage="No tags"
              disabled={availableTags.length === 0}
            />
          </FormField>
        )}

        {strategy === 'random' && (
          <FormField label="Sample size" hint="A random subset of the matching conversations.">
            <NumberInput min={1} max={Math.max(1, conversations.length)} value={sampleSize} onChange={(v) => setSampleSize(Number(v) || 1)} />
          </FormField>
        )}

        {strategy === 'keys' && (
          <FormField label="Conversations">
            <MultiSelect
              placeholder="Search and pick conversations"
              data={keyOptions}
              value={pickedKeys}
              onChange={setPickedKeys}
              searchable
              clearable
              hidePickedOptions
              maxDropdownHeight={260}
            />
          </FormField>
        )}

        <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
          This run will analyze <strong>{matchCount}</strong> conversation(s).
          {strategy === 'unanalyzed' ? ' Only conversations that have never been analyzed are included.' : ''}
        </Alert>
      </FormSection>
    </FormShell>
  );
}
