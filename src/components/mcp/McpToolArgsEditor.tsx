'use client';

/**
 * Argument editor for MCP playground tool calls.
 *
 * Renders the tool's JSON Schema as form fields (with a raw-JSON fallback
 * mode). The JSON string is the single source of truth: form fields parse it
 * on render and re-serialize on change, so the two modes never drift and
 * unknown keys typed in JSON mode survive form edits.
 */

import { useMemo, useState } from 'react';
import {
  Alert,
  Checkbox,
  JsonInput,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { IconAlertTriangle, IconForms, IconBraces } from '@tabler/icons-react';

interface PropertySchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

interface McpToolArgsEditorProps {
  /** JSON Schema of the selected tool's input (may be empty/absent). */
  inputSchema?: Record<string, unknown> | null;
  /** Arguments as a JSON string — the single source of truth. */
  value: string;
  onChange: (value: string) => void;
}

function schemaType(schema: PropertySchema): string {
  if (Array.isArray(schema.type)) {
    return schema.type.find((t) => t !== 'null') ?? 'string';
  }
  return schema.type ?? (schema.enum ? 'string' : schema.properties ? 'object' : 'string');
}

function parseArgs(value: string): { args: Record<string, unknown> | null; error: string | null } {
  const trimmed = value.trim();
  if (!trimmed) return { args: {}, error: null };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, error: null };
    }
    return { args: null, error: 'Arguments must be a JSON object' };
  } catch (err) {
    return { args: null, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
}

export default function McpToolArgsEditor({ inputSchema, value, onChange }: McpToolArgsEditorProps) {
  const properties = useMemo(
    () => (inputSchema?.properties && typeof inputSchema.properties === 'object'
      ? inputSchema.properties as Record<string, PropertySchema>
      : {}),
    [inputSchema],
  );
  const required = useMemo(
    () => new Set(Array.isArray(inputSchema?.required) ? inputSchema.required as string[] : []),
    [inputSchema],
  );
  const hasFormFields = Object.keys(properties).length > 0;
  const [mode, setMode] = useState<'form' | 'json'>(hasFormFields ? 'form' : 'json');

  const { args, error: parseError } = useMemo(() => parseArgs(value), [value]);

  const setField = (name: string, fieldValue: unknown) => {
    const next = { ...(args ?? {}) };
    const isEmpty = fieldValue === undefined
      || fieldValue === null
      || (typeof fieldValue === 'string' && fieldValue === '');
    if (isEmpty) {
      delete next[name];
    } else {
      next[name] = fieldValue;
    }
    onChange(Object.keys(next).length ? JSON.stringify(next, null, 2) : '{}');
  };

  const renderField = (name: string, schema: PropertySchema) => {
    const type = schemaType(schema);
    const isRequired = required.has(name);
    const label = name;
    const description = schema.description;
    const current = args?.[name];

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return (
        <Select
          key={name}
          label={label}
          description={description}
          required={isRequired}
          clearable={!isRequired}
          searchable
          data={schema.enum.map((e) => String(e))}
          value={current !== undefined ? String(current) : null}
          placeholder={schema.default !== undefined ? `default: ${String(schema.default)}` : undefined}
          onChange={(v) => setField(name, v ?? undefined)}
        />
      );
    }

    if (type === 'boolean') {
      return (
        <Checkbox
          key={name}
          label={label}
          description={description}
          checked={current === true}
          indeterminate={current === undefined}
          onChange={(e) => setField(name, e.currentTarget.checked)}
        />
      );
    }

    if (type === 'number' || type === 'integer') {
      return (
        <NumberInput
          key={name}
          label={label}
          description={description}
          required={isRequired}
          allowDecimal={type === 'number'}
          value={typeof current === 'number' ? current : ''}
          placeholder={schema.default !== undefined ? `default: ${String(schema.default)}` : undefined}
          onChange={(v) => setField(name, typeof v === 'number' ? v : undefined)}
        />
      );
    }

    if (type === 'array' || type === 'object') {
      return (
        <JsonInput
          key={name}
          label={`${label} (${type})`}
          description={description}
          required={isRequired}
          placeholder={type === 'array' ? '[]' : '{}'}
          minRows={2}
          maxRows={8}
          autosize
          formatOnBlur
          value={current !== undefined ? JSON.stringify(current, null, 2) : ''}
          onChange={(v) => {
            if (!v.trim()) {
              setField(name, undefined);
              return;
            }
            try {
              setField(name, JSON.parse(v));
            } catch {
              // Keep typing; the value lands once it parses. Invalid partial
              // input is visible in the field itself.
            }
          }}
        />
      );
    }

    // string (default)
    return (
      <Textarea
        key={name}
        label={label}
        description={description}
        required={isRequired}
        autosize
        minRows={1}
        maxRows={6}
        value={typeof current === 'string' ? current : current !== undefined ? String(current) : ''}
        placeholder={schema.default !== undefined ? `default: ${String(schema.default)}` : undefined}
        onChange={(e) => setField(name, e.currentTarget.value)}
      />
    );
  };

  return (
    <Stack gap="sm">
      <SegmentedControl
        size="xs"
        value={mode}
        onChange={(v) => setMode(v as 'form' | 'json')}
        data={[
          {
            value: 'form',
            label: (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <IconForms size={13} /> Form
              </span>
            ),
            disabled: !hasFormFields,
          },
          {
            value: 'json',
            label: (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <IconBraces size={13} /> JSON
              </span>
            ),
          },
        ]}
      />

      {mode === 'form' ? (
        parseError ? (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
            <Text size="sm">
              The current JSON arguments are invalid — switch to JSON mode to fix them,
              or clear them to start over.
            </Text>
          </Alert>
        ) : (
          <Stack gap="sm">
            {Object.entries(properties).map(([name, schema]) => renderField(name, schema))}
          </Stack>
        )
      ) : (
        <JsonInput
          description="Arguments passed to the tool as a JSON object."
          placeholder="{}"
          minRows={5}
          maxRows={14}
          autosize
          formatOnBlur
          error={parseError ?? undefined}
          value={value}
          onChange={onChange}
        />
      )}
    </Stack>
  );
}
