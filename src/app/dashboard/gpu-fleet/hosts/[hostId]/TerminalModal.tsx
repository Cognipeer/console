'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconTerminal2 } from '@tabler/icons-react';

const SANDBOX_OPTIONS = [
  { value: 'docker-debug', label: 'docker-debug (sandboxed shell with /host:ro)' },
  { value: 'host', label: 'host (/bin/sh on the host)' },
  { value: 'deployment-exec', label: 'deployment-exec (into a container)' },
];

interface TerminalModalProps {
  opened: boolean;
  onClose: () => void;
  hostId: string;
  hostName: string;
  terminalEnabled: boolean;
}

interface SessionResponse {
  sessionId: string;
  websocketPath: string;
  expiresAt: string;
}

type Sandbox = 'docker-debug' | 'host' | 'deployment-exec';

export default function TerminalModal({ opened, onClose, hostId, hostName, terminalEnabled }: TerminalModalProps) {
  const [sandbox, setSandbox] = useState<Sandbox>('docker-debug');
  const [deploymentId, setDeploymentId] = useState('');
  const [active, setActive] = useState<SessionResponse | null>(null);
  const [output, setOutput] = useState<string>('');
  const [input, setInput] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const outputEnd = useRef<HTMLDivElement>(null);

  const teardown = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setActive(null);
  }, []);

  useEffect(() => () => teardown(), [teardown]);
  useEffect(() => {
    if (!opened) teardown();
  }, [opened, teardown]);

  useEffect(() => {
    outputEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [output]);

  const open = async () => {
    setBusy(true);
    setOutput('');
    try {
      const res = await fetch(`/api/gpu-fleet/hosts/${hostId}/terminal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sandbox,
          deploymentId: sandbox === 'deployment-exec' ? deploymentId : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const session = (await res.json()) as SessionResponse;
      setActive(session);

      const ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${session.websocketPath}`,
      );
      wsRef.current = ws;
      ws.onmessage = (e) => {
        try {
          const frame = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
          if (frame.type === 'stdout' || frame.type === 'stderr') {
            setOutput((prev) => prev + frame.data);
          } else if (frame.type === 'exit') {
            setOutput((prev) => `${prev}\n[session ended: ${frame.reason}]\n`);
            teardown();
          }
        } catch {
          // ignore
        }
      };
      ws.onclose = () => setActive(null);
      ws.onerror = () => setActive(null);
    } catch (error) {
      setOutput((prev) => `${prev}\nerror: ${error instanceof Error ? error.message : 'unknown'}\n`);
    } finally {
      setBusy(false);
    }
  };

  const sendInput = (e: React.FormEvent) => {
    e.preventDefault();
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'stdin', data: input + '\n' }));
    setOutput((prev) => `${prev}$ ${input}\n`);
    setInput('');
  };

  return (
    <Modal opened={opened} onClose={onClose} title={`Terminal — ${hostName}`} size="xl">
      {!terminalEnabled ? (
        <Alert color="red">
          Terminal access is disabled for this host. Toggle it from the host claim flow or settings.
        </Alert>
      ) : !active ? (
        <Stack>
          <Select
            label="Sandbox"
            data={SANDBOX_OPTIONS}
            value={sandbox}
            onChange={(v) => setSandbox((v ?? 'docker-debug') as Sandbox)}
          />
          {sandbox === 'deployment-exec' ? (
            <TextInput
              label="Deployment id"
              value={deploymentId}
              onChange={(e) => setDeploymentId(e.currentTarget.value)}
              description="The container will receive `docker exec -it`."
            />
          ) : null}
          <Alert color="blue">
            Phase 1: pipe-based shell. Interactive TUIs (vim, htop) are not supported yet.
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button leftSection={<IconTerminal2 size={14} />} onClick={open} loading={busy}>
              Open session
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Group gap="xs">
            <Badge color="teal" variant="light">
              session {active.sessionId.slice(0, 8)}
            </Badge>
            <Text size="xs" c="dimmed">
              expires {new Date(active.expiresAt).toLocaleTimeString()}
            </Text>
          </Group>
          <Code
            block
            style={{
              minHeight: 300,
              maxHeight: 480,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              fontSize: 12,
            }}
          >
            {output || '[awaiting agent…]'}
            <div ref={outputEnd} />
          </Code>
          <form onSubmit={sendInput}>
            <Group>
              <TextInput
                style={{ flex: 1 }}
                placeholder="type a command and press Enter…"
                value={input}
                onChange={(e) => setInput(e.currentTarget.value)}
                autoFocus
              />
              <Button type="submit">Send</Button>
              <Button variant="default" color="red" onClick={teardown}>
                Close
              </Button>
            </Group>
          </form>
        </Stack>
      )}
    </Modal>
  );
}
