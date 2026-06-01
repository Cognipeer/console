'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { sandboxApi } from './_lib/api';

interface TerminalFrame {
  type: 'stdin' | 'stdout' | 'stderr' | 'resize' | 'exit' | 'ping' | 'pong';
  data?: string;
  cols?: number;
  rows?: number;
  reason?: string;
}

interface Props {
  instanceId: string;
  instanceName: string;
  onClose: () => void;
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
} as const;

const backdropButtonStyle = {
  position: 'absolute',
  inset: 0,
  border: 'none',
  padding: 0,
  margin: 0,
  background: 'transparent',
  cursor: 'default',
} as const;

const sheetStyle = {
  position: 'relative',
  zIndex: 1,
  width: '82%',
  maxWidth: 920,
  background: '#0b0f17',
  borderRadius: 10,
  overflow: 'hidden',
  boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
} as const;

export default function TerminalModal({ instanceId, instanceName, onClose }: Props) {
  const [output, setOutput] = useState('');
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const teardown = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setOutput('');
    setStatus('connecting');
    (async () => {
      try {
        const { websocketPath } = await sandboxApi.openTerminal(instanceId);
        if (cancelled) return;
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${window.location.host}${websocketPath}`);
        wsRef.current = ws;
        ws.onopen = () => {
          setStatus('open');
          ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 30 } as TerminalFrame));
        };
        ws.onmessage = (ev) => {
          try {
            const frame = JSON.parse(ev.data as string) as TerminalFrame;
            if (frame.type === 'stdout' || frame.type === 'stderr') {
              setOutput((prev) => (prev + (frame.data ?? '')).slice(-100_000));
            } else if (frame.type === 'exit') {
              setOutput((prev) => `${prev}\n[session ended: ${frame.reason ?? ''}]\n`);
              setStatus('closed');
            }
          } catch {
            /* ignore non-JSON */
          }
        };
        ws.onclose = () => setStatus((s) => (s === 'error' ? s : 'closed'));
        ws.onerror = () => setStatus('error');
      } catch (err) {
        setOutput(`Failed to open terminal: ${err instanceof Error ? err.message : String(err)}`);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      teardown();
    };
  }, [instanceId, teardown]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [output]);

  // Send raw stdin (no implicit newline) — used by the quick-answer buttons so
  // interactive prompts (Y/n, Ctrl-C, bare Enter) can be answered with a click.
  const sendRaw = (data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'stdin', data } as TerminalFrame));
  };

  const send = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'stdin', data: input + '\n' } as TerminalFrame));
    setInput('');
  };

  return (
    <div style={overlayStyle}>
      <button type="button" aria-label="Close terminal" style={backdropButtonStyle} onClick={onClose} />
      <div style={sheetStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#111827', color: '#e5e7eb' }}>
          <span style={{ fontSize: 14 }}>
            Terminal — {instanceName} <small style={{ opacity: 0.6 }}>({status})</small>
          </span>
          <button onClick={onClose} style={{ color: '#e5e7eb', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16 }} aria-label="Close">
            ✕
          </button>
        </div>
        <pre
          style={{ margin: 0, height: 440, overflow: 'auto', padding: 14, color: '#d1d5db', background: '#0b0f17', fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 13, whiteSpace: 'pre-wrap' }}
        >
          {output || '[awaiting agent…]'}
          <div ref={endRef} />
        </pre>
        <div style={{ display: 'flex', gap: 6, padding: '8px 10px 0', background: '#111827', flexWrap: 'wrap' }}>
          <span style={{ color: '#6b7280', fontSize: 11, alignSelf: 'center' }}>Answer prompts:</span>
          {[
            { label: 'y ↵', data: 'y\n' },
            { label: 'n ↵', data: 'n\n' },
            { label: '↵ Enter', data: '\n' },
            { label: 'Ctrl-C', data: '\x03' },
            { label: 'Ctrl-D', data: '\x04' },
            { label: 'Tab', data: '\t' },
          ].map((b) => (
            <button
              key={b.label}
              onClick={() => sendRaw(b.data)}
              style={{ padding: '3px 9px', background: '#1f2937', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 5, cursor: 'pointer', fontSize: 12, fontFamily: 'ui-monospace, monospace' }}
            >
              {b.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, padding: 10, background: '#111827' }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
            }}
            placeholder="type input / command, press Enter to send"
            style={{ flex: 1, padding: '7px 11px', background: '#0b0f17', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 6, fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
          />
          <button onClick={send} style={{ padding: '7px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
