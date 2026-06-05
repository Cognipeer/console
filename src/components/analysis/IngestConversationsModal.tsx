'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Code, FileButton, Group, Stack, TagsInput, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconDownload, IconFileSpreadsheet, IconInfoCircle, IconUpload } from '@tabler/icons-react';
import FormShell, {
  ChipPicker,
  Checklist,
  FormField,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { AnalysisConversationView } from './types';
import {
  downloadConversationTemplate,
  JSON_CONVERSATION_TEMPLATE,
  parseConversationFile,
  parseJsonConversations,
  type ConversationInput,
} from './conversationImport';

interface IngestConversationsModalProps {
  opened: boolean;
  onClose: () => void;
  onIngested: (conversations: AnalysisConversationView[]) => void;
}

type InputMode = 'file' | 'json';

export default function IngestConversationsModal({ opened, onClose, onIngested }: IngestConversationsModalProps) {
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<InputMode>('file');
  const [jsonText, setJsonText] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [fileConversations, setFileConversations] = useState<ConversationInput[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) {
      setMode('file'); setJsonText(''); setTags([]);
      setFileConversations([]); setFileName(null); setFileError(null);
      setLoading(false);
    }
  }, [opened]);

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    setFileError(null);
    const result = await parseConversationFile(file);
    if ('error' in result) {
      setFileConversations([]);
      setFileError(result.error);
    } else {
      setFileConversations(result.conversations);
      if (result.conversations.length === 0) setFileError('No conversations found — check the headers (need a content column).');
    }
  };

  const jsonParsed = useMemo(() => parseJsonConversations(jsonText), [jsonText]);
  const jsonError = 'error' in jsonParsed ? jsonParsed.error : null;

  const conversations: ConversationInput[] = useMemo(() => {
    if (mode === 'file') return fileConversations;
    return 'conversations' in jsonParsed ? jsonParsed.conversations : [];
  }, [mode, fileConversations, jsonParsed]);

  const count = conversations.length;
  const valid = count > 0 && (mode !== 'json' || !jsonError) && (mode !== 'file' || !fileError);

  const handleSubmit = async () => {
    if (!valid) return;
    setLoading(true);
    try {
      const res = await fetch('/api/analysis/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversations, tags: tags.length > 0 ? tags : undefined }),
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

  const checklist = [{ id: 'src', label: valid ? `${count} conversation(s) ready` : 'Add conversations', done: valid }];

  const summary = (
    <SummaryGroup title="Ingest">
      <SummaryKV label="Source" value={mode === 'file' ? (fileName ?? 'file') : 'JSON'} />
      <SummaryKV label="Conversations" value={String(count)} />
      <SummaryKV label="Tags" value={tags.length > 0 ? tags.join(', ') : '—'} />
      <Checklist items={checklist} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconUpload size={16} />}
      title="Ingest conversations"
      subtitle="Import transcripts from an Excel/CSV/JSON export — or via the API — to analyze them."
      summary={summary}
      footerStatus={valid ? `${count} ready` : 'Add conversations to continue'}
      primaryAction={{
        label: 'Ingest',
        icon: <IconCheck size={13} />,
        loading,
        disabled: !valid,
        onClick: () => void handleSubmit(),
      }}
    >
      <FormSection number={1} title="Source" done={valid}>
        <FormField label="How do you want to import?">
          <ChipPicker<InputMode>
            value={mode}
            onChange={(v) => setMode(v as InputMode)}
            options={[
              { value: 'file', label: 'Excel / CSV / JSON file' },
              { value: 'json', label: 'Paste JSON' },
            ]}
          />
        </FormField>

        <FormField
          label="Tags"
          hint="Applied to every conversation in this batch (merged with any per-row/per-item tags). Use tags to group conversations and target runs."
        >
          <TagsInput
            placeholder="Add a tag and press Enter (e.g. billing, march-2026)"
            value={tags}
            onChange={setTags}
            clearable
          />
        </FormField>

        {mode === 'file' && (
          <Stack gap="sm">
            <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
              Upload an <strong>.xlsx</strong>, <strong>.csv</strong> or <strong>.json</strong> file. For spreadsheets use a header row with
              <Code>conversation_id</Code>, <Code>role</Code>, <Code>content</Code> (one turn per row; rows sharing an id form one transcript),
              an optional <Code>tags</Code> column (comma-separated, for grouping) and an optional <Code>reference</Code> column (JSON ground truth for accuracy).
            </Alert>
            <Group gap="xs">
              <Button variant="light" size="xs" leftSection={<IconDownload size={14} />} onClick={() => downloadConversationTemplate('xlsx')}>Excel template</Button>
              <Button variant="light" size="xs" leftSection={<IconDownload size={14} />} onClick={() => downloadConversationTemplate('csv')}>CSV template</Button>
            </Group>
            <Group>
              <FileButton onChange={(f) => void handleFile(f)} accept=".xlsx,.xls,.csv,.tsv,.json">
                {(props) => <Button {...props} variant="default" leftSection={<IconFileSpreadsheet size={15} />}>Choose file</Button>}
              </FileButton>
              {fileName ? <Text size="sm" c="dimmed">{fileName}</Text> : null}
            </Group>
            {fileError ? <Text size="sm" c="red">{fileError}</Text> : null}
            {count > 0 ? (
              <Box>
                <Text size="xs" c="dimmed" mb={4}>Parsed {count} conversation(s). First:</Text>
                <Code block fz="xs" style={{ whiteSpace: 'pre-wrap' }}>
                  {conversations.slice(0, 3).map((c) => `• ${c.name ?? 'conversation'} (${c.transcript.length} turns)`).join('\n')}
                </Code>
              </Box>
            ) : null}
          </Stack>
        )}

        {mode === 'json' && (
          <FormField
            label="Conversations (JSON)"
            action={
              <Button variant="subtle" size="compact-xs" leftSection={<IconDownload size={12} />} onClick={() => setJsonText(JSON_CONVERSATION_TEMPLATE)}>
                Load example
              </Button>
            }
            hint={<>An array of conversations. Each needs a <Code>transcript</Code> of <Code>{'{ role, content }'}</Code> turns; optional <Code>name</Code> and <Code>referenceFields</Code>.</>}
          >
            <Textarea
              placeholder={JSON_CONVERSATION_TEMPLATE}
              autosize
              minRows={12}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
              value={jsonText}
              onChange={(e) => setJsonText(e.currentTarget.value)}
              error={jsonError}
            />
          </FormField>
        )}
      </FormSection>

      <FormSection title="Via API">
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>
          Ingest programmatically by POSTing the same JSON to
          <Code>/api/analysis/conversations</Code> — body <Code>{'{ "conversations": [ … ] }'}</Code>.
        </Alert>
      </FormSection>
    </FormShell>
  );
}
