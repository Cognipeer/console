'use client';

import { useEffect, useState } from 'react';
import { Button, Code, Group, Modal, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { AnalysisConversationView } from './types';

interface IngestConversationsModalProps {
  opened: boolean;
  onClose: () => void;
  onIngested: (conversations: AnalysisConversationView[]) => void;
}

const EXAMPLE = `[
  {
    "name": "Call 1042",
    "transcript": [
      { "role": "caller", "content": "I was charged twice." },
      { "role": "agent", "content": "I've issued a refund." }
    ],
    "referenceFields": { "intent": "billing", "resolved": true }
  }
]`;

interface ConversationInput {
  name?: string;
  transcript: Array<{ role: string; content: string }>;
  referenceFields?: Record<string, unknown>;
}

function parseConversations(raw: string): { conversations: ConversationInput[] } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'Paste at least one conversation' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { error: `Invalid JSON: ${(err as Error).message}` };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const conversations: ConversationInput[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i] as Record<string, unknown>;
    if (!entry || typeof entry !== 'object') return { error: `Item ${i} is not an object` };
    if (!Array.isArray(entry.transcript) || entry.transcript.length === 0) {
      return { error: `Item ${i} must have a non-empty "transcript" array` };
    }
    for (const m of entry.transcript) {
      const msg = m as Record<string, unknown>;
      if (typeof msg.role !== 'string' || typeof msg.content !== 'string') {
        return { error: `Item ${i} has a message missing "role"/"content"` };
      }
    }
    conversations.push({
      name: typeof entry.name === 'string' ? entry.name : undefined,
      transcript: entry.transcript as ConversationInput['transcript'],
      referenceFields: (entry.referenceFields as Record<string, unknown> | undefined) ?? undefined,
    });
  }
  return { conversations };
}

export default function IngestConversationsModal({ opened, onClose, onIngested }: IngestConversationsModalProps) {
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) { setValue(''); setError(null); }
  }, [opened]);

  const handleSubmit = async () => {
    const parsed = parseConversations(value);
    if ('error' in parsed) { setError(parsed.error); return; }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/analysis/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversations: parsed.conversations }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to ingest conversations');
      }
      const data = await res.json();
      notifications.show({ title: 'Conversations ingested', message: `${data.conversations.length} added`, color: 'teal' });
      onIngested(data.conversations);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to ingest', color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Ingest conversations" centered size="lg">
      <Stack gap="md">
        <Textarea
          label="Conversations (JSON)"
          description={<>An array of conversations. Each needs a <Code>transcript</Code> of <Code>{'{ role, content }'}</Code> turns; optional <Code>name</Code> and <Code>referenceFields</Code> (ground truth for accuracy).</>}
          placeholder={EXAMPLE}
          autosize
          minRows={10}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          error={error}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button color="teal" loading={loading} onClick={handleSubmit}>Ingest</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
