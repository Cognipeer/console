'use client';

/**
 * Structured output: the JSON Schema the agent's final answer must satisfy.
 *
 * The editor keeps the raw text the operator typed, not the parsed object. A
 * schema mid-edit is almost always invalid JSON, and re-serializing on every
 * keystroke would fight the cursor. Parsing happens on change for validation
 * and on save for persistence; the text is the source of truth in between.
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Code, Group, JsonInput, Stack, Switch, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconWand } from '@tabler/icons-react';

import type { IAgentStructuredOutput } from '@/lib/database/provider/types.domain';

export interface AgentStructuredOutputEditorProps {
    value: IAgentStructuredOutput | undefined;
    onChange: (next: IAgentStructuredOutput | undefined) => void;
}

const STARTER_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string', description: 'One-paragraph answer' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        sources: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary'],
};

export default function AgentStructuredOutputEditor({
    value,
    onChange,
}: AgentStructuredOutputEditorProps) {
    const enabled = value?.enabled ?? false;
    const [text, setText] = useState(() => (value?.schema ? JSON.stringify(value.schema, null, 2) : ''));

    // Re-seed only when the agent itself changes underneath us (a version load,
    // a discard). Typing must never be overwritten by the parent's echo.
    useEffect(() => {
        if (!value?.schema) return;
        setText((current) => (current.trim() === '' ? JSON.stringify(value.schema, null, 2) : current));
    }, [value?.schema]);

    const parsed = useMemo(() => {
        if (!text.trim()) return { ok: false as const, error: 'Schema is empty' };
        try {
            const json = JSON.parse(text);
            if (!json || typeof json !== 'object') return { ok: false as const, error: 'Schema must be an object' };
            if (json.type !== 'object') {
                return { ok: false as const, error: 'The top level must be `"type": "object"` — providers reject a bare scalar contract' };
            }
            return { ok: true as const, schema: json as Record<string, unknown> };
        } catch (error) {
            return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
    }, [text]);

    const propertyCount = parsed.ok
        ? Object.keys((parsed.schema.properties as Record<string, unknown>) ?? {}).length
        : 0;

    const commit = (next: Partial<IAgentStructuredOutput>) => {
        const merged: IAgentStructuredOutput = { ...(value ?? {}), ...next };
        if (parsed.ok) merged.schema = parsed.schema;
        onChange(merged);
    };

    return (
        <Stack gap="md">
            <Switch
                label="Force a JSON answer"
                description="The agent's final answer is parsed against this schema. Free-text answers stop being possible."
                checked={enabled}
                onChange={(event) => commit({ enabled: event.currentTarget.checked })}
            />

            <TextInput
                label="Schema name"
                description="Surfaced to the provider. Defaults to `<agent key>_output`."
                placeholder="incident_triage_result"
                value={value?.name ?? ''}
                onChange={(event) => commit({ name: event.currentTarget.value || undefined })}
                disabled={!enabled}
            />

            <Switch
                label="Strict"
                description="Every declared property becomes required and unknown keys are rejected. Match this to what your provider's strict JSON mode expects."
                checked={value?.strict ?? false}
                onChange={(event) => commit({ strict: event.currentTarget.checked })}
                disabled={!enabled}
            />

            <Stack gap="xs">
                <Group justify="space-between">
                    <Group gap="xs">
                        <Text size="sm" fw={600}>JSON Schema</Text>
                        {parsed.ok ? (
                            <Badge size="xs" color="teal" variant="light" leftSection={<IconCheck size={10} />}>
                                {propertyCount} propert{propertyCount === 1 ? 'y' : 'ies'}
                            </Badge>
                        ) : text.trim() ? (
                            <Badge size="xs" color="red" variant="light" leftSection={<IconAlertTriangle size={10} />}>
                                invalid
                            </Badge>
                        ) : null}
                    </Group>
                    <Button
                        size="compact-xs"
                        variant="subtle"
                        leftSection={<IconWand size={12} />}
                        disabled={!enabled}
                        onClick={() => {
                            const seeded = JSON.stringify(STARTER_SCHEMA, null, 2);
                            setText(seeded);
                            onChange({ ...(value ?? {}), enabled: true, schema: STARTER_SCHEMA });
                        }}
                    >
                        Insert starter schema
                    </Button>
                </Group>

                <JsonInput
                    value={text}
                    onChange={(next) => {
                        setText(next);
                        try {
                            const json = JSON.parse(next);
                            onChange({ ...(value ?? {}), schema: json });
                        } catch {
                            // Mid-edit text is expected to be unparseable. The last
                            // valid object stays on the config until it parses again,
                            // so a save during editing cannot persist broken JSON.
                        }
                    }}
                    autosize
                    minRows={10}
                    maxRows={24}
                    formatOnBlur
                    validationError={null}
                    disabled={!enabled}
                    styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
                />

                {!parsed.ok && text.trim() ? (
                    <Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />}>
                        <Text size="xs">{parsed.error}</Text>
                    </Alert>
                ) : null}
            </Stack>

            {enabled ? (
                <Alert variant="light" color="blue">
                    <Text size="xs">
                        A structured agent returns <Code>output</Code> alongside <Code>content</Code>. Tools that
                        expect prose from this agent — including a parent agent delegating to it — will see JSON.
                    </Text>
                </Alert>
            ) : null}
        </Stack>
    );
}
