'use client';

/**
 * Side drawer with the full detail of one run item: output, every scorer's
 * verdict (score, passed / skipped / error, judge reasoning and other detail),
 * tool calls, recorded turns and usage. Replaces the old 120-character cell.
 */

import { Alert, Code, Drawer, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { EvalRunItemView, EvalToolCallView, EvalUsageView } from './types';
import { OUTCOME_BADGE, itemOutcome, scoreOutcome } from './runViewHelpers';

function pct(value?: number): string {
  return value === undefined || value === null ? '—' : `${Math.round(value * 100)}%`;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function usageLine(u?: EvalUsageView): string | null {
  if (!u) return null;
  const parts: string[] = [];
  if (u.inputTokens !== undefined) parts.push(`${u.inputTokens.toLocaleString()} in`);
  if (u.outputTokens !== undefined) parts.push(`${u.outputTokens.toLocaleString()} out`);
  if (u.cachedInputTokens) parts.push(`${u.cachedInputTokens.toLocaleString()} cached`);
  if (u.reasoningTokens) parts.push(`${u.reasoningTokens.toLocaleString()} reasoning`);
  if (u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(4)}`);
  return parts.length ? parts.join(' · ') : null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>{title}</Text>
      {children}
    </div>
  );
}

function Block({ children }: { children: React.ReactNode }) {
  return (
    <pre
      className="ds-mono"
      style={{ margin: 0, padding: 10, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--mantine-color-default-hover)', borderRadius: 6, maxHeight: 360, overflow: 'auto' }}
    >
      {children}
    </pre>
  );
}

function ToolCalls({ calls }: { calls: EvalToolCallView[] }) {
  return (
    <Stack gap={4}>
      {calls.map((c, idx) => (
        <Block key={`${c.id ?? c.name}-${idx}`}>{`${c.name}(${json(c.args)})`}</Block>
      ))}
    </Stack>
  );
}

interface Props {
  item: EvalRunItemView | null;
  onClose: () => void;
}

export default function EvaluationRunItemDrawer({ item, onClose }: Props) {
  const outcome = item ? itemOutcome(item) : null;
  const turns = item?.output?.turns ?? [];
  const calls = item?.output?.toolCalls ?? [];

  return (
    <Drawer opened={!!item} onClose={onClose} position="right" size="xl" title={item ? <span className="ds-mono">{item.itemId}</span> : ''}>
      {item && outcome ? (
        <Stack gap="md" data-testid="eval-item-detail">
          <Group gap="xs">
            <span className={`ds-badge ${OUTCOME_BADGE[outcome]}`}>{outcome === 'error' ? 'errored' : outcome === 'skipped' ? 'skipped' : outcome === 'pass' ? 'passed' : 'failed'}</span>
            {outcome !== 'skipped' && outcome !== 'error' ? <Text size="sm">Score {pct(item.score)}</Text> : null}
            {item.latencyMs !== undefined ? <Text size="sm" c="dimmed">{Math.round(item.latencyMs)} ms</Text> : null}
            {item.output?.truncated ? <span className="ds-badge ds-badge-warn" title="The target stopped because it hit its output limit">output truncated</span> : null}
          </Group>

          {item.restricted ? (
            <Alert color="gray" variant="light">Hidden: this item used knowledge base documents you cannot read.</Alert>
          ) : null}

          {item.error ? (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title="Error">
              <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.error}</Text>
            </Alert>
          ) : null}

          {item.skipped && !item.error ? (
            <Alert color="gray" variant="light" title="Skipped">
              No scorer applied to this item, so it counts as neither passed nor failed.
            </Alert>
          ) : null}

          {!item.restricted ? (
            <>
              <Section title="Output">
                {item.output?.text ? <Block>{item.output.text}</Block> : <Text size="sm" c="dimmed">{calls.length ? 'No text: the target answered with tool calls only.' : 'No output.'}</Text>}
              </Section>

              {turns.length > 0 ? (
                <Section title={`Turns (${turns.length})`}>
                  <Stack gap="sm">
                    {turns.map((t) => (
                      <div key={t.index}>
                        <Text size="xs" c="dimmed">Turn {t.index + 1}{t.latencyMs !== undefined ? ` · ${Math.round(t.latencyMs)} ms` : ''}{usageLine(t.usage) ? ` · ${usageLine(t.usage)}` : ''}</Text>
                        <Text size="xs" fw={600} mt={2}>User</Text>
                        <Block>{t.question}</Block>
                        <Text size="xs" fw={600} mt={4}>Assistant</Text>
                        {t.text ? <Block>{t.text}</Block> : <Text size="xs" c="dimmed">No text.</Text>}
                        {t.toolCalls && t.toolCalls.length > 0 ? <ToolCalls calls={t.toolCalls} /> : null}
                      </div>
                    ))}
                  </Stack>
                </Section>
              ) : null}

              {calls.length > 0 ? (
                <Section title={`Tool calls (${calls.length})`}>
                  <ToolCalls calls={calls} />
                </Section>
              ) : null}

              <Section title="Scorers">
                {item.scores.length === 0 ? (
                  <Text size="sm" c="dimmed">No scorer results.</Text>
                ) : (
                  <Stack gap="sm">
                    {item.scores.map((s, idx) => {
                      const so = scoreOutcome(s);
                      const detail = s.detail ?? {};
                      const reasoning = typeof detail.reasoning === 'string' ? detail.reasoning : undefined;
                      const reason = typeof detail.reason === 'string' ? detail.reason : undefined;
                      const { reasoning: _r, reason: _s, ...rest } = detail;
                      void _r; void _s;
                      const spend = usageLine(s.usage);
                      return (
                        <div key={`${s.scorerType}-${idx}`} className="ds-card ds-card-pad-sm" data-testid={`eval-score-${so}`}>
                          <Group gap="xs" mb={4}>
                            <span className="ds-mono" style={{ fontSize: 12 }}>{s.scorerType}</span>
                            <span className={`ds-badge ${OUTCOME_BADGE[so]}`}>{so === 'error' ? 'error' : so === 'skipped' ? 'skipped' : so === 'pass' ? 'pass' : 'fail'}</span>
                            {so === 'pass' || so === 'fail' ? <Text size="xs">{pct(s.score)}</Text> : null}
                            <Text size="xs" c="dimmed">weight {s.weight}</Text>
                          </Group>
                          {s.error ? <Text size="sm" c="red" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{s.error}</Text> : null}
                          {so === 'skipped' ? <Text size="sm" c="dimmed">{reason ?? 'This scorer does not apply to this item.'}</Text> : null}
                          {reasoning ? (
                            <>
                              <Text size="xs" fw={600}>Judge reasoning</Text>
                              <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{reasoning}</Text>
                            </>
                          ) : null}
                          {Object.keys(rest).length > 0 ? <Code block mt={4} style={{ fontSize: 11, maxHeight: 220, overflow: 'auto' }}>{json(rest)}</Code> : null}
                          {spend ? <Text size="xs" c="dimmed" mt={4}>Judge usage: {spend}</Text> : null}
                        </div>
                      );
                    })}
                  </Stack>
                )}
              </Section>
            </>
          ) : null}

          {usageLine(item.usage) || usageLine(item.scoringUsage) ? (
            <Section title="Usage">
              {usageLine(item.usage) ? <Text size="sm">Target: {usageLine(item.usage)}</Text> : null}
              {usageLine(item.scoringUsage) ? <Text size="sm">Scoring (judge): {usageLine(item.scoringUsage)}</Text> : null}
            </Section>
          ) : null}
        </Stack>
      ) : null}
    </Drawer>
  );
}
