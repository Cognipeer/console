'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'next/navigation';
import { ActionIcon, Button, Center, Loader, Select, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconMicrophone,
  IconPlayerStop,
  IconPlugConnected,
  IconPlugConnectedX,
  IconSend,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatusBadge from '@/components/common/ui/StatusBadge';

interface RealtimeModelOption {
  _id: string;
  key: string;
  name: string;
  status: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
}

interface LogEntry {
  id: string;
  direction: 'in' | 'out';
  type: string;
  at: string;
  payload: string;
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

type RealtimeEvent = { type: string } & Record<string, unknown>;

const MAX_LOG_ENTRIES = 200;
const BASE64_CHUNK_BYTES = 48000; // multiple of 3 → safe base64 boundaries, ~64KB encoded

let idCounter = 0;
function nextId(prefix: string) {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export default function RealtimePlaygroundPage() {
  return (
    <Suspense
      fallback={
        <Center py="xl">
          <Loader size="sm" color="teal" />
        </Center>
      }
    >
      <PlaygroundInner />
    </Suspense>
  );
}

function PlaygroundInner() {
  const searchParams = useSearchParams();
  const presetModel = searchParams.get('model');

  const [models, setModels] = useState<RealtimeModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(presetModel);
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [recording, setRecording] = useState(false);
  const [events, setEvents] = useState<LogEntry[]>([]);
  const [showLog, setShowLog] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const assistantMsgIdRef = useRef<string | null>(null);
  const audioQueueRef = useRef<string[]>([]);
  const audioPlayingRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadModels = async () => {
      try {
        const res = await fetch('/api/realtime/models', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load realtime models');
        const data = await res.json();
        if (!cancelled) setModels(data.models ?? []);
      } catch (error) {
        if (!cancelled) {
          notifications.show({
            color: 'red',
            title: 'Unable to load realtime models',
            message: error instanceof Error ? error.message : 'Unexpected error',
          });
        }
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    };
    void loadModels();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const logEvent = useCallback((direction: 'in' | 'out', event: RealtimeEvent) => {
    setEvents((prev) => {
      const entry: LogEntry = {
        id: nextId('evt'),
        direction,
        type: event.type,
        at: new Date().toLocaleTimeString(),
        payload: JSON.stringify(event, null, 2),
      };
      const next = [...prev, entry];
      return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
    });
  }, []);

  const sendEvent = useCallback(
    (event: RealtimeEvent) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        notifications.show({
          color: 'red',
          title: 'Not connected',
          message: 'Connect to a realtime model first.',
        });
        return false;
      }
      ws.send(JSON.stringify(event));
      // Avoid flooding the log with full base64 payloads.
      if (event.type === 'input_audio_buffer.append') {
        const audio = typeof event.audio === 'string' ? event.audio : '';
        logEvent('out', { type: event.type, audio: `<base64 ${audio.length} chars>` });
      } else {
        logEvent('out', event);
      }
      return true;
    },
    [logEvent],
  );

  const stopAudioPlayback = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.onended = null;
      currentAudioRef.current.onerror = null;
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    audioQueueRef.current.forEach((url) => URL.revokeObjectURL(url));
    audioQueueRef.current = [];
    audioPlayingRef.current = false;
  }, []);

  const playNextAudio = useCallback(() => {
    const url = audioQueueRef.current.shift();
    if (!url) {
      audioPlayingRef.current = false;
      currentAudioRef.current = null;
      return;
    }
    audioPlayingRef.current = true;
    const audio = new Audio(url);
    currentAudioRef.current = audio;
    const advance = () => {
      URL.revokeObjectURL(url);
      playNextAudio();
    };
    audio.onended = advance;
    audio.onerror = advance;
    void audio.play().catch(advance);
  }, []);

  const enqueueAudio = useCallback(
    (base64: string, contentType: string) => {
      try {
        const bytes = base64ToBytes(base64);
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: contentType });
        audioQueueRef.current.push(URL.createObjectURL(blob));
        if (!audioPlayingRef.current) playNextAudio();
      } catch (err) {
        console.error('Failed to decode audio chunk', err);
      }
    },
    [playNextAudio],
  );

  const handleServerEvent = useCallback(
    (event: RealtimeEvent) => {
      if (event.type === 'response.audio.delta') {
        logEvent('in', {
          type: event.type,
          content_type: event.content_type,
          audio: `<base64 ${typeof event.audio === 'string' ? event.audio.length : 0} chars>`,
        });
      } else {
        logEvent('in', event);
      }

      switch (event.type) {
        case 'response.created': {
          const id = nextId('msg');
          assistantMsgIdRef.current = id;
          setMessages((prev) => [...prev, { id, role: 'assistant', text: '', pending: true }]);
          break;
        }
        case 'response.output_text.delta': {
          const delta = typeof event.delta === 'string' ? event.delta : '';
          if (!delta) break;
          setMessages((prev) => {
            const id = assistantMsgIdRef.current;
            if (id && prev.some((m) => m.id === id)) {
              return prev.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m));
            }
            const newId = nextId('msg');
            assistantMsgIdRef.current = newId;
            return [...prev, { id: newId, role: 'assistant', text: delta, pending: true }];
          });
          break;
        }
        case 'response.output_text.done': {
          const text = typeof event.text === 'string' ? event.text : undefined;
          const id = assistantMsgIdRef.current;
          if (id) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === id ? { ...m, text: text ?? m.text, pending: false } : m,
              ),
            );
          }
          break;
        }
        case 'response.done': {
          const id = assistantMsgIdRef.current;
          if (id) {
            setMessages((prev) =>
              prev.map((m) => (m.id === id ? { ...m, pending: false } : m)),
            );
          }
          assistantMsgIdRef.current = null;
          break;
        }
        case 'input_audio_buffer.committed': {
          const transcript = typeof event.transcript === 'string' ? event.transcript : '';
          if (transcript) {
            setMessages((prev) => [
              ...prev,
              { id: nextId('msg'), role: 'user', text: transcript },
            ]);
          }
          break;
        }
        case 'response.audio.delta': {
          const audio = typeof event.audio === 'string' ? event.audio : '';
          const contentType =
            typeof event.content_type === 'string' ? event.content_type : 'audio/mpeg';
          if (audio) enqueueAudio(audio, contentType);
          break;
        }
        case 'error': {
          const error = event.error as { message?: string } | undefined;
          notifications.show({
            color: 'red',
            title: 'Realtime error',
            message: error?.message ?? 'Unknown error',
          });
          break;
        }
        default:
          break;
      }
    },
    [enqueueAudio, logEvent],
  );

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    setRecording(false);
    stopAudioPlayback();
    assistantMsgIdRef.current = null;
    setConnState('disconnected');
  }, [stopAudioPlayback]);

  const connect = useCallback(() => {
    if (!selectedKey) {
      notifications.show({
        color: 'red',
        title: 'No model selected',
        message: 'Pick a realtime model before connecting.',
      });
      return;
    }
    disconnect();
    setConnState('connecting');
    setMessages([]);
    setEvents([]);

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/api/client/v1/realtime?model=${encodeURIComponent(selectedKey)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      setConnState('connected');
    };
    ws.onmessage = (e) => {
      if (wsRef.current !== ws) return;
      try {
        const event = JSON.parse(String(e.data)) as RealtimeEvent;
        handleServerEvent(event);
      } catch (err) {
        console.error('Failed to parse realtime event', err);
      }
    };
    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      notifications.show({
        color: 'red',
        title: 'Connection error',
        message: 'The realtime WebSocket reported an error.',
      });
    };
    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      setConnState('disconnected');
    };
  }, [selectedKey, disconnect, handleServerEvent]);

  useEffect(() => {
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    const ok = sendEvent({
      type: 'conversation.item.create',
      item: { role: 'user', content: text },
    });
    if (!ok) return;
    setMessages((prev) => [...prev, { id: nextId('msg'), role: 'user', text }]);
    setInput('');
    sendEvent({ type: 'response.create' });
  }, [input, sendEvent]);

  const flushRecordedAudio = useCallback(async () => {
    const chunks = recorderChunksRef.current;
    recorderChunksRef.current = [];
    if (chunks.length === 0) return;
    try {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      for (let i = 0; i < bytes.length; i += BASE64_CHUNK_BYTES) {
        const slice = bytes.subarray(i, i + BASE64_CHUNK_BYTES);
        const ok = sendEvent({
          type: 'input_audio_buffer.append',
          audio: bytesToBase64(slice),
        });
        if (!ok) return;
      }
      sendEvent({ type: 'input_audio_buffer.commit' });
      sendEvent({ type: 'response.create' });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Failed to send audio',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  }, [sendEvent]);

  const startRecording = useCallback(async () => {
    if (connState !== 'connected') {
      notifications.show({
        color: 'red',
        title: 'Not connected',
        message: 'Connect to a realtime model before recording.',
      });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recorderChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recorderChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        void flushRecordedAudio();
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Microphone unavailable',
        message: error instanceof Error ? error.message : 'Could not access the microphone.',
      });
    }
  }, [connState, flushRecordedAudio]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
  }, []);

  const modelOptions = useMemo(
    () =>
      models.map((m) => ({
        value: m.key,
        label: m.status === 'active' ? m.name : `${m.name} (disabled)`,
      })),
    [models],
  );

  const connBadge =
    connState === 'connected' ? (
      <StatusBadge status="active" label="Connected" />
    ) : connState === 'connecting' ? (
      <StatusBadge status="pending" label="Connecting…" />
    ) : (
      <StatusBadge status="paused" label="Disconnected" />
    );

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Inference · Realtime"
        title="Realtime playground"
        subtitle="Talk to a realtime model over WebSocket — text chat, microphone input, and streamed audio playback."
        actions={connBadge}
      />

      <div className="ds-card" style={{ padding: 14, marginBottom: 12 }}>
        <div className="ds-row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Select
            label="Realtime model"
            placeholder={modelsLoading ? 'Loading…' : 'Select a realtime model'}
            data={modelOptions}
            value={selectedKey}
            onChange={setSelectedKey}
            searchable
            disabled={connState !== 'disconnected'}
            style={{ minWidth: 260 }}
          />
          {connState === 'disconnected' ? (
            <Button
              color="teal"
              leftSection={<IconPlugConnected size={14} stroke={1.7} />}
              disabled={!selectedKey}
              onClick={connect}
            >
              Connect
            </Button>
          ) : (
            <Button
              variant="default"
              leftSection={<IconPlugConnectedX size={14} stroke={1.7} />}
              onClick={disconnect}
            >
              Disconnect
            </Button>
          )}
          <div style={{ flex: 1 }} />
          <Button
            variant={showLog ? 'light' : 'default'}
            color="gray"
            leftSection={<IconTerminal2 size={14} stroke={1.7} />}
            onClick={() => setShowLog((v) => !v)}
          >
            {showLog ? 'Hide event log' : 'Show event log'}
          </Button>
        </div>
      </div>

      <div className="ds-row" style={{ gap: 12, alignItems: 'stretch' }}>
        <div
          className="ds-card"
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            height: 560,
          }}
        >
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {messages.length === 0 ? (
              <div className="ds-empty" style={{ flex: 1 }}>
                <div className="ds-empty-icon">
                  <IconSend size={26} stroke={1.7} />
                </div>
                <div className="ds-h4" style={{ marginBottom: 4 }}>
                  {connState === 'connected'
                    ? 'Say something'
                    : 'Connect to start a session'}
                </div>
                <span className="ds-muted" style={{ fontSize: 13, textAlign: 'center' }}>
                  Type a message or hold a recording with the microphone button.
                </span>
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '78%',
                    padding: '8px 12px',
                    fontSize: 13.5,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    borderRadius: 'var(--ds-r-md)',
                    background:
                      m.role === 'user' ? 'var(--ds-accent)' : 'var(--ds-surface-raised)',
                    color:
                      m.role === 'user' ? 'var(--ds-text-on-accent)' : 'var(--ds-text)',
                    border:
                      m.role === 'user' ? 'none' : '1px solid var(--ds-border-soft)',
                  }}
                >
                  {m.text || (m.pending ? '…' : '')}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <div
            className="ds-row"
            style={{
              gap: 8,
              padding: 12,
              borderTop: '1px solid var(--ds-border-soft)',
            }}
          >
            <input
              className="ds-input"
              style={{
                flex: 1,
                fontSize: 13.5,
                padding: '8px 12px',
                borderRadius: 'var(--ds-r-sm)',
                border: '1px solid var(--ds-border)',
                background: 'transparent',
                color: 'var(--ds-text)',
                outline: 'none',
              }}
              placeholder={
                connState === 'connected' ? 'Type a message…' : 'Connect to send messages'
              }
              value={input}
              disabled={connState !== 'connected'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
            />
            <Tooltip label={recording ? 'Stop recording' : 'Record audio'} withArrow>
              <ActionIcon
                size="lg"
                radius="md"
                variant={recording ? 'filled' : 'default'}
                color={recording ? 'red' : 'gray'}
                disabled={connState !== 'connected'}
                aria-label={recording ? 'Stop recording' : 'Record audio'}
                onClick={() => {
                  if (recording) stopRecording();
                  else void startRecording();
                }}
              >
                {recording ? (
                  <IconPlayerStop size={16} stroke={1.7} />
                ) : (
                  <IconMicrophone size={16} stroke={1.7} />
                )}
              </ActionIcon>
            </Tooltip>
            <Button
              color="teal"
              leftSection={<IconSend size={14} stroke={1.7} />}
              disabled={connState !== 'connected' || !input.trim()}
              onClick={sendMessage}
            >
              Send
            </Button>
          </div>
        </div>

        {showLog ? (
          <div
            className="ds-card"
            style={{
              width: 360,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              height: 560,
            }}
          >
            <div
              className="ds-row-between"
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--ds-border-soft)',
              }}
            >
              <span className="ds-h4">Raw events</span>
              <Tooltip label="Clear log" withArrow>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Clear log"
                  onClick={() => setEvents([])}
                >
                  <IconTrash size={14} stroke={1.7} />
                </ActionIcon>
              </Tooltip>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
              {events.length === 0 ? (
                <span className="ds-faint" style={{ fontSize: 12.5 }}>
                  No events yet.
                </span>
              ) : (
                events.map((e) => (
                  <details key={e.id} style={{ marginBottom: 6 }}>
                    <summary
                      className="ds-mono"
                      style={{
                        cursor: 'pointer',
                        fontSize: 11.5,
                        color:
                          e.direction === 'out'
                            ? 'var(--ds-accent)'
                            : 'var(--ds-text-muted)',
                      }}
                    >
                      {e.direction === 'out' ? '→' : '←'} {e.type}{' '}
                      <span className="ds-faint">{e.at}</span>
                    </summary>
                    <pre
                      className="ds-mono"
                      style={{
                        margin: '4px 0 0',
                        padding: '6px 8px',
                        fontSize: 10.5,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        background: 'var(--ds-surface-code)',
                        color: 'var(--ds-surface-code-text)',
                        borderRadius: 'var(--ds-r-xs)',
                        maxHeight: 220,
                        overflowY: 'auto',
                      }}
                    >
                      {e.payload}
                    </pre>
                  </details>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>
    </PageContainer>
  );
}
