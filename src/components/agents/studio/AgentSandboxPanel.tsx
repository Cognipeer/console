'use client';

/**
 * Sandbox — gives the agent an isolated Linux machine (the enterprise Agent
 * Runtime Sandbox module) and the tools to use it: run a command, run code,
 * read/write/list files. See `agentSandboxTools.ts` for the runtime side.
 *
 * Everything here edits `config.sandbox`. Secrets are write-only: the server
 * returns their keys with a masked value, and sending the mask back keeps the
 * stored secret (`agentSandboxSecrets.ts`).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
    ActionIcon,
    Alert,
    Anchor,
    Button,
    Checkbox,
    Code,
    Group,
    NumberInput,
    PasswordInput,
    SegmentedControl,
    Select,
    Stack,
    Switch,
    Text,
    TextInput,
    Tooltip,
} from '@mantine/core';
import { IconInfoCircle, IconLock, IconPlus, IconTrash } from '@tabler/icons-react';
import type { AgentSandboxMode, IAgentSandboxConfig } from '@/lib/database/provider/types.domain';
import { ConfigBlock } from './ConfigSection';

export const SANDBOX_SECRET_MASK = '••••••';

interface SandboxCapabilities {
    available: boolean;
    /** `unreachable`: the capability check itself failed — not the same as "no module". */
    reason?: 'edition' | 'license' | 'unreachable';
    detail?: string;
    templates: Array<{ key: string; name: string; description?: string }>;
}

export interface AgentSandboxPanelProps {
    value: IAgentSandboxConfig | undefined;
    onChange: (next: IAgentSandboxConfig | undefined) => void;
}

type Row = { id: number; key: string; value: string };
let rowSeq = 0;
const toRows = (map: Record<string, string> | undefined): Row[] =>
    Object.entries(map ?? {}).map(([key, value]) => ({ id: ++rowSeq, key, value }));
const toMap = (rows: Row[]): Record<string, string> | undefined => {
    const entries = rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value] as const);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};
/** A cleared NumberInput reports `''` — that means "unset", not 0. */
const optionalNumber = (next: string | number) => (typeof next === 'number' ? next : undefined);

const SANDBOX_TOOLS = [
    ['exec', 'Run commands (sandbox_exec)'],
    ['code', 'Run code (sandbox_run_code)'],
    ['files', 'Files (read / write / list)'],
] as const;

export default function AgentSandboxPanel({ value, onChange }: AgentSandboxPanelProps) {
    const [capabilities, setCapabilities] = useState<SandboxCapabilities | null>(null);
    const enabled = value?.enabled ?? false;
    const mode: AgentSandboxMode = value?.mode ?? 'ephemeral';
    const tools = { exec: true, code: true, files: true, ...(value?.tools ?? {}) };
    const patch = (next: Partial<IAgentSandboxConfig>) => onChange({ ...(value ?? {}), ...next });
    const patchPreview = (next: Partial<NonNullable<IAgentSandboxConfig['preview']>>) =>
        patch({ preview: { ...(value?.preview ?? {}), ...next } });
    const patchResources = (next: Partial<NonNullable<IAgentSandboxConfig['resources']>>) =>
        patch({ resources: { ...(value?.resources ?? {}), ...next } });

    useEffect(() => {
        let cancelled = false;
        // A failed check is reported as a failed check. It used to read as
        // "this edition has no sandbox module", which sent an Enterprise
        // tenant looking for a license problem that was a server error.
        fetch('/api/agents/sandbox/capabilities', { cache: 'no-store' })
            .then(async (res) => {
                if (res.ok) return res.json();
                const body = await res.json().catch(() => ({}));
                return { available: false, reason: 'unreachable', templates: [], detail: body?.error ?? `HTTP ${res.status}` };
            })
            .then((data) => { if (!cancelled) setCapabilities(data); })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setCapabilities({
                        available: false,
                        reason: 'unreachable',
                        templates: [],
                        detail: error instanceof Error ? error.message : 'network error',
                    });
                }
            });
        return () => { cancelled = true; };
    }, []);

    const unavailable = capabilities && !capabilities.available;

    return (
        <Stack gap="md">
            {unavailable ? (
                <Alert
                    variant="light"
                    color={capabilities.reason === 'license' ? 'orange' : capabilities.reason === 'unreachable' ? 'red' : 'gray'}
                    icon={<IconLock size={16} />}
                >
                    <Text size="sm">
                        {capabilities.reason === 'license'
                            ? 'Sandbox access is an Enterprise feature. Activate an Enterprise license to give agents a sandbox.'
                            : capabilities.reason === 'unreachable'
                                ? `Could not check sandbox availability (${capabilities.detail ?? 'unknown error'}). Reload to retry.`
                                : 'This edition has no sandbox module.'}
                        {enabled ? ' The agent runs without its sandbox tools until then.' : ''}
                    </Text>
                </Alert>
            ) : null}

            <Switch
                label="Give this agent a sandbox"
                description="An isolated Linux machine the agent can run commands and code in, and read and write files on. Provisioned only when the agent first uses it."
                checked={enabled}
                onChange={(event) => patch({ enabled: event.currentTarget.checked })}
                disabled={Boolean(unavailable) && capabilities?.reason !== 'unreachable' && !enabled}
            />

            {enabled ? (
                <>
                    <ConfigBlock title="Machine">
                        <Stack gap="sm">
                            {capabilities?.available && capabilities.templates.length === 0 ? (
                                <Alert variant="light" color="orange" icon={<IconInfoCircle size={16} />} p="xs">
                                    <Text size="sm">
                                        No sandbox templates yet. Create one, or add the built-in ones with “Seed defaults”, on the{' '}
                                        <Anchor component={Link} href="/dashboard/sandbox/templates" size="sm">Sandbox templates</Anchor> page.
                                    </Text>
                                </Alert>
                            ) : null}
                            <Select
                                label="Template"
                                description="The image the sandbox starts from."
                                placeholder="Pick a template"
                                withAsterisk
                                error={capabilities?.available && !value?.templateKey ? 'Pick a template — the agent cannot be saved without one.' : undefined}
                                data={(capabilities?.templates ?? []).map((template) => ({
                                    value: template.key,
                                    label: template.description ? `${template.name} — ${template.description}` : template.name,
                                }))}
                                value={value?.templateKey ?? null}
                                onChange={(next) => patch({ templateKey: next ?? undefined })}
                                searchable
                            />
                            <Group grow align="flex-start">
                                <NumberInput
                                    label="CPU cores"
                                    placeholder="Template default"
                                    min={0.25}
                                    max={64}
                                    step={0.5}
                                    decimalScale={2}
                                    value={value?.resources?.cpuCores ?? ''}
                                    onChange={(next) => patchResources({ cpuCores: optionalNumber(next) })}
                                />
                                <NumberInput
                                    label="Memory (MB)"
                                    placeholder="Template default"
                                    min={128}
                                    step={256}
                                    value={value?.resources?.memoryMb ?? ''}
                                    onChange={(next) => patchResources({ memoryMb: optionalNumber(next) })}
                                />
                            </Group>
                            <Switch
                                label="Block network access"
                                description="No internet from inside the sandbox — package installs will fail."
                                checked={value?.blockNetwork ?? false}
                                onChange={(event) => patch({ blockNetwork: event.currentTarget.checked })}
                            />
                        </Stack>
                    </ConfigBlock>

                    <ConfigBlock title="Lifetime">
                        <Stack gap="sm">
                            <SegmentedControl
                                value={mode}
                                onChange={(next) => patch({ mode: next as AgentSandboxMode })}
                                data={[
                                    { value: 'ephemeral', label: 'Ephemeral' },
                                    { value: 'persist', label: 'Persistent' },
                                ]}
                            />
                            <Text size="xs" c="dimmed">
                                {mode === 'ephemeral'
                                    ? 'A fresh sandbox for every reply, deleted when the reply is done. Nothing carries over between turns.'
                                    : 'One sandbox per conversation. Files and installed packages carry over between turns; the machine is stopped between turns and deleted with the conversation. A call without a conversation still gets a throwaway sandbox.'}
                            </Text>
                            <Group grow align="flex-start">
                                <NumberInput
                                    label="Command timeout (seconds)"
                                    description="Per command. Max 600."
                                    placeholder="60"
                                    min={1}
                                    max={600}
                                    value={value?.commandTimeoutSec ?? ''}
                                    onChange={(next) => patch({ commandTimeoutSec: optionalNumber(next) })}
                                />
                                {mode === 'persist' ? (
                                    <NumberInput
                                        label="Keep for (hours)"
                                        description="An unused sandbox older than this starts over fresh."
                                        placeholder="24"
                                        min={1}
                                        max={720}
                                        value={value?.retentionHours ?? ''}
                                        onChange={(next) => patch({ retentionHours: optionalNumber(next) })}
                                    />
                                ) : null}
                            </Group>
                        </Stack>
                    </ConfigBlock>

                    <ConfigBlock title="Preview">
                        <Stack gap="sm">
                            <Switch
                                label="Allow preview links"
                                description="The agent can serve something from the sandbox — a web app, a report, a dashboard on a port — and give the user a link to it (sandbox_preview_link)."
                                checked={value?.preview?.enabled ?? false}
                                onChange={(event) => patchPreview({ enabled: event.currentTarget.checked })}
                            />
                            {value?.preview?.enabled ? (
                                <>
                                    <Switch
                                        label="Public links"
                                        description="Anyone who has the link can open it, without signing in, until it expires. Off: links open only for signed-in console users with sandbox access. Public links need SANDBOX_PREVIEW_SECRET on the server; without it the agent gets a private link and is told why."
                                        checked={value.preview.public ?? false}
                                        onChange={(event) => patchPreview({ public: event.currentTarget.checked })}
                                    />
                                    <Group grow align="flex-start">
                                        {value.preview.public ? (
                                            <NumberInput
                                                label="Link valid for (hours)"
                                                description="Max 168 (7 days)."
                                                placeholder="24"
                                                min={1}
                                                max={168}
                                                value={value.preview.linkTtlHours ?? ''}
                                                onChange={(next) => patchPreview({ linkTtlHours: optionalNumber(next) })}
                                            />
                                        ) : null}
                                        <NumberInput
                                            label="Keep running while idle (minutes)"
                                            description="A machine with a live preview is not stopped when the reply ends; it stops after this long without activity."
                                            placeholder="30"
                                            min={5}
                                            max={1440}
                                            value={value.preview.keepAliveMinutes ?? ''}
                                            onChange={(next) => patchPreview({ keepAliveMinutes: optionalNumber(next) })}
                                        />
                                    </Group>
                                    {value.blockNetwork ? (
                                        <Text size="xs" c="orange.7">Preview links do not work while the network is blocked.</Text>
                                    ) : null}
                                </>
                            ) : null}
                        </Stack>
                    </ConfigBlock>

                    <ConfigBlock title="Tools">
                        <Group gap="lg">
                            {SANDBOX_TOOLS.map(([tool, label]) => (
                                <Checkbox
                                    key={tool}
                                    label={label}
                                    checked={tools[tool]}
                                    onChange={(event) => patch({ tools: { ...tools, [tool]: event.currentTarget.checked } })}
                                />
                            ))}
                        </Group>
                    </ConfigBlock>

                    <ConfigBlock title="Environment variables">
                        <Stack gap="xs">
                            <Text size="xs" c="dimmed">
                                For non-sensitive settings — <Code>APP_ENV</Code>, <Code>LOG_LEVEL</Code>, a region.
                                Stored in plain text, visible here and in the API, and set on the sandbox machine
                                itself, so every command and process sees them. The agent is not told their names;
                                it can list them with <Code>env</Code>, and their values appear unmasked in anything it prints.
                            </Text>
                            <KeyValueEditor
                                value={value?.env}
                                onChange={(env) => patch({ env })}
                                addLabel="Add variable"
                            />
                        </Stack>
                    </ConfigBlock>

                    <ConfigBlock title="Secrets">
                        <Stack gap="xs">
                            <Text size="xs" c="dimmed">
                                For API keys, tokens and passwords. Stored encrypted and never shown again — here and
                                in the API only the name is visible; leave a field empty to keep the stored value,
                                type to replace it. Not set on the sandbox machine: each <Code>sandbox_exec</Code> /
                                {' '}<Code>sandbox_run_code</Code> call gets them as environment variables for that
                                command only. The agent is told the names (so it can write <Code>$API_TOKEN</Code>)
                                but never the values, and any value that shows up in command output or a file it
                                reads is replaced with <Code>••••••</Code> before the model sees it.
                            </Text>
                            <Alert variant="light" color="yellow" p="xs" icon={<IconInfoCircle size={14} />}>
                                <Text size="xs">
                                    Masking catches the value as written, not transformed (base64, split, a few
                                    characters at a time), and cannot stop a script from sending it over the
                                    network. For sensitive keys, block network access above, use short-lived
                                    least-privilege keys, or add a <Code>tool.pre</Code> guardrail on
                                    {' '}<Code>agent.sandbox.*</Code>.
                                </Text>
                            </Alert>
                            <KeyValueEditor
                                value={value?.secrets}
                                onChange={(secrets) => patch({ secrets: secrets ?? {} })}
                                addLabel="Add secret"
                                secret
                            />
                        </Stack>
                    </ConfigBlock>

                    <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
                        <Text size="xs">
                            Sandboxes run on the Agent Runtime Sandbox module — templates and usage are under{' '}
                            <Anchor href="/dashboard/sandbox" target="_blank" size="xs">Sandbox</Anchor>.
                        </Text>
                    </Alert>
                </>
            ) : null}
        </Stack>
    );
}

function KeyValueEditor({
    value,
    onChange,
    addLabel,
    secret = false,
}: {
    value: Record<string, string> | undefined;
    onChange: (next: Record<string, string> | undefined) => void;
    addLabel: string;
    secret?: boolean;
}) {
    const [rows, setRows] = useState<Row[]>(() => toRows(value));

    // Re-seed when the stored value changes from outside (agent reload/save).
    const serialized = JSON.stringify(value ?? {});
    useEffect(() => {
        setRows((current) => (JSON.stringify(toMap(current) ?? {}) === serialized ? current : toRows(value)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serialized]);

    const update = (next: Row[]) => {
        setRows(next);
        onChange(toMap(next));
    };
    const setRow = (id: number, next: Partial<Row>) => update(rows.map((r) => (r.id === id ? { ...r, ...next } : r)));

    return (
        <Stack gap={6}>
            {rows.map((row) => (
                <Group key={row.id} gap="xs" wrap="nowrap" align="flex-start">
                    <TextInput
                        placeholder="NAME"
                        value={row.key}
                        onChange={(event) => setRow(row.id, { key: event.currentTarget.value })}
                        style={{ flex: 1 }}
                        ff="monospace"
                    />
                    {secret ? (
                        <PasswordInput
                            placeholder={row.value === SANDBOX_SECRET_MASK ? 'Stored — type to replace' : 'value'}
                            value={row.value === SANDBOX_SECRET_MASK ? '' : row.value}
                            onChange={(event) => setRow(row.id, { value: event.currentTarget.value || SANDBOX_SECRET_MASK })}
                            style={{ flex: 2 }}
                        />
                    ) : (
                        <TextInput
                            placeholder="value"
                            value={row.value}
                            onChange={(event) => setRow(row.id, { value: event.currentTarget.value })}
                            style={{ flex: 2 }}
                        />
                    )}
                    <Tooltip label="Remove" withArrow>
                        <ActionIcon
                            variant="subtle"
                            color="red"
                            mt={4}
                            onClick={() => update(rows.filter((r) => r.id !== row.id))}
                            aria-label="Remove"
                        >
                            <IconTrash size={14} />
                        </ActionIcon>
                    </Tooltip>
                </Group>
            ))}
            <Group>
                <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconPlus size={12} />}
                    onClick={() => update([...rows, { id: ++rowSeq, key: '', value: '' }])}
                >
                    {addLabel}
                </Button>
            </Group>
        </Stack>
    );
}
