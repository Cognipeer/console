'use client';

/**
 * Prompt variables: the values that fill a prompt's `{{placeholders}}`.
 *
 * The editor reads the actual template and lists what it asks for, rather than
 * making the operator remember. That is the whole point — the bug this replaces
 * was invisible precisely because a hollow prompt renders without complaint.
 */

import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Code, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconPlus, IconTrash, IconWand } from '@tabler/icons-react';

const BUILT_INS = ['agent', 'now', 'user'];

export interface PromptVariablesEditorProps {
    value: Record<string, string> | undefined;
    onChange: (next: Record<string, string> | undefined) => void;
    /** The resolved prompt text, so the editor can list what it references. */
    template?: string;
    disabled?: boolean;
}

/** Top-level names a Mustache template references. Mirrors the server helper. */
function templateVariables(template: string): string[] {
    const names = new Set<string>();
    const pattern = /\{\{\s*[#^&]?\s*([A-Za-z0-9_][A-Za-z0-9_.]*)\s*\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(template)) !== null) {
        names.add(match[1].split('.')[0]);
    }
    return [...names];
}

export default function PromptVariablesEditor({
    value,
    onChange,
    template = '',
    disabled,
}: PromptVariablesEditorProps) {
    // Rows are local, not derived: a half-typed row has an empty name, and an
    // empty name cannot survive a round trip through the config object. Only
    // named rows are published upward.
    const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries(value ?? {}));

    // Re-seed only when the agent underneath changes (a fresh load or a version
    // switch), never on our own echo — that would reorder rows while typing.
    useEffect(() => {
        setRows((current) => {
            const publishedNames = current.filter(([key]) => key.trim()).map(([key]) => key.trim()).sort();
            const incomingNames = Object.keys(value ?? {}).sort();
            if (publishedNames.join('\u0000') === incomingNames.join('\u0000')) return current;
            return Object.entries(value ?? {});
        });
    }, [value]);

    const referenced = useMemo(() => templateVariables(template), [template]);
    const entries = rows;

    const declared = new Set(rows.map(([key]) => key.trim()).filter(Boolean));
    const missing = referenced.filter((name) => !BUILT_INS.includes(name) && !declared.has(name));
    const unused = rows
        .filter(([key]) => key.trim() && referenced.length > 0 && !referenced.includes(key.trim()))
        .map(([key]) => key);

    const commit = (next: Array<[string, string]>) => {
        setRows(next);
        const map: Record<string, string> = {};
        for (const [key, val] of next) {
            const trimmed = key.trim();
            if (trimmed) map[trimmed] = val;
        }
        onChange(Object.keys(map).length > 0 ? map : undefined);
    };

    return (
        <Stack gap="sm">
            <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
                <Text size="xs">
                    Values for the <Code>{'{{placeholders}}'}</Code> in this agent&apos;s prompt. A caller can
                    override any of them per run through <Code>runtimeContext.metadata</Code>.{' '}
                    <Code>agent</Code>, <Code>now</Code> and <Code>user</Code> are provided automatically and
                    cannot be overridden.
                </Text>
            </Alert>

            {missing.length > 0 ? (
                <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />}>
                    <Group gap="xs" align="center">
                        <Text size="xs">
                            The prompt references {missing.length} variable{missing.length === 1 ? '' : 's'} with no
                            value — {missing.length === 1 ? 'it renders' : 'they render'} empty:
                        </Text>
                        {missing.map((name) => (
                            <Badge key={name} size="xs" color="yellow" variant="light">{name}</Badge>
                        ))}
                        <Button
                            size="compact-xs"
                            variant="subtle"
                            leftSection={<IconWand size={12} />}
                            disabled={disabled}
                            onClick={() => commit([...entries, ...missing.map((name) => [name, ''] as [string, string])])}
                        >
                            Add them
                        </Button>
                    </Group>
                </Alert>
            ) : null}

            {entries.length === 0 ? (
                <Text size="xs" c="dimmed">No variables declared.</Text>
            ) : (
                <Stack gap="xs">
                    {entries.map(([key, val], index) => (
                        <Group key={`${index}-${key}`} gap="xs" align="flex-start" wrap="nowrap">
                            <TextInput
                                placeholder="name"
                                value={key}
                                w={200}
                                disabled={disabled}
                                error={BUILT_INS.includes(key) ? 'reserved' : undefined}
                                onChange={(event) => {
                                    const next = [...entries] as Array<[string, string]>;
                                    next[index] = [event.currentTarget.value, val];
                                    commit(next);
                                }}
                            />
                            <TextInput
                                placeholder="default value"
                                value={val}
                                style={{ flex: 1 }}
                                disabled={disabled}
                                onChange={(event) => {
                                    const next = [...entries] as Array<[string, string]>;
                                    next[index] = [key, event.currentTarget.value];
                                    commit(next);
                                }}
                            />
                            <Tooltip label={unused.includes(key) ? 'Not referenced by the prompt' : 'Remove'}>
                                <ActionIcon
                                    variant="subtle"
                                    color={unused.includes(key) ? 'yellow' : 'red'}
                                    mt={4}
                                    disabled={disabled}
                                    onClick={() => commit(entries.filter((_, i) => i !== index) as Array<[string, string]>)}
                                >
                                    <IconTrash size={14} />
                                </ActionIcon>
                            </Tooltip>
                        </Group>
                    ))}
                </Stack>
            )}

            <Group>
                <Button
                    size="compact-xs"
                    variant="default"
                    leftSection={<IconPlus size={12} />}
                    disabled={disabled}
                    onClick={() => commit([...entries, ['', '']] as Array<[string, string]>)}
                >
                    Add variable
                </Button>
            </Group>
        </Stack>
    );
}
