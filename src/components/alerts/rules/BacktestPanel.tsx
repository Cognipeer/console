'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Text } from '@mantine/core';
import { IconHistory } from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import { formatDurationBetween } from '../alertCatalog';
import type { BacktestResultDto } from '../alertTypes';
import { isAbortError, readApiError } from '../apiError';
import { pluralKey } from '../plural';
import { translateServerNotes } from '../incidentUi';
import { backtestMedianDurationMs, topBacktestEntities } from './ruleListUi';

export interface BacktestPanelProps {
  /** `buildBacktestBody(...)` as JSON: a change of the form makes an earlier result stale. */
  requestKey: string;
  /** The rule is complete enough to replay (metric, target and condition are valid). */
  ready: boolean;
  /** "Apply" on the suggestion: the form takes the proposed threshold (nothing is saved). */
  onApplyThreshold: (threshold: number) => void;
}

type State = { key: string; loading: boolean; result: BacktestResultDto | null; error: string | null };

/** "Backtest (last 7 days)": replays the draft condition over recent data and says how often it would have fired. */
export default function BacktestPanel({ requestKey, ready, onApplyThreshold }: BacktestPanelProps) {
  const t = useTranslations('alerts');
  const locale = useLocale();
  const [state, setState] = useState<State | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const key = requestKey;
    setState({ key, loading: true, result: null, error: null });
    try {
      const res = await fetch('/api/alerts/rules/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: key,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(await readApiError(res, t('rulesUx.backtest.failed')));
      const result = (await res.json()) as BacktestResultDto;
      setState({ key, loading: false, result, error: null });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      setState({ key, loading: false, result: null, error: error instanceof Error ? error.message : t('rulesUx.backtest.failed') });
    }
  };

  const current = state && state.key === requestKey ? state : null;
  const stale = Boolean(state && !state.loading && state.key !== requestKey);
  const result = current?.result ?? null;
  const median = result?.supported ? backtestMedianDurationMs(result.incidents) : null;

  return (
    <div className="ds-col ds-gap-sm" data-testid="backtest-panel">
      <Text size="xs" c="dimmed">
        {t('rulesUx.backtest.hint')}
      </Text>
      <Button
        size="xs"
        variant="default"
        leftSection={<IconHistory size={12} stroke={1.7} />}
        loading={Boolean(current?.loading)}
        disabled={!ready}
        onClick={() => void run()}
      >
        {t('rulesUx.backtest.run')}
      </Button>
      {stale ? (
        <Text size="xs" c="dimmed">
          {t('rulesUx.backtest.stale')}
        </Text>
      ) : null}
      {current?.error ? (
        <Text size="xs" c="red" role="alert">
          {current.error}
        </Text>
      ) : null}
      {result && !result.supported ? (
        <Text size="xs" c="dimmed" role="status">
          {t(`rulesUx.backtest.unsupported.${result.reason === 'legacy_metric' ? 'legacy_metric' : 'mode_not_replayable'}`)}
        </Text>
      ) : null}
      {result?.supported ? (
        <div className="ds-col ds-gap-sm" role="status">
          <Text size="sm" fw={600}>
            {t(pluralKey('rulesUx.backtest.summary', result.fires), { count: result.fires, days: result.days })}
          </Text>
          {median !== null ? (
            <Text size="xs" c="dimmed">
              {t('rulesUx.backtest.median', { duration: formatDurationBetween(new Date(0).toISOString(), new Date(median).toISOString()) })}
            </Text>
          ) : null}
          {result.fires === 0 ? (
            <Text size="xs" c="dimmed">
              {t('rulesUx.backtest.quiet')}
            </Text>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {topBacktestEntities(result).map((row) => (
                <li key={row.entityKey}>
                  <Text size="xs" component="span" className="ds-mono">
                    {row.entityKey}
                  </Text>{' '}
                  <Text size="xs" component="span" c="dimmed">
                    {t(pluralKey('rulesUx.backtest.entityFires', row.fires), { count: row.fires })}
                  </Text>
                </li>
              ))}
            </ul>
          )}
          {result.suggestion ? (
            <div className="ds-col ds-gap-sm">
              <Text size="xs">
                {t(pluralKey('rulesUx.backtest.suggestion', result.suggestion.firesAtThreshold), { threshold: result.suggestion.threshold, count: result.suggestion.firesAtThreshold })}
              </Text>
              <Button size="compact-xs" variant="light" style={{ alignSelf: 'flex-start' }} onClick={() => onApplyThreshold(result.suggestion!.threshold)}>
                {t('rulesUx.backtest.apply')}
              </Button>
              <Text size="xs" c="dimmed">
                {t('rulesUx.backtest.applyNote')}
              </Text>
            </div>
          ) : null}
          {translateServerNotes(result.notes, t, locale === 'en').map((note) => (
            <Text key={note} size="xs" c="dimmed">
              {note}
            </Text>
          ))}
        </div>
      ) : null}
    </div>
  );
}
