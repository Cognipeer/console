'use client';

/**
 * SpecImportField
 *
 * Shared importer for API specifications used by the "New MCP server" and
 * "New tool" dialogs. Accepts an OpenAPI document (JSON or YAML) or a Postman
 * collection through three input methods:
 *
 *   - Paste     — drop the spec text directly
 *   - Upload    — read a local .json / .yaml / .yml file
 *   - From URL  — fetch the spec server-side (SSRF-guarded) via /api/specs/fetch
 *
 * The raw text and a format hint are lifted to the parent form; the backend
 * normalizes YAML / Postman into canonical OpenAPI on submit.
 */

import { useRef, useState } from 'react';
import {
  Button,
  FileButton,
  Group,
  Loader,
  Select,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconClipboard,
  IconLink,
  IconUpload,
} from '@tabler/icons-react';
import { ChipPicker } from '@/components/common/ui/FormShell';

export type SpecFormat = 'auto' | 'openapi' | 'postman';

type ImportMethod = 'paste' | 'upload' | 'url';

const FORMAT_OPTIONS = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'openapi', label: 'OpenAPI / Swagger (JSON or YAML)' },
  { value: 'postman', label: 'Postman collection' },
];

const FORMAT_LABEL: Record<string, string> = {
  'openapi-json': 'OpenAPI (JSON)',
  'openapi-yaml': 'OpenAPI (YAML)',
  postman: 'Postman collection',
};

interface SpecImportFieldProps {
  value: string;
  onChange: (value: string) => void;
  format: SpecFormat;
  onFormatChange: (format: SpecFormat) => void;
  /** Placeholder for the paste textarea. */
  placeholder?: string;
  minRows?: number;
}

export default function SpecImportField({
  value,
  onChange,
  format,
  onFormatChange,
  placeholder = '{ "openapi": "3.0.0", ... }  — or YAML, or a Postman collection',
  minRows = 12,
}: SpecImportFieldProps) {
  const [method, setMethod] = useState<ImportMethod>('paste');
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const resetFileRef = useRef<() => void>(null);

  const handleFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      onChange(text);
      setFileName(file.name);
      notifications.show({
        title: 'File loaded',
        message: `Loaded ${file.name} (${text.length.toLocaleString()} chars)`,
        color: 'teal',
      });
    } catch {
      notifications.show({
        title: 'Error',
        message: 'Could not read the selected file',
        color: 'red',
      });
    } finally {
      resetFileRef.current?.();
    }
  };

  const handleFetchUrl = async () => {
    if (!url.trim()) return;
    setFetching(true);
    try {
      const res = await fetch('/api/specs/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), format }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch specification');
      }
      onChange(data.content ?? '');
      notifications.show({
        title: 'Specification fetched',
        message: data.detectedFormat
          ? `Detected: ${FORMAT_LABEL[data.detectedFormat] ?? data.detectedFormat}`
          : 'Fetched successfully',
        color: 'teal',
      });
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to fetch specification',
        color: 'red',
      });
    } finally {
      setFetching(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <ChipPicker<ImportMethod>
        options={[
          { value: 'paste', label: 'Paste', icon: <IconClipboard size={14} /> },
          { value: 'upload', label: 'Upload file', icon: <IconUpload size={14} /> },
          { value: 'url', label: 'From URL', icon: <IconLink size={14} /> },
        ]}
        value={method}
        onChange={(v) => setMethod(v as ImportMethod)}
      />

      <Group grow align="flex-end" gap="sm">
        <Select
          label="Format"
          data={FORMAT_OPTIONS}
          value={format}
          onChange={(v) => onFormatChange((v as SpecFormat) || 'auto')}
          comboboxProps={{ withinPortal: true }}
        />
      </Group>

      {method === 'upload' && (
        <Group gap="sm" align="center">
          <FileButton
            resetRef={resetFileRef}
            accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
            onChange={handleFile}
          >
            {(props) => (
              <Button {...props} variant="light" leftSection={<IconUpload size={14} />}>
                Choose file…
              </Button>
            )}
          </FileButton>
          {fileName && <Text size="sm" c="dimmed">{fileName}</Text>}
        </Group>
      )}

      {method === 'url' && (
        <Group gap="sm" align="flex-end">
          <TextInput
            style={{ flex: 1 }}
            label="Specification URL"
            placeholder="https://api.example.com/openapi.yaml"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleFetchUrl();
              }
            }}
          />
          <Button
            onClick={handleFetchUrl}
            disabled={!url.trim() || fetching}
            leftSection={fetching ? <Loader size={14} /> : <IconLink size={14} />}
          >
            Fetch
          </Button>
        </Group>
      )}

      <Textarea
        label={method === 'paste' ? 'Specification' : 'Specification (editable)'}
        description={
          method === 'paste'
            ? 'Paste an OpenAPI (JSON/YAML) document or a Postman collection.'
            : 'Loaded content — you can review or edit before creating.'
        }
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        autosize
        minRows={minRows}
        maxRows={20}
        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
      />
    </div>
  );
}
