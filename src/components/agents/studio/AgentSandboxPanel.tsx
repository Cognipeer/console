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
import {
    ActionIcon,
    Alert,
    Anchor,
    Button,
    Checkbox,
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
    disabled?: boolean;
}

type Row = { id: number; key: string; value: string };
let rowSeq = 0;
const toRows = (map: Record<string, string> | undefined): Row[] =>
    Object.entries(map ?? {}).map(([key, value]) => ({ id: ++rowSeq, key, value }));
const toMap = (rows: Row[]): Record<string, string> | undefined => {
    const entries = rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value] as const);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

export default function AgentSandboxPanel({ value, onChange, disabled }: AgentSandboxPanelProps) {
    const [capabilities, setCapabilities] = useState<SandboxCapabilities | null>(null);
    const enabled = value?.enabled ?? false;
    const mode: AgentSandboxMode = value?.mode ?? 'ephemeral';
    const tools = { exec: true, code: true, files: true, ...(value?.tools ?? {}) };
    const patch = (next: Partial<IAgentSandboxConfig>) => onChange({ ...(value ?? {}), ...next });

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
                disabled={disabled || (Boolean(unavailable) && capabilities?.reason !== 'unreachable' && !enabled)}
            />

            {enabled ? (
                <>
                    <ConfigBlock title="Machine">
                        <Stack gap="sm">
                            <Select
                                label="Template"
                                description="The image the sandbox starts from. Default: the tenant's default template."
                                placeholder="Default (multi-base)"
                                data={(capabilities?.templates ?? []).map((template) => ({
                                    value: template.key,
                                    label: template.description ? `${template.name} — ${template.description}` : template.name,
                                }))}
                                value={value?.templateKey ?? null}
                                onChange={(next) => patch({ templateKey: next ?? undefined })}
                                clearable
                                searchable
                                disabled={disabled}
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
                                    onChange={(next) => patch({
                                        resources: { ...(value?.resources ?? {}), cpuCores: typeof next === 'number' ? next : undefined },
                                    })}
                                    disabled={disabled}
                                />
                                <NumberInput
                                    label="Memory (MB)"
                                    placeholder="Template default"
                                    min={128}
                                    step={256}
                                    value={value?.resources?.memoryMb ?? ''}
                                    onChange={(next) => patch({
                                        resources: { ...(value?.resources ?? {}), memoryMb: typeof next === 'number' ? next : undefined },
                                    })}
                                    disabled={disabled}
                                />
                            </Group>
                            <Switch
                                label="Block network access"
                                description="No internet from inside the sandbox — package installs will fail."
                                checked={value?.blockNetwork ?? false}
                                onChange={(event) => patch({ blockNetwork: event.currentTarget.checked })}
                                disabled={disabled}
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
                                disabled={disabled}
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
                                    onChange={(next) => patch({ commandTimeoutSec: typeof next === 'number' ? next : undefined })}
                                    disabled={disabled}
                                />
                                {mode === 'persist' ? (
                                    <NumberInput
                                        label="Keep for (hours)"
                                        description="An unused sandbox older than this starts over fresh."
                                        placeholder="24"
                                        min={1}
                                        max={720}
                                        value={value?.retentionHours ?? ''}
                                        onChange={(next) => patch({ retentionHours: typeof next === 'number' ? next : undefined })}
                                        disabled={disabled}
                                    />
                                ) : null}
                            </Group>
                        </Stack>
                    </ConfigBlock>

                    <ConfigBlock title="Tools">
                        <Group gap="lg">
                            <Checkbox
                                label="Run commands (sandbox_exec)"
                                checked={tools.exec}
                                onChange={(event) => patch({ tools: { ...tools, exec: event.currentTarget.checked } })}
                                disabled={disabled}
                            />
                            <Checkbox
                                label="Run code (sandbox_run_code)"
                                checked={tools.code}
                                onChange={(event) => patch({ tools: { ...tools, code: event.currentTarget.checked } })}
                                disabled={disabled}
                            />
                            <Checkbox
                                label="Files (read / write / list)"
                                checked={tools.files}
                                onChange={(event) => patch({ tools: { ...tools, files: event.currentTarget.checked } })}
                                disabled={disabled}
                            />
                        </Group>
                    </ConfigBlock>

                    <ConfigBlock title="Environment variables">
                        <KeyValueEditor
                            value={value?.env}
                            onChange={(env) => patch({ env })}
                            disabled={disabled}
                            addLabel="Add variable"
                        />
                    </ConfigBlock>

                    <ConfigBlock title="Secrets">
                        <Stack gap="xs">
                            <Text size="xs" c="dimmed">
                                Stored encrypted and never shown again. Passed to each command as an environment
                                variable — not stored on the sandbox — and masked in what the tools return to the model.
                            </Text>
                            <KeyValueEditor
                                value={value?.secrets}
                                onChange={(secrets) => patch({ secrets: secrets ?? {} })}
                                disabled={disabled}
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
    disabled,
    addLabel,
    secret = false,
}: {
    value: Record<string, string> | undefined;
    onChange: (next: Record<string, string> | undefined) => void;
    disabled?: boolean;
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

    return (
        <Stack gap={6}>
            {rows.map((row) => (
                <Group key={row.id} gap="xs" wrap="nowrap" align="flex-start">
                    <TextInput
                        placeholder="NAME"
                        value={row.key}
                        onChange={(event) => update(rows.map((r) => (r.id === row.id ? { ...r, key: event.currentTarget.value } : r)))}
                        style={{ flex: 1 }}
                        ff="monospace"
                        disabled={disabled}
                    />
                    {secret ? (
                        <PasswordInput
                            placeholder={row.value === SANDBOX_SECRET_MASK ? 'Stored — type to replace' : 'value'}
                            value={row.value === SANDBOX_SECRET_MASK ? '' : row.value}
                            onChange={(event) => update(rows.map((r) => (r.id === row.id
                                ? { ...r, value: event.currentTarget.value || SANDBOX_SECRET_MASK }
                                : r)))}
                            style={{ flex: 2 }}
                            disabled={disabled}
                        />
                    ) : (
                        <TextInput
                            placeholder="value"
                            value={row.value}
                            onChange={(event) => update(rows.map((r) => (r.id === row.id ? { ...r, value: event.currentTarget.value } : r)))}
                            style={{ flex: 2 }}
                            disabled={disabled}
                        />
                    )}
                    <Tooltip label="Remove" withArrow>
                        <ActionIcon
                            variant="subtle"
                            color="red"
                            mt={4}
                            onClick={() => update(rows.filter((r) => r.id !== row.id))}
                            disabled={disabled}
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
                    onClick={() => update([...rows, { id: ++rowSeq, key: '', value: secret ? '' : '' }])}
                    disabled={disabled}
                >
                    {addLabel}
                </Button>
            </Group>
        </Stack>
    );
}
