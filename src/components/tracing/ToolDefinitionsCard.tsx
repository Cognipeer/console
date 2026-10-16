'use client';

/**
 * The tool menu a model call was offered, shown first in the call's sections:
 * collapsed to "Tool definitions · N", opening to one row per tool (name and
 * the first line of its description), and a row opening to that tool's
 * parameters. The raw schema stays one click further down.
 *
 * Reads every integration's shape: agent-sdk and OpenAI-style `parameters`,
 * MCP-style `inputSchema`, Anthropic-style `input_schema`, and a nested
 * `function: { name, description, parameters }`.
 */

import { useState } from 'react';
import { Badge, Box, Collapse, Group, Paper, Stack, Table, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconTool } from '@tabler/icons-react';
import JsonTreeViewer from '@/components/common/JsonTreeViewer';

export interface ToolDefinitionEntry {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
}

interface ParameterRow {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Normalizes one entry of a `tool_definitions` section, or undefined when it names no tool. */
export function readToolDefinition(raw: unknown): ToolDefinitionEntry | undefined {
  const entry = record(raw);
  if (!entry) return undefined;
  const fn = record(entry.function);
  const name = typeof entry.name === 'string' ? entry.name : typeof fn?.name === 'string' ? fn.name : undefined;
  if (!name) return undefined;
  const description = typeof entry.description === 'string'
    ? entry.description
    : typeof fn?.description === 'string' ? fn.description : undefined;
  const schema = record(entry.parameters) ?? record(entry.inputSchema) ?? record(entry.input_schema)
    ?? record(entry.schema) ?? record(fn?.parameters);
  return { name, description, schema };
}

export function readToolDefinitions(section: Record<string, unknown>): ToolDefinitionEntry[] {
  const tools = Array.isArray(section.tools) ? section.tools : Array.isArray(section.content) ? section.content : [];
  return tools.map(readToolDefinition).filter((entry): entry is ToolDefinitionEntry => Boolean(entry));
}

function typeLabel(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'any';
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  const type = schema.type;
  if (Array.isArray(type)) return type.join(' | ');
  if (type === 'array') return `${typeLabel(record(schema.items))}[]`;
  if (typeof type === 'string') return type;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((option) => typeLabel(record(option))).join(' | ');
  return 'any';
}

function parameterRows(schema: Record<string, unknown> | undefined): ParameterRow[] {
  const properties = record(schema?.properties);
  if (!properties) return [];
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  return Object.entries(properties).map(([name, value]) => {
    const property = record(value);
    return {
      name,
      type: typeLabel(property),
      required: required.has(name),
      description: typeof property?.description === 'string' ? property.description : undefined,
    };
  });
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text.split('\n').find((part) => part.trim().length > 0)?.trim();
  return line && line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function ToolRow({ tool }: { tool: ToolDefinitionEntry }) {
  const [open, setOpen] = useState(false);
  const rows = parameterRows(tool.schema);
  const [showSchema, setShowSchema] = useState(false);

  return (
    <Box style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
      <UnstyledButton onClick={() => setOpen((value) => !value)} style={{ display: 'block', width: '100%', padding: '8px 4px' }}>
        <Group gap={8} wrap="nowrap" align="flex-start">
          {open ? <IconChevronDown size={14} style={{ marginTop: 3, flexShrink: 0 }} /> : <IconChevronRight size={14} style={{ marginTop: 3, flexShrink: 0 }} />}
          <Box style={{ minWidth: 0, flex: 1 }}>
            <Group gap={6} wrap="nowrap">
              <Text size="sm" fw={600} ff="monospace" lineClamp={1}>{tool.name}</Text>
              {rows.length > 0 ? (
                <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
                  {rows.length} {rows.length === 1 ? 'param' : 'params'}
                </Badge>
              ) : null}
            </Group>
            {!open && firstLine(tool.description) ? (
              <Text size="xs" c="dimmed" lineClamp={1}>{firstLine(tool.description)}</Text>
            ) : null}
          </Box>
        </Group>
      </UnstyledButton>
      <Collapse in={open}>
        <Stack gap="xs" pl={26} pr={4} pb="sm">
          {tool.description ? <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{tool.description}</Text> : null}
          {rows.length > 0 ? (
            <Table verticalSpacing={4} horizontalSpacing="xs" fz="xs" withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Parameter</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Description</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr key={row.name}>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>
                      <Text span size="xs" ff="monospace" fw={600}>{row.name}</Text>
                      {row.required ? <Text span size="xs" c="red"> *</Text> : null}
                    </Table.Td>
                    <Table.Td><Text size="xs" ff="monospace" c="dimmed">{row.type}</Text></Table.Td>
                    <Table.Td><Text size="xs">{row.description ?? '—'}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Text size="xs" c="dimmed">No parameters.</Text>
          )}
          {tool.schema ? (
            <>
              <UnstyledButton onClick={() => setShowSchema((value) => !value)}>
                <Text size="xs" c="blue">{showSchema ? 'Hide raw schema' : 'Show raw schema'}</Text>
              </UnstyledButton>
              {showSchema ? <JsonTreeViewer data={tool.schema} initialExpandLevel={2} /> : null}
            </>
          ) : null}
        </Stack>
      </Collapse>
    </Box>
  );
}

export default function ToolDefinitionsCard({ tools, defaultOpen = false }: { tools: ToolDefinitionEntry[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (tools.length === 0) return null;

  return (
    <Paper withBorder radius="md" px="sm" py={6}>
      <UnstyledButton onClick={() => setOpen((value) => !value)} style={{ display: 'block', width: '100%', padding: '4px 0' }}>
        <Group gap={8} wrap="nowrap">
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <IconTool size={14} color="var(--mantine-color-indigo-6)" />
          <Text size="sm" fw={600}>Tool definitions</Text>
          <Badge size="sm" variant="light" color="indigo">{tools.length}</Badge>
          {!open ? (
            <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>
              {tools.map((tool) => tool.name).join(', ')}
            </Text>
          ) : null}
        </Group>
      </UnstyledButton>
      <Collapse in={open}>
        <Box mt={4}>
          {tools.map((tool, index) => <ToolRow key={`${tool.name}-${index}`} tool={tool} />)}
        </Box>
      </Collapse>
    </Paper>
  );
}
