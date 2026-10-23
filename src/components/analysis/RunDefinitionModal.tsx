'use client';

/**
 * Run modal — lets the user choose *which* conversations a definition runs over
 * before kicking off an (async) run, instead of blindly analyzing the whole
 * source. Imported corpus: all / by tag / random sample / only-not-yet-analyzed /
 * pick specific. Agent sessions: new or changed / not analyzed yet / random
 * sample / everything in the window. An estimate box shows how many
 * conversations will run and what that roughly costs.
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, MultiSelect, NumberInput, Select, Text } from '@mantine/core';
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
import type { AnalysisConversationView, AnalysisDefinitionView, RunEstimateView } from './types';

export type RunStrategy = 'all' | 'tag' | 'random' | 'unanalyzed' | 'keys' | 'changed';

export interface RunSelectionPayload {
  strategy: RunStrategy;
  tag?: string;
  sampleSize?: number;
  conversationKeys?: string[];
}

export type RunTargetPayload = { kind: 'conversations' } | { kind: 'agent_sessions'; days?: number };

/** Body of POST /analysis/definitions/:key/run and /estimate. */
export interface RunPayload {
  selection: RunSelectionPayload;
  target: RunTargetPayload;
}

interface RunDefinitionModalProps {
  opened: boolean;
  definition: AnalysisDefinitionView | null;
  conversations: AnalysisConversationView[];
  onClose: () => void;
  /** Returns the created run id on success, or null on failure. */
  onRun: (definitionKey: string, payload: RunPayload) => Promise<string | null>;
}

const CORPUS_STRATEGIES: Array<{ value: RunStrategy; label: string }> = [
  { value: 'all', label: 'All conversations' },
  { value: 'tag', label: 'By tag' },
  { value: 'random', label: 'Random sample' },
  { value: 'unanalyzed', label: 'Not yet analyzed' },
  { value: 'keys', label: 'Pick specific' },
];

const SESSION_STRATEGIES: Array<{ value: RunStrategy; label: string }> = [
  { value: 'changed', label: 'New or changed' },
  { value: 'unanalyzed', label: 'Not analyzed yet' },
  { value: 'random', label: 'Random sample' },
  { value: 'all', label: 'Everything in the window' },
];

const ESTIMATE_DEBOUNCE_MS = 400;

function money(value: number | null, currency: string): string | null {
  if (value === null) return null;
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return value > 0 && value < 0.01 ? `<${symbol}0.01` : `${symbol}${value.toFixed(2)}`;
}

export default function RunDefinitionModal({ opened, definition, conversations, onClose, onRun }: RunDefinitionModalProps) {
  const sessionSource = definition?.source?.kind === 'agent_sessions' ? definition.source : null;
  const isSessions = sessionSource !== null;
  const strategyOptions = isSessions ? SESSION_STRATEGIES : CORPUS_STRATEGIES;

  const [strategy, setStrategy] = useState<RunStrategy>('all');
  const [tag, setTag] = useState<string | null>(null);
  const [sampleSize, setSampleSize] = useState<number>(50);
  const [pickedKeys, setPickedKeys] = useState<string[]>([]);
  const [lookBackDays, setLookBackDays] = useState<number>(7);
  const [loading, setLoading] = useState(false);
  const [estimate, setEstimate] = useState<RunEstimateView | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);

  // Start from the definition's source each time the modal opens.
  useEffect(() => {
    if (!opened) {
      setStrategy('all'); setTag(null); setSampleSize(50); setPickedKeys([]); setLoading(false);
      setEstimate(null); setEstimateError(null); setEstimating(false);
      return;
    }
    setStrategy(isSessions ? 'changed' : 'all');
    setLookBackDays(sessionSource?.days ?? 7);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, definition?.key]);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    conversations.forEach((c) => (c.tags ?? []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [conversations]);

  const keyOptions = useMemo(
    () => conversations.map((c) => ({ value: c.key, label: `${c.name || c.key} (${c.transcript.length} turns)` })),
    [conversations],
  );

  // How many imported conversations the current selection would cover.
  const corpusMatchCount = useMemo(() => {
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

  const selection = useMemo((): RunSelectionPayload => {
    switch (strategy) {
      case 'tag': return { strategy: 'tag', tag: tag ?? undefined };
      case 'random': return { strategy: 'random', sampleSize, tag: isSessions ? undefined : tag ?? undefined };
      case 'unanalyzed': return { strategy: 'unanalyzed', tag: isSessions ? undefined : tag ?? undefined };
      case 'keys': return { strategy: 'keys', conversationKeys: pickedKeys };
      case 'changed': return { strategy: 'changed' };
      default: return { strategy: 'all' };
    }
  }, [strategy, tag, sampleSize, pickedKeys, isSessions]);

  const target = useMemo(
    (): RunTargetPayload => (isSessions ? { kind: 'agent_sessions', days: lookBackDays } : { kind: 'conversations' }),
    [isSessions, lookBackDays],
  );

  // Selections that cannot run (no tag chosen, nothing picked) are not worth an estimate call.
  const selectionComplete = (strategy !== 'tag' || !!tag) && (strategy !== 'keys' || pickedKeys.length > 0);
  const payloadKey = JSON.stringify({ selection, target });

  // Debounced estimate of what this run would do and cost.
  useEffect(() => {
    if (!opened || !definition || !selectionComplete) {
      setEstimate(null); setEstimateError(null); setEstimating(false);
      return;
    }
    let cancelled = false;
    setEstimating(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/analysis/definitions/${encodeURIComponent(definition.key)}/estimate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payloadKey,
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setEstimate(null);
          setEstimateError(data.error || 'Could not estimate this run');
        } else {
          setEstimate(data.estimate ?? null);
          setEstimateError(null);
        }
      } catch {
        if (!cancelled) {
          setEstimate(null);
          setEstimateError('Could not estimate this run');
        }
      } finally {
        if (!cancelled) setEstimating(false);
      }
    }, ESTIMATE_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, definition?.key, selectionComplete, payloadKey]);

  const emptySelection = estimate?.conversations === 0 || (estimateError !== null && /no conversations/i.test(estimateError));
  const matchCount = isSessions ? estimate?.conversations ?? null : corpusMatchCount;
  const valid = selectionComplete && (isSessions ? !estimating && !emptySelection : corpusMatchCount > 0);

  const handleRun = async () => {
    if (!definition || !valid) return;
    setLoading(true);
    try {
      const runId = await onRun(definition.key, { selection, target });
      if (runId) onClose();
    } catch (err) {
      notifications.show({ title: 'Run failed', message: err instanceof Error ? err.message : 'Run failed', color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const strategyLabel = strategyOptions.find((s) => s.value === strategy)?.label ?? '';
  const targetLine = sessionSource
    ? `Agent sessions · ${sessionSource.agentKeys.length} agent${sessionSource.agentKeys.length === 1 ? '' : 's'} · last ${lookBackDays} day${lookBackDays === 1 ? '' : 's'}`
    : 'Imported conversations';
  const countLabel = matchCount === null ? '…' : `${matchCount} conversation(s)`;

  const summary = (
    <SummaryGroup title="Run">
      <SummaryKV label="Definition" value={definition?.name ?? '—'} />
      <SummaryKV label="Source" value={targetLine} />
      <SummaryKV label="Selection" value={strategyLabel} />
      {tag && !isSessions ? <SummaryKV label="Tag" value={tag} /> : null}
      <SummaryKV label="Will analyze" value={countLabel} />
      <Checklist items={[{ id: 'sel', label: valid ? `${countLabel} selected` : 'Pick conversations to run', done: valid }]} />
    </SummaryGroup>
  );

  const costTotal = estimate ? money(estimate.cost.total, estimate.cost.currency) : null;
  const breakdown = estimate
    ? ([
        ['decision', estimate.cost.decision],
        ['extraction', estimate.cost.extraction],
        ['judge', estimate.cost.judge],
      ] as const)
        .map(([label, value]) => {
          const text = money(value, estimate.cost.currency);
          return text ? `${label} ${text}` : null;
        })
        .filter(Boolean)
        .join(' · ')
    : '';

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
        <Text size="sm" c="dimmed">{targetLine}</Text>

        <FormField label="Selection strategy">
          <ChipPicker<RunStrategy>
            value={strategy}
            onChange={(v) => setStrategy(v as RunStrategy)}
            options={strategyOptions}
          />
        </FormField>

        {isSessions && (
          <FormField label="Look back" hint="Sessions last updated within this many days (and idle long enough) are considered.">
            <NumberInput min={1} max={365} allowDecimal={false} value={lookBackDays} onChange={(v) => setLookBackDays(Number(v) || 1)} suffix=" days" />
          </FormField>
        )}

        {!isSessions && (strategy === 'tag' || strategy === 'random' || strategy === 'unanalyzed') && (
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
            <NumberInput min={1} max={isSessions ? 5000 : Math.max(1, conversations.length)} allowDecimal={false} value={sampleSize} onChange={(v) => setSampleSize(Number(v) || 1)} />
          </FormField>
        )}

        {!isSessions && strategy === 'keys' && (
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
          {estimating && !estimate ? (
            'Estimating…'
          ) : estimate ? (
            <>
              ≈ <strong>{estimate.conversations.toLocaleString()}</strong> conversations · ≈ {estimate.inputTokens.toLocaleString()} input tokens ·{' '}
              {costTotal ? <>≈ <strong>{costTotal}</strong></> : 'cost unknown'}
              {breakdown ? <Text size="xs" c="dimmed" mt={4}>{breakdown}</Text> : null}
              {strategy === 'unanalyzed' && !isSessions ? <Text size="xs" c="dimmed" mt={4}>Only conversations that have never been analyzed are included.</Text> : null}
            </>
          ) : estimateError ? (
            estimateError
          ) : isSessions ? (
            'Pick a selection to see an estimate.'
          ) : (
            <>This run will analyze <strong>{corpusMatchCount}</strong> conversation(s).</>
          )}
        </Alert>
      </FormSection>
    </FormShell>
  );
}
