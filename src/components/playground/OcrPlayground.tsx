'use client';

import { useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  FileButton,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconFileText,
  IconFileUpload,
  IconLayoutGrid,
  IconLink,
  IconPlayerPlay,
  IconRefresh,
  IconScan,
  IconTable,
  IconX,
} from '@tabler/icons-react';

interface OcrPlaygroundProps {
  modelKey: string;
  /** Default OCR mode from the model config — used for the badge only. */
  configuredMode?: 'native' | 'vlm';
}

interface OcrPage {
  pageNumber: number;
  text: string;
  language?: string;
}

interface OcrTableCell {
  rowIndex: number;
  colIndex: number;
  text: string;
}

interface OcrTable {
  rows: number;
  cols: number;
  cells: OcrTableCell[];
}

interface OcrResult {
  text: string;
  pages?: OcrPage[];
  tables?: OcrTable[];
  keyValuePairs?: Array<{ key: string; value: string; confidence?: number }>;
  language?: string;
  invokedVia?: 'native' | 'vlm';
  usage?: { pages?: number; inputTokens?: number; outputTokens?: number };
}

type Source = 'file' | 'url';

function renderTable(table: OcrTable) {
  const grid: string[][] = Array.from({ length: table.rows }, () =>
    Array.from({ length: table.cols }, () => ''),
  );
  for (const cell of table.cells) {
    if (cell.rowIndex < table.rows && cell.colIndex < table.cols) {
      grid[cell.rowIndex][cell.colIndex] = cell.text;
    }
  }
  return (
    <Table withTableBorder withColumnBorders striped>
      <Table.Tbody>
        {grid.map((row, ri) => (
          <Table.Tr key={ri}>
            {row.map((cell, ci) => (
              <Table.Td key={ci}>
                <Text size="xs">{cell}</Text>
              </Table.Td>
            ))}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export default function OcrPlayground({ modelKey, configuredMode }: OcrPlaygroundProps) {
  const [source, setSource] = useState<Source>('file');
  const [file, setFile] = useState<File | null>(null);
  const [documentUrl, setDocumentUrl] = useState('');
  const [language, setLanguage] = useState('');
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const resetRef = useRef<() => void>(() => {});

  const run = async () => {
    if (source === 'file' && !file) {
      notifications.show({
        color: 'orange',
        title: 'Select a document',
        message: 'Upload a PDF or image to extract text.',
      });
      return;
    }
    if (source === 'url' && !documentUrl.trim()) {
      notifications.show({
        color: 'orange',
        title: 'Provide a URL',
        message: 'Enter a document URL accessible to the provider.',
      });
      return;
    }

    setRunning(true);
    setError(null);
    setResult(null);
    setLatency(null);
    const t0 = performance.now();
    try {
      let response: Response;
      if (source === 'file' && file) {
        const form = new FormData();
        form.append('model', modelKey);
        form.append('file', file, file.name);
        if (language.trim()) form.append('language', language.trim());
        if (prompt.trim()) form.append('prompt', prompt.trim());
        response = await fetch('/api/dashboard/playground/ocr', {
          method: 'POST',
          body: form,
        });
      } else {
        response = await fetch('/api/dashboard/playground/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelKey,
            document: { url: documentUrl.trim() },
            language: language.trim() || undefined,
            prompt: prompt.trim() || undefined,
          }),
        });
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      setResult(data as OcrResult);
      setLatency(performance.now() - t0);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OCR request failed';
      setError(message);
      notifications.show({ color: 'red', title: 'OCR failed', message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Stack gap="md">
      <Paper withBorder radius="md" p="md">
        <Stack gap="sm">
          <Group justify="space-between">
            <Group gap="xs">
              <IconScan size={18} />
              <Text fw={600}>Document input</Text>
            </Group>
            {configuredMode && (
              <Badge
                variant="light"
                color={configuredMode === 'native' ? 'teal' : 'violet'}
              >
                mode: {configuredMode}
              </Badge>
            )}
          </Group>

          <SegmentedControl
            value={source}
            onChange={(v) => setSource(v as Source)}
            data={[
              {
                value: 'file',
                label: (
                  <Group gap={4}>
                    <IconFileUpload size={14} />
                    <Text size="xs">Upload</Text>
                  </Group>
                ),
              },
              {
                value: 'url',
                label: (
                  <Group gap={4}>
                    <IconLink size={14} />
                    <Text size="xs">URL</Text>
                  </Group>
                ),
              },
            ]}
          />

          {source === 'file' ? (
            <Group justify="space-between">
              <FileButton
                resetRef={resetRef}
                accept="application/pdf,image/*"
                onChange={setFile}
              >
                {(props) => (
                  <Button
                    {...props}
                    variant="default"
                    leftSection={<IconFileUpload size={16} />}
                  >
                    {file ? 'Replace document' : 'Choose document'}
                  </Button>
                )}
              </FileButton>
              {file && (
                <Group gap={6}>
                  <Badge variant="light">{file.name}</Badge>
                  <Button
                    size="xs"
                    variant="subtle"
                    color="red"
                    leftSection={<IconX size={14} />}
                    onClick={() => {
                      setFile(null);
                      resetRef.current?.();
                    }}
                  >
                    Clear
                  </Button>
                </Group>
              )}
            </Group>
          ) : (
            <TextInput
              label="Document URL"
              placeholder="https://…/invoice.pdf"
              value={documentUrl}
              onChange={(e) => setDocumentUrl(e.currentTarget.value)}
              leftSection={<IconLink size={14} />}
            />
          )}

          <Group grow>
            <TextInput
              label="Language hint (ISO 639-1)"
              placeholder="tr, en, …"
              value={language}
              onChange={(e) => setLanguage(e.currentTarget.value)}
            />
          </Group>

          <Textarea
            label="Prompt (VLM mode only)"
            description="Custom extraction instructions when the model is in VLM mode. Ignored by native OCR providers."
            placeholder="Leave empty to use the default OCR prompt."
            autosize
            minRows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
          />

          <Group justify="flex-end">
            <Button
              variant="default"
              leftSection={<IconRefresh size={14} />}
              disabled={running}
              onClick={() => {
                setResult(null);
                setError(null);
                setLatency(null);
              }}
            >
              Reset
            </Button>
            <Button
              leftSection={<IconPlayerPlay size={14} />}
              loading={running}
              onClick={run}
            >
              Extract
            </Button>
          </Group>
        </Stack>
      </Paper>

      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
      )}

      {result && (
        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">
            <Group justify="space-between">
              <Text fw={600}>Extraction result</Text>
              <Group gap={6}>
                {result.invokedVia && (
                  <Badge
                    variant="light"
                    color={result.invokedVia === 'native' ? 'teal' : 'violet'}
                  >
                    via {result.invokedVia}
                  </Badge>
                )}
                {result.language && (
                  <Badge variant="light" color="blue">
                    {result.language}
                  </Badge>
                )}
                {result.usage?.pages !== undefined && (
                  <Badge variant="light">{result.usage.pages} pages</Badge>
                )}
                {latency !== null && (
                  <Badge variant="light" color="gray">
                    {latency.toFixed(0)} ms
                  </Badge>
                )}
              </Group>
            </Group>

            <Tabs defaultValue="text">
              <Tabs.List>
                <Tabs.Tab value="text" leftSection={<IconFileText size={14} />}>
                  Text
                </Tabs.Tab>
                {Array.isArray(result.pages) && result.pages.length > 0 && (
                  <Tabs.Tab value="pages" leftSection={<IconLayoutGrid size={14} />}>
                    Pages ({result.pages.length})
                  </Tabs.Tab>
                )}
                {Array.isArray(result.tables) && result.tables.length > 0 && (
                  <Tabs.Tab value="tables" leftSection={<IconTable size={14} />}>
                    Tables ({result.tables.length})
                  </Tabs.Tab>
                )}
                {Array.isArray(result.keyValuePairs) && result.keyValuePairs.length > 0 && (
                  <Tabs.Tab value="kv" leftSection={<IconLayoutGrid size={14} />}>
                    Key-value ({result.keyValuePairs.length})
                  </Tabs.Tab>
                )}
              </Tabs.List>

              <Tabs.Panel value="text" pt="sm">
                <Textarea
                  autosize
                  minRows={10}
                  maxRows={30}
                  readOnly
                  value={result.text}
                  styles={{
                    input: {
                      fontFamily: 'var(--mantine-font-family-monospace, monospace)',
                    },
                  }}
                />
              </Tabs.Panel>

              {result.pages && (
                <Tabs.Panel value="pages" pt="sm">
                  <ScrollArea h={500}>
                    <Stack gap="sm">
                      {result.pages.map((page) => (
                        <Paper key={page.pageNumber} withBorder radius="sm" p="sm">
                          <Group justify="space-between" mb={4}>
                            <Badge variant="light">Page {page.pageNumber}</Badge>
                            {page.language && (
                              <Badge variant="light" color="blue">
                                {page.language}
                              </Badge>
                            )}
                          </Group>
                          <Text
                            size="sm"
                            style={{
                              whiteSpace: 'pre-wrap',
                              fontFamily: 'var(--mantine-font-family-monospace, monospace)',
                            }}
                          >
                            {page.text}
                          </Text>
                        </Paper>
                      ))}
                    </Stack>
                  </ScrollArea>
                </Tabs.Panel>
              )}

              {result.tables && (
                <Tabs.Panel value="tables" pt="sm">
                  <Stack gap="sm">
                    {result.tables.map((table, idx) => (
                      <Paper key={idx} withBorder radius="sm" p="sm">
                        <Text size="sm" fw={500} mb={6}>
                          Table {idx + 1} — {table.rows} × {table.cols}
                        </Text>
                        <ScrollArea>{renderTable(table)}</ScrollArea>
                      </Paper>
                    ))}
                  </Stack>
                </Tabs.Panel>
              )}

              {result.keyValuePairs && (
                <Tabs.Panel value="kv" pt="sm">
                  <Table withTableBorder withColumnBorders striped>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Key</Table.Th>
                        <Table.Th>Value</Table.Th>
                        <Table.Th>Confidence</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {result.keyValuePairs.map((kv, idx) => (
                        <Table.Tr key={idx}>
                          <Table.Td>
                            <Text size="sm" fw={500}>
                              {kv.key}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">{kv.value}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="dimmed">
                              {kv.confidence !== undefined
                                ? `${(kv.confidence * 100).toFixed(1)}%`
                                : '—'}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Tabs.Panel>
              )}
            </Tabs>
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
