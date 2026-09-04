'use client';

import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Button, CopyButton, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconCheck,
  IconCopy,
  IconPhoto,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconX,
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
  const [reasoning, setReasoning] = useState('');
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const [running, setRunning] = useState(false);
  const [temperature, setTemperature] = useState(0.2);
  // Reasoning models spend a large share of the budget on the thinking trace
  // before emitting any answer, so default generously and allow a high ceiling.
  const [maxTokens, setMaxTokens] = useState(1024);
  const [topP, setTopP] = useState(1);
  const [responseFormat, setResponseFormat] = useState<'text' | 'json_object'>(
    'text',
  );
  // Attached images travel as OpenAI `image_url` parts with a data: URL, which
  // is the only shape every vision-capable upstream accepts without the gateway
  // having to host the file somewhere first.
  const [images, setImages] = useState<Array<{ name: string; dataUrl: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [stats, setStats] = useState<{ ms: number; tokens: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const attachImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const read = (file: File) =>
      new Promise<{ name: string; dataUrl: string }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, dataUrl: String(reader.result) });
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    const attached = await Promise.all(Array.from(files).map(read));
    setImages((current) => [...current, ...attached]);
  };

  const run = async () => {
    if (!user.trim() || running) return;
    setRunning(true);
    setOutput('');
    setReasoning('');
    setReasoningOpen(true);
    setStats(null);
    const abort = new AbortController();
    abortRef.current = abort;
    const t0 = performance.now();
    let full = '';
    let fullReasoning = '';

    try {
      type ContentPart =
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } };
      const messages: Array<{ role: string; content: string | ContentPart[] }> = [];
      if (system.trim()) messages.push({ role: 'system', content: system.trim() });
      messages.push({
        role: 'user',
        content: images.length > 0
          ? ([
            { type: 'text', text: user.trim() },
            ...images.map((image) => ({
              type: 'image_url' as const,
              image_url: { url: image.dataUrl },
            })),
          ] as ContentPart[])
          : user.trim(),
      });

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

          let parsed: Record<string, unknown> | undefined;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          // A failure after the first token cannot change the HTTP status, so
          // the gateway reports it in-band. Skipping unparsed frames is fine;
          // skipping this one would end the run quietly and look like a short
          // but successful answer.
          const frameError = parsed?.error as { message?: string } | undefined;
          if (frameError) {
            throw new Error(frameError.message || 'The model stopped mid-response');
          }

          const choices = parsed?.choices as Array<{ delta?: Record<string, unknown> }> | undefined;
          const choiceDelta = choices?.[0]?.delta ?? {};
          const reasoningDelta = extractReasoningDelta(choiceDelta);
          if (reasoningDelta) {
            fullReasoning += reasoningDelta;
            setReasoning(fullReasoning);
          }
          const delta = typeof choiceDelta.content === 'string' ? choiceDelta.content : '';
          if (delta) {
            full += delta;
            setOutput(full);
            // Collapse the thinking trace once the final answer starts.
            if (fullReasoning) setReasoningOpen(false);
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
    setReasoning('');
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

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void attachImages(e.target.files);
            e.target.value = '';
          }}
        />

        {images.length > 0 ? (
          <div className="ds-row ds-gap-xs" style={{ flexWrap: 'wrap' }}>
            {images.map((image, index) => (
              <div
                key={`${image.name}-${index}`}
                className="ds-row ds-gap-xs"
                style={{
                  alignItems: 'center',
                  border: '1px solid var(--mantine-color-default-border)',
                  borderRadius: 6,
                  padding: '2px 6px',
                  fontSize: 11,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.dataUrl} alt={image.name} width={22} height={22} style={{ objectFit: 'cover', borderRadius: 3 }} />
                <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {image.name}
                </span>
                <ActionIcon
                  variant="subtle"
                  size="xs"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                >
                  <IconX size={12} stroke={1.7} />
                </ActionIcon>
              </div>
            ))}
          </div>
        ) : null}

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
          <Tooltip label="Attach image (vision)" withArrow>
            <ActionIcon
              variant="default"
              size="lg"
              radius="md"
              aria-label="Attach image"
              onClick={() => fileInputRef.current?.click()}
            >
              <IconPhoto size={15} stroke={1.7} />
            </ActionIcon>
          </Tooltip>
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
          {reasoning ? (
            <div
              style={{
                marginBottom: output ? 12 : 0,
                borderLeft: '2px solid var(--ds-accent, #7c3aed)',
                paddingLeft: 10,
              }}
            >
              <button
                type="button"
                onClick={() => setReasoningOpen((v) => !v)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'var(--ds-accent, #7c3aed)',
                  fontSize: 11.5,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                  textTransform: 'uppercase',
                }}
              >
                {running && !output ? 'Thinking…' : 'Reasoning'}
                <span style={{ fontSize: 10 }}>{reasoningOpen ? '▾' : '▸'}</span>
              </button>
              {reasoningOpen ? (
                <div
                  className="ds-faint"
                  style={{
                    fontSize: 12,
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    marginTop: 6,
                  }}
                >
                  {reasoning}
                  {running && !output ? (
                    <span className="ds-playground-cursor" aria-hidden="true" />
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
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
          ) : !reasoning ? (
            <div
              className="ds-faint"
              style={{ fontSize: 13, fontStyle: 'italic' }}
            >
              {running
                ? 'Waiting for first token…'
                : 'Click "Run" to send a request.'}
            </div>
          ) : null}
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
          max={16384}
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

/**
 * Reasoning models stream their chain-of-thought as `delta.reasoning_content`
 * (OpenAI-compatible) — and some emit `delta.reasoning` as a string or object.
 * Normalize to a plain string delta.
 */
function extractReasoningDelta(delta: Record<string, unknown>): string {
  const reasoningContent = delta.reasoning_content;
  if (typeof reasoningContent === 'string') return reasoningContent;

  const reasoning = delta.reasoning;
  if (typeof reasoning === 'string') return reasoning;
  if (reasoning && typeof reasoning === 'object') {
    const r = reasoning as Record<string, unknown>;
    if (typeof r.text === 'string') return r.text;
    if (typeof r.summary === 'string') return r.summary;
    if (Array.isArray(r.summary)) {
      return r.summary
        .map((s) =>
          typeof s === 'string'
            ? s
            : s && typeof s === 'object' && typeof (s as Record<string, unknown>).text === 'string'
              ? ((s as Record<string, unknown>).text as string)
              : '',
        )
        .join('');
    }
  }
  return '';
}
