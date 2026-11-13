'use client';

import { useState } from 'react';
import { Badge, Button, Group, Menu, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconTemplate } from '@tabler/icons-react';
import {
  readAppliedMcpGuardrail,
  readMcpGuardrailTemplates,
  type McpGuardrailOption,
  type McpGuardrailTemplate,
} from './mcpGuardrailOptions';

interface McpGuardrailTemplateMenuProps {
  /** Called with the guardrail the template created; the caller selects it for the server. */
  onCreated: (guardrail: McpGuardrailOption) => void;
  disabled?: boolean;
}

/**
 * Create a guardrail for an MCP server from one of the guardrail templates
 * meant for MCP servers, without leaving the MCP screen. Like every template,
 * the guardrail starts in monitor mode and is edited under Guardrails.
 */
export default function McpGuardrailTemplateMenu({ onCreated, disabled }: McpGuardrailTemplateMenuProps) {
  const [templates, setTemplates] = useState<McpGuardrailTemplate[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [applying, setApplying] = useState(false);

  const load = () => {
    if (templates !== null) return;
    fetch('/api/guardrails/templates')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Request failed (${res.status})`))))
      .then((data: unknown) => setTemplates(readMcpGuardrailTemplates(data)))
      .catch(() => {
        setLoadFailed(true);
        setTemplates([]);
      });
  };

  const apply = async (template: McpGuardrailTemplate) => {
    setApplying(true);
    try {
      const res = await fetch(`/api/guardrails/templates/${encodeURIComponent(template.key)}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data: unknown = await res.json().catch(() => ({}));
      const created = res.ok ? readAppliedMcpGuardrail(data) : undefined;
      if (!created) {
        const error = (data as { error?: unknown } | null)?.error;
        throw new Error(typeof error === 'string' && error ? error : `Request failed (${res.status})`);
      }
      onCreated(created);
      notifications.show({
        color: 'green',
        title: 'Guardrail created',
        message: `“${created.name}” was created in monitor mode and selected. Switch it to enforce under Guardrails once its findings look right.`,
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Could not create the guardrail',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <Menu position="bottom-end" width={380} onOpen={load} withinPortal>
      <Menu.Target>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconTemplate size={14} />}
          loading={applying}
          disabled={disabled}
        >
          From a template
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Create a guardrail from a template</Menu.Label>
        {templates === null ? (
          <Text size="xs" c="dimmed" px="sm" py={6}>Loading templates…</Text>
        ) : null}
        {templates !== null && templates.length === 0 ? (
          <Text size="xs" c="dimmed" px="sm" py={6}>
            {loadFailed ? 'Templates could not be loaded.' : 'No template is meant for MCP servers.'}
          </Text>
        ) : null}
        {(templates ?? []).map((template) => (
          <Menu.Item key={template.key} disabled={applying} onClick={() => void apply(template)}>
            <Group gap={6} wrap="nowrap">
              <Text size="sm" fw={500}>{template.name}</Text>
              {template.recommended ? <Badge size="xs" variant="light">recommended</Badge> : null}
            </Group>
            <Text size="xs" c="dimmed" lineClamp={3}>{template.description}</Text>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
