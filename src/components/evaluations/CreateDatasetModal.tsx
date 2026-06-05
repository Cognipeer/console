'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Code,
  FileButton,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconDatabase, IconDownload, IconFileSpreadsheet, IconFileText, IconInfoCircle, IconPlus, IconSparkles, IconTrash } from '@tabler/icons-react';
import FormShell, {
  ChipPicker,
  Checklist,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { EvalDatasetItemView, EvalDatasetView, ModelOption } from './types';
import {
  downloadDatasetTemplate,
  editorRowsToItems,
  emptyEditorRow,
  JSON_TEMPLATE,
  parseDatasetFile,
  parseJsonItems,
  type EditorRow,
} from './datasetImport';

interface CreateDatasetModalProps {
  opened: boolean;
  models: ModelOption[];
  onClose: () => void;
  onCreated: (dataset: EvalDatasetView) => void;
  /** When set, the modal edits this dataset (PATCH) instead of creating one. */
  editing?: EvalDatasetView | null;
}

type InputMode = 'editor' | 'file' | 'json' | 'generate';
type GenerateSource = 'rag' | 'text' | 'file';

interface RagModuleOption {
  value: string;
  label: string;
}

/** Read a File as a base64 string (without the data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const JSON_EXAMPLE = `[
  {
    "id": "q1",
    "input": [{ "role": "user", "content": "What is 2+2?" }],
    "expected": { "mustContain": ["4"], "reference": "4" }
  }
]`;

export default function CreateDatasetModal({ opened, models, onClose, onCreated, editing = null }: CreateDatasetModalProps) {
  const isEdit = Boolean(editing);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<InputMode>('editor');

  // Generate-mode state.
  const [genSource, setGenSource] = useState<GenerateSource>('rag');
  const [genModelKey, setGenModelKey] = useState<string | null>(null);
  const [genCount, setGenCount] = useState<number>(10);
  const [genLanguage, setGenLanguage] = useState('');
  const [ragModuleKey, setRagModuleKey] = useState<string | null>(null);
  const [ragModules, setRagModules] = useState<RagModuleOption[]>([]);
  const [genText, setGenText] = useState('');
  const [genFile, setGenFile] = useState<File | null>(null);

  const [rows, setRows] = useState<EditorRow[]>([emptyEditorRow()]);
  const [jsonText, setJsonText] = useState('');
  const [fileItems, setFileItems] = useState<EvalDatasetItemView[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) {
      setName(''); setDescription(''); setMode('editor');
      setRows([emptyEditorRow()]); setJsonText('');
      setFileItems([]); setFileName(null); setFileError(null);
      setLoading(false);
      setGenSource('rag'); setGenModelKey(null); setGenCount(10); setGenLanguage('');
      setRagModuleKey(null); setGenText(''); setGenFile(null);
      return;
    }
    if (editing) {
      // Edit: prefill name/description and load the existing items into the JSON
      // editor (lossless for arbitrary message arrays / expectations).
      setName(editing.name ?? '');
      setDescription(editing.description ?? '');
      setMode('json');
      setJsonText(JSON.stringify(editing.items ?? [], null, 2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  // Load RAG modules for the "generate from documents" source.
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    void fetch('/api/rag/modules', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { modules: [] }))
      .then((data) => {
        if (cancelled) return;
        const mods = (data.modules ?? []) as Array<{ key: string; name: string }>;
        setRagModules(mods.map((m) => ({ value: m.key, label: m.name })));
      })
      .catch(() => { if (!cancelled) setRagModules([]); });
    return () => { cancelled = true; };
  }, [opened]);

  const updateRow = (idx: number, patch: Partial<EditorRow>) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    setFileError(null);
    const result = await parseDatasetFile(file);
    if ('error' in result) {
      setFileItems([]);
      setFileError(result.error);
    } else {
      setFileItems(result.items);
      if (result.items.length === 0) setFileError('No rows found — check the column headers (need an input/question column).');
    }
  };

  const jsonParsed = useMemo(() => parseJsonItems(jsonText), [jsonText]);
  const jsonError = 'error' in jsonParsed ? jsonParsed.error : null;

  const items: EvalDatasetItemView[] = useMemo(() => {
    if (mode === 'editor') return editorRowsToItems(rows);
    if (mode === 'file') return fileItems;
    return 'items' in jsonParsed ? jsonParsed.items : [];
  }, [mode, rows, fileItems, jsonParsed]);

  const isGenerate = mode === 'generate';
  const validName = name.trim().length > 0;
  const validItems = items.length > 0 && (mode !== 'json' || !jsonError) && (mode !== 'file' || !fileError);
  const genSourceReady =
    genSource === 'rag' ? Boolean(ragModuleKey)
      : genSource === 'text' ? genText.trim().length > 0
        : Boolean(genFile);
  const genValid = Boolean(genModelKey) && genSourceReady && genCount > 0;
  const canSubmit = validName && (isGenerate ? genValid : validItems);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    try {
      const res = await fetch(
        isEdit ? `/api/evaluation/datasets/${editing!.id}` : '/api/evaluation/datasets',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), description: description || undefined, items }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to ${isEdit ? 'update' : 'create'} dataset`);
      }
      const data = await res.json();
      notifications.show({ title: isEdit ? 'Dataset updated' : 'Dataset created', message: `"${data.dataset.name}" (${data.dataset.items.length} items)`, color: 'teal' });
      onCreated(data.dataset);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to create dataset', color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!canSubmit) return;
    setLoading(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        description: description || undefined,
        generationModelKey: genModelKey,
        sourceType: genSource,
        count: genCount,
        language: genLanguage.trim() || undefined,
      };
      if (genSource === 'rag') payload.ragModuleKey = ragModuleKey;
      else if (genSource === 'text') payload.text = genText;
      else if (genSource === 'file' && genFile) {
        payload.fileName = genFile.name;
        payload.contentType = genFile.type || undefined;
        payload.fileData = await fileToBase64(genFile);
      }

      const res = await fetch('/api/evaluation/datasets/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to generate dataset');
      }
      const data = await res.json();
      notifications.show({
        title: 'Generation started',
        message: `"${data.dataset.name}" — generating ${genCount} question(s) in the background…`,
        color: 'blue',
      });
      onCreated(data.dataset);
      onClose();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to generate dataset', color: 'red' });
    } finally {
      setLoading(false);
    }
  };

  const sourceLabel = mode === 'editor' ? 'UI editor'
    : mode === 'file' ? (fileName ?? 'file')
      : mode === 'json' ? 'JSON'
        : `AI · ${genSource}`;

  const checklist = [
    { id: 'name', label: 'Name provided', done: validName },
    isGenerate
      ? { id: 'gen', label: genValid ? `Ready to generate ${genCount} question(s)` : 'Pick a model and source', done: genValid }
      : { id: 'items', label: validItems ? `${items.length} item(s) ready` : 'Add test cases', done: validItems },
  ];

  const summary = (
    <SummaryGroup title="Dataset">
      <SummaryKV label="Name" value={name || '—'} />
      <SummaryKV label="Source" value={sourceLabel} />
      <SummaryKV label="Items" value={isGenerate ? `~${genCount}` : String(items.length)} />
      <Checklist items={checklist} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconDatabase size={16} />}
      title={isEdit ? 'Edit evaluation dataset' : 'New evaluation dataset'}
      subtitle="Add test cases by hand, import a file, paste JSON, or generate Q&A from documents with a model."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: isEdit ? 'Save changes' : isGenerate ? 'Generate dataset' : 'Create dataset',
        icon: isGenerate ? <IconSparkles size={13} /> : <IconCheck size={13} />,
        loading,
        disabled: !canSubmit,
        onClick: () => void (isGenerate ? handleGenerate() : handleSubmit()),
      }}
    >
      <FormSection number={1} title="Identity" done={validName}>
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput placeholder="e.g. Customer FAQ regression set" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          </FormField>
          <FormField label="Description" optional>
            <Textarea placeholder="What does this dataset cover?" autosize minRows={2} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection number={2} title="Test cases" done={validItems}>
        <FormField label="How do you want to add cases?">
          <ChipPicker<InputMode>
            value={mode}
            onChange={(v) => setMode(v as InputMode)}
            options={[
              { value: 'editor', label: 'Editor' },
              { value: 'file', label: 'Excel / CSV / JSON file' },
              { value: 'json', label: 'Paste JSON' },
              { value: 'generate', label: 'Generate with AI' },
            ]}
          />
        </FormField>

        {mode === 'editor' && (
          <Stack gap="sm">
            {rows.map((r, idx) => (
              <Paper key={idx} withBorder radius="md" p="sm">
                <Group justify="space-between" mb={6}>
                  <Text size="xs" c="dimmed" fw={600}>Case {idx + 1}</Text>
                  <ActionIcon variant="subtle" color="red" disabled={rows.length === 1} onClick={() => setRows((prev) => prev.filter((_, i) => i !== idx))}>
                    <IconTrash size={15} />
                  </ActionIcon>
                </Group>
                <Stack gap="xs">
                  <Textarea label="Question / input" placeholder="What the target is asked" autosize minRows={1} value={r.input} onChange={(e) => updateRow(idx, { input: e.currentTarget.value })} />
                  <Group grow align="flex-start">
                    <TextInput label="Expected answer" placeholder="Gold answer (judge / semantic)" value={r.reference} onChange={(e) => updateRow(idx, { reference: e.currentTarget.value })} />
                    <TextInput label="Must contain" placeholder="comma / | separated" value={r.contains} onChange={(e) => updateRow(idx, { contains: e.currentTarget.value })} />
                  </Group>
                  <Group grow align="flex-start">
                    <TextInput label="ID" placeholder="auto" value={r.id} onChange={(e) => updateRow(idx, { id: e.currentTarget.value })} />
                    <TextInput label="Tags" placeholder="comma separated" value={r.tags} onChange={(e) => updateRow(idx, { tags: e.currentTarget.value })} />
                  </Group>
                </Stack>
              </Paper>
            ))}
            <Button variant="light" size="xs" leftSection={<IconPlus size={14} />} onClick={() => setRows((prev) => [...prev, emptyEditorRow()])} style={{ alignSelf: 'flex-start' }}>
              Add case
            </Button>
          </Stack>
        )}

        {mode === 'file' && (
          <Stack gap="sm">
            <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
              Upload an <strong>.xlsx</strong>, <strong>.csv</strong> or <strong>.json</strong> file. For spreadsheets, use a header row with
              columns like <Code>question</Code>, <Code>expected</Code> (gold answer), <Code>contains</Code>, <Code>tags</Code> — one case per row.
              Not sure about the format? Download a ready-made template below.
            </Alert>
            <Group gap="xs">
              <Button variant="light" size="xs" leftSection={<IconDownload size={14} />} onClick={() => downloadDatasetTemplate('xlsx')}>
                Excel template
              </Button>
              <Button variant="light" size="xs" leftSection={<IconDownload size={14} />} onClick={() => downloadDatasetTemplate('csv')}>
                CSV template
              </Button>
            </Group>
            <Group>
              <FileButton onChange={(f) => void handleFile(f)} accept=".xlsx,.xls,.csv,.tsv,.json">
                {(props) => <Button {...props} variant="default" leftSection={<IconFileSpreadsheet size={15} />}>Choose file</Button>}
              </FileButton>
              {fileName ? <Text size="sm" c="dimmed">{fileName}</Text> : null}
            </Group>
            {fileError ? <Text size="sm" c="red">{fileError}</Text> : null}
            {fileItems.length > 0 ? (
              <Box>
                <Text size="xs" c="dimmed" mb={4}>Parsed {fileItems.length} item(s). First rows:</Text>
                <Code block fz="xs" style={{ whiteSpace: 'pre-wrap' }}>
                  {fileItems.slice(0, 3).map((it) => `• ${it.input.find((m) => m.role === 'user')?.content ?? ''}${it.expected?.reference ? `  → ${String(it.expected.reference)}` : ''}`).join('\n')}
                </Code>
              </Box>
            ) : null}
          </Stack>
        )}

        {mode === 'json' && (
          <FormField
            label="Items (JSON array)"
            action={
              <Button variant="subtle" size="compact-xs" leftSection={<IconDownload size={12} />} onClick={() => setJsonText(JSON_TEMPLATE)}>
                Load example
              </Button>
            }
            hint={<>Full control: each item needs an <Code>input</Code> message array; optional <Code>expected</Code> with reference / mustContain / equals / regex / jsonSchema / jsonPath.</>}
          >
            <Textarea
              placeholder={JSON_EXAMPLE}
              autosize
              minRows={10}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
              value={jsonText}
              onChange={(e) => setJsonText(e.currentTarget.value)}
              error={jsonError}
            />
          </FormField>
        )}

        {mode === 'generate' && (
          <Stack gap="sm">
            <Alert color="grape" variant="light" icon={<IconSparkles size={16} />}>
              Generate question + reference-answer pairs with a model, grounded in your content.
              Use them to evaluate a RAG module, model, or agent.
            </Alert>

            <FormField label="Source">
              <ChipPicker<GenerateSource>
                value={genSource}
                onChange={(v) => setGenSource(v as GenerateSource)}
                options={[
                  { value: 'rag', label: 'RAG module documents' },
                  { value: 'text', label: 'Paste text' },
                  { value: 'file', label: 'Upload file' },
                ]}
              />
            </FormField>

            {genSource === 'rag' && (
              <FormField label="RAG module" required hint="Questions are generated from this module's indexed documents.">
                <Select
                  placeholder={ragModules.length ? 'Select a RAG module' : 'No RAG modules found'}
                  data={ragModules}
                  value={ragModuleKey}
                  onChange={setRagModuleKey}
                  searchable
                  nothingFoundMessage="No RAG modules"
                />
              </FormField>
            )}

            {genSource === 'text' && (
              <FormField label="Source text" required>
                <Textarea
                  placeholder="Paste the document text to generate questions from…"
                  autosize
                  minRows={6}
                  value={genText}
                  onChange={(e) => setGenText(e.currentTarget.value)}
                />
              </FormField>
            )}

            {genSource === 'file' && (
              <FormField label="Source file" required hint="PDF, DOCX, TXT, MD, HTML, etc. Converted to text on the server.">
                <Group>
                  <FileButton onChange={setGenFile} accept=".pdf,.docx,.doc,.txt,.md,.rtf,.html,.htm,.csv">
                    {(props) => <Button {...props} variant="default" leftSection={<IconFileText size={15} />}>Choose file</Button>}
                  </FileButton>
                  {genFile ? <Text size="sm" c="dimmed">{genFile.name}</Text> : null}
                </Group>
              </FormField>
            )}

            <FormRow cols={2}>
              <FormField label="Generation model" required>
                <Select
                  placeholder={models.length ? 'Select a model' : 'No LLM models found'}
                  data={models}
                  value={genModelKey}
                  onChange={setGenModelKey}
                  searchable
                  nothingFoundMessage="No models"
                />
              </FormField>
              <FormField label="Number of questions">
                <NumberInput min={1} max={100} value={genCount} onChange={(v) => setGenCount(typeof v === 'number' ? v : 10)} />
              </FormField>
            </FormRow>

            <FormField label="Language" optional hint="Optional hint, e.g. Turkish or English.">
              <TextInput placeholder="auto" value={genLanguage} onChange={(e) => setGenLanguage(e.currentTarget.value)} />
            </FormField>
          </Stack>
        )}
      </FormSection>
    </FormShell>
  );
}
