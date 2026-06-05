'use client';

import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Button, CopyButton, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconCheck,
  IconCopy,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
} from '@tabler/icons-react';

interface ModelPlaygroundProps {
  modelKey: string;
  defaultSystem?: string;
  defaultUser?: string;
}

export default function ModelPlayground({
  modelKey,
  defaultSystem = 'You are a helpful assistant.',
  defaultUser = '',
}: ModelPlaygroundProps) {
  const [system, setSystem] = useState(defaultSystem);
  const [user, setUser] = useState(defaultUser);
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [temperature, setTemperature] = useState(0.2);
  const [maxTokens, setMaxTokens] = useState(512);
  const [topP, setTopP] = useState(1);
  const [responseFormat, setResponseFormat] = useState<'text' | 'json_object'>(
    'text',
  );
  const [stats, setStats] = useState<{ ms: number; tokens: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    if (!user.trim() || running) return;
    setRunning(true);
    setOutput('');
    setStats(null);
    const abort = new AbortController();
    abortRef.current = abort;
    const t0 = performance.now();
    let full = '';

    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (system.trim()) messages.push({ role: 'system', content: system.trim() });
      messages.push({ role: 'user', content: user.trim() });

      const res = await fetch('/api/dashboard/playground/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelKey,
          messages,
          stream: true,
          temperature,
          max_tokens: maxTokens,
          top_p: topP,
          ...(responseFormat === 'json_object'
            ? { response_format: { type: 'json_object' } }
            : {}),
        }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(err.error || 'Request failed');
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              full += delta;
              setOutput(full);
            }
          } catch {
            /* skip */
          }
        }
      }

      const ms = Math.round(performance.now() - t0);
      const tokens = approxTokens(full);
      setStats({ ms, tokens });
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      console.error('Playground error', error);
      notifications.show({
        title: 'Chat error',
        message: error instanceof Error ? error.message : 'Request failed',
        color: 'red',
      });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const clear = () => {
    setOutput('');
    setStats(null);
  };

  return (
    <div className="ds-playground-grid">
      {/* Input */}
      <div className="ds-card ds-card-pad-lg ds-col ds-gap-md">
        <div className="ds-row-between">
          <div className="ds-h4">Input</div>
          <CopyButton value={`${system}\n\n${user}`} timeout={1500}>
            {({ copied, copy }) => (
              <Button
                variant="subtle"
                size="xs"
                leftSection={
                  copied ? (
                    <IconCheck size={12} stroke={2} />
                  ) : (
                    <IconCopy size={12} stroke={1.7} />
                  )
                }
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
        </div>

        <div>
          <div className="ds-eyebrow" style={{ marginBottom: 6 }}>
            System
          </div>
          <textarea
            className="ds-input ds-mono"
            rows={3}
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            style={{ fontSize: 12.5 }}
          />
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="ds-eyebrow" style={{ marginBottom: 6 }}>
            User message
          </div>
          <textarea
            className="ds-input ds-mono"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void run();
              }
            }}
            placeholder="Type a message to send to the model…"
            style={{
              fontSize: 12.5,
              flex: 1,
              minHeight: 200,
              resize: 'vertical',
            }}
          />
        </div>

        <div className="ds-row ds-gap-sm">
          {running ? (
            <Button
              color="red"
              variant="default"
              onClick={stop}
              leftSection={<IconPlayerStop size={13} stroke={1.7} />}
              style={{ flex: 1 }}
            >
              Stop
            </Button>
          ) : (
            <Button
              color="teal"
              onClick={() => void run()}
              disabled={!user.trim() || !modelKey}
              leftSection={<IconPlayerPlay size={13} stroke={1.7} />}
              style={{ flex: 1 }}
            >
              Run · ⌘↵
            </Button>
          )}
          <Tooltip label="Clear output" withArrow>
            <ActionIcon
              variant="default"
              size="lg"
              radius="md"
              onClick={clear}
              disabled={!output && !stats}
            >
              <IconRefresh size={14} stroke={1.7} />
            </ActionIcon>
          </Tooltip>
        </div>
      </div>

      {/* Output */}
      <div className="ds-card ds-card-pad-lg ds-col ds-gap-md">
        <div className="ds-row-between">
          <div className="ds-row ds-gap-sm">
            <div className="ds-h4">Output</div>
            {stats && !running ? (
              <span className="ds-badge ds-badge-ok">
                <span className="ds-badge-dot" />
                {stats.ms}ms · ~{stats.tokens} tokens
              </span>
            ) : null}
            {running ? (
              <span className="ds-badge ds-badge-info">
                <span className="ds-badge-dot" />
                streaming…
              </span>
            ) : null}
          </div>
          <CopyButton value={output} timeout={1500}>
            {({ copied, copy }) => (
              <Button
                variant="subtle"
                size="xs"
                leftSection={
                  copied ? (
                    <IconCheck size={12} stroke={2} />
                  ) : (
                    <IconCopy size={12} stroke={1.7} />
                  )
                }
                onClick={copy}
                disabled={!output}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
        </div>
        <div className="ds-playground-output">
          {output ? (
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {output}
              {running ? (
                <span className="ds-playground-cursor" aria-hidden="true" />
              ) : null}
            </div>
          ) : (
            <div
              className="ds-faint"
              style={{ fontSize: 13, fontStyle: 'italic' }}
            >
              {running
                ? 'Waiting for first token…'
                : 'Click "Run" to send a request.'}
            </div>
          )}
        </div>
      </div>

      {/* Parameters */}
      <div className="ds-card ds-card-pad-lg ds-col ds-gap-md">
        <div className="ds-h4">Parameters</div>

        <RangeRow
          label="Temperature"
          value={temperature}
          min={0}
          max={1}
          step={0.05}
          onChange={setTemperature}
          format={(v) => v.toFixed(2)}
        />
        <RangeRow
          label="Max tokens"
          value={maxTokens}
          min={64}
          max={4096}
          step={64}
          onChange={setMaxTokens}
          format={(v) => String(Math.round(v))}
        />
        <RangeRow
          label="Top P"
          value={topP}
          min={0}
          max={1}
          step={0.05}
          onChange={setTopP}
          format={(v) => v.toFixed(2)}
        />

        <div>
          <div className="ds-eyebrow" style={{ marginBottom: 6 }}>
            Response format
          </div>
          <select
            className="ds-select"
            value={responseFormat}
            onChange={(e) =>
              setResponseFormat(e.target.value as 'text' | 'json_object')
            }
            style={{ width: '100%' }}
          >
            <option value="text">text</option>
            <option value="json_object">json_object</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function RangeRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <div>
      <div
        className="ds-row-between"
        style={{ fontSize: 12, marginBottom: 6 }}
      >
        <span className="ds-muted">{label}</span>
        <span className="ds-mono">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--ds-accent)' }}
      />
    </div>
  );
}

function approxTokens(text: string): number {
  if (!text) return 0;
  // Rough heuristic: ~4 chars/token
  return Math.max(1, Math.round(text.length / 4));
}
