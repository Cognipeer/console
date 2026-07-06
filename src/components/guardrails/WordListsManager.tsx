'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  FileButton,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconFilePlus,
  IconListDetails,
  IconPencil,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';

interface WordListSummary {
  id: string;
  key: string;
  name: string;
  description?: string;
  language?: string;
  wordCount: number;
}

interface WordListDetail extends WordListSummary {
  words: string[];
}

interface WordListsManagerProps {
  opened: boolean;
  onClose: () => void;
}

const LANGUAGE_OPTIONS = [
  { value: 'tr', label: 'Turkish' },
  { value: 'en', label: 'English' },
  { value: 'mixed', label: 'Mixed / other' },
];

/**
 * Tenant word-list management: create from pasted text or CSV/TXT upload,
 * edit inline, delete. Lists are referenced from word-filter policies via
 * their key.
 */
export default function WordListsManager({ opened, onClose }: WordListsManagerProps) {
  const [lists, setLists] = useState<WordListSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // editor state — null: table view; 'new': creating; otherwise editing
  const [editing, setEditing] = useState<'new' | WordListDetail | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<string | null>(null);
  const [wordsText, setWordsText] = useState('');
  const resetRef = useRef<() => void>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/guardrails/word-lists', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load word lists');
      const data = await res.json();
      setLists(data.wordLists ?? []);
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to load word lists',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (opened) {
      void load();
      setEditing(null);
    }
  }, [opened]);

  const startCreate = () => {
    setEditing('new');
    setName('');
    setDescription('');
    setLanguage(null);
    setWordsText('');
  };

  const startEdit = async (list: WordListSummary) => {
    try {
      const res = await fetch(`/api/guardrails/word-lists/${list.id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load word list');
      const data = await res.json();
      const detail: WordListDetail = data.wordList;
      setEditing(detail);
      setName(detail.name);
      setDescription(detail.description ?? '');
      setLanguage(detail.language ?? null);
      setWordsText(detail.words.join('\n'));
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to load word list',
        color: 'red',
      });
    }
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      // Append to whatever is already in the editor
      setWordsText((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
      notifications.show({
        title: 'File loaded',
        message: `"${file.name}" content added to the editor — review and save.`,
        color: 'teal',
      });
    } catch {
      notifications.show({ title: 'Error', message: 'Could not read the file', color: 'red' });
    } finally {
      resetRef.current?.();
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      notifications.show({ title: 'Error', message: 'Name is required', color: 'red' });
      return;
    }
    if (!wordsText.trim()) {
      notifications.show({ title: 'Error', message: 'The list is empty', color: 'red' });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        language: language ?? undefined,
        content: wordsText,
      };
      const isNew = editing === 'new';
      const res = await fetch(
        isNew ? '/api/guardrails/word-lists' : `/api/guardrails/word-lists/${(editing as WordListDetail).id}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save word list');

      notifications.show({
        title: isNew ? 'Word list created' : 'Word list updated',
        message: `"${data.wordList.name}" — ${data.wordList.wordCount} words`,
        color: 'teal',
      });
      setEditing(null);
      void load();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to save word list',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (list: WordListSummary) => {
    try {
      const res = await fetch(`/api/guardrails/word-lists/${list.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete word list');
      notifications.show({ title: 'Deleted', message: `"${list.name}" removed`, color: 'teal' });
      void load();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to delete',
        color: 'red',
      });
    }
  };

  const entryCount = wordsText
    .split(/\r?\n|[,;\t]/)
    .map((w) => w.trim())
    .filter((w) => w && !w.startsWith('#')).length;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <IconListDetails size={18} />
          <Text fw={600}>Word lists</Text>
        </Group>
      }
      size="lg"
    >
      {editing === null ? (
        <Stack gap="sm">
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              Reusable banned-word lists. Reference them from a guardrail&apos;s Word Filter policy.
            </Text>
            <Button size="xs" leftSection={<IconFilePlus size={14} />} onClick={startCreate}>
              New list
            </Button>
          </Group>

          <Table highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Key</Table.Th>
                <Table.Th>Language</Table.Th>
                <Table.Th>Words</Table.Th>
                <Table.Th w={80} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lists.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text size="sm" c="dimmed" ta="center" py="sm">
                      {loading ? 'Loading…' : 'No word lists yet. Create one or upload a CSV.'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {lists.map((list) => (
                <Table.Tr key={list.id}>
                  <Table.Td>
                    <Text size="sm" fw={500}>{list.name}</Text>
                    {list.description && (
                      <Text size="xs" c="dimmed" lineClamp={1}>{list.description}</Text>
                    )}
                  </Table.Td>
                  <Table.Td><Text size="xs" ff="monospace">{list.key}</Text></Table.Td>
                  <Table.Td>
                    {list.language ? <Badge size="xs" variant="light">{list.language}</Badge> : '—'}
                  </Table.Td>
                  <Table.Td><Badge size="xs" variant="light" color="grape">{list.wordCount}</Badge></Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap" justify="flex-end">
                      <Tooltip label="Edit">
                        <ActionIcon size="sm" variant="subtle" onClick={() => void startEdit(list)}>
                          <IconPencil size={14} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete">
                        <ActionIcon size="sm" variant="subtle" color="red" onClick={() => void handleDelete(list)}>
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      ) : (
        <Stack gap="sm">
          <Group grow>
            <TextInput
              label="Name"
              required
              placeholder="e.g. Rakip markalar"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <Select
              label="Language"
              placeholder="Optional"
              data={LANGUAGE_OPTIONS}
              value={language}
              onChange={setLanguage}
              clearable
            />
          </Group>
          <TextInput
            label="Description"
            placeholder="Optional"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />

          <Divider
            label={
              <FileButton resetRef={resetRef} onChange={handleFile} accept=".csv,.txt,text/csv,text/plain">
                {(props) => (
                  <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={13} />}>
                    Upload CSV / TXT
                  </Button>
                )}
              </FileButton>
            }
            labelPosition="center"
          />

          <Textarea
            label="Words"
            description={`One entry per line (commas/semicolons also work; lines starting with # are ignored). ${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}.`}
            placeholder={'yasaklı-kelime\nbanned word\nrakip-marka'}
            value={wordsText}
            onChange={(e) => setWordsText(e.currentTarget.value)}
            autosize
            minRows={8}
            maxRows={16}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
          />

          <Group justify="space-between">
            <Button variant="default" size="xs" onClick={() => setEditing(null)}>
              Back
            </Button>
            <Button size="xs" loading={saving} onClick={() => void handleSave()}>
              {editing === 'new' ? 'Create list' : 'Save changes'}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
