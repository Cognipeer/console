'use client';

/**
 * Collapsible JSON editor for the per-invocation runtime context — the
 * caller-supplied downstream auth/data bundle (headers, connections,
 * metadata). Used by the playground/test surfaces so the same JSON external
 * systems send via `runtime_context` can be exercised from the dashboard.
 *
 * The parent owns the raw JSON string; `parseRuntimeContextJson` turns it
 * into the request-body value (undefined for empty/invalid input).
 */

import { useState } from 'react';
import { Badge, Collapse, Group, JsonInput, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconKey } from '@tabler/icons-react';

const PLACEHOLDER = `{
  "headers": { "Authorization": "Bearer <caller-token>" },
  "connections": {
    "tool:crm": { "headers": { "X-Api-Key": "<key>" } }
  },
  "metadata": { "externalUserId": "u-42" }
}`;

/** Parse the editor value into a request-body payload. Empty/invalid → undefined. */
export function parseRuntimeContextJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

interface RuntimeContextEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Extra hint appended below the default description (e.g. session.update semantics). */
  hint?: string;
}

export default function RuntimeContextEditor({ value, onChange, hint }: RuntimeContextEditorProps) {
  const [open, setOpen] = useState(false);
  const active = parseRuntimeContextJson(value) !== undefined;
  const invalid = value.trim().length > 0 && !active;

  return (
    <div>
      <UnstyledButton onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Group gap={6} align="center">
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <IconKey size={14} />
          <Text size="sm" fw={500}>Runtime Context</Text>
          {active ? (
            <Badge size="xs" variant="outline" color="orange">active</Badge>
          ) : null}
          {invalid ? (
            <Badge size="xs" variant="outline" color="red">invalid JSON</Badge>
          ) : null}
        </Group>
      </UnstyledButton>
      <Collapse in={open}>
        <Text size="xs" c="dimmed" mt={4} mb={6}>
          Sent as <code>runtime_context</code> with each call — downstream headers pass only to
          targets that opted in via their &quot;Runtime Headers&quot; policy.
          {hint ? ` ${hint}` : ''}
        </Text>
        <JsonInput
          value={value}
          onChange={onChange}
          placeholder={PLACEHOLDER}
          validationError="Invalid JSON"
          formatOnBlur
          autosize
          minRows={4}
          maxRows={14}
        />
      </Collapse>
    </div>
  );
}
