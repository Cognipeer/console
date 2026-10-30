'use client';

/**
 * Sandbox — gives the agent an isolated Linux machine (the enterprise Agent
 * Runtime Sandbox module) and the tools to use it: run a command, run code,
 * read/write/list files. See `agentSandboxTools.ts` for the runtime side.
 *
 * Everything here edits `config.sandbox`. Secrets are write-only: the server
 * returns their keys with a masked value, and sending the mask back keeps the
 * stored secret (`agentSandboxSecrets.ts`). When the stored secrets cannot be
 * decrypted the list is empty and `secretsUnreadable` is set: the panel warns,
 * and entering values again replaces them.
 */

import { useEffect, useRef, useState } from 'react';
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
import { IconAlertTriangle, IconInfoCircle, IconLock, IconPlus, IconTrash } from '@tabler/icons-react';
import type { IAgentSandboxConfig } from '@/lib/database/provider/types.domain';
import { envNameFromConfigKey, type IConfigGroupRef, type IConfigValueRef } from '@/lib/config/configRefShared';
import AddFromConfigPopover from '@/components/config/refs/AddFromConfigPopover';
import BoundGroupsList from '@/components/config/refs/BoundGroupsList';
import ConfigItemPicker, { CONFIG_FORBIDDEN_HINT } from '@/components/config/refs/ConfigItemPicker';
import {
    addGroupRefs, nameProblem, nameProblemText, nextRowId, rowsForPickedItems, rowsFromMaps, rowsToMaps, serializeMaps,
    switchRowSource, usedNames, type EditorRow,
} from '@/components/config/refs/refRows';
import { useConfigCatalog, type ConfigCatalog, type ConfigCatalogGroup } from '@/components/config/refs/useConfigCatalog';
import { resolveSandboxMode, type ResolvedSandboxMode } from '@/lib/services/agents/agentSandboxMode';
import { ConfigBlock } from './ConfigSection';
import SandboxSeedFiles from './SandboxSeedFiles';
import { useTranslations } from '@/lib/i18n';

export const SANDBOX_SECRET_MASK = '••••••';

interface SandboxCapabilities {
    available: boolean;
    /** `unreachable`: the capability check itself failed — not the same as "no module". */
    reason?: 'edition' | 'license' | 'unreachable';
    detail?: string;
    templates: Array<{ key: string; name: string; description?: string }>;
    /** The project's persistent sandboxes (empty without Sandbox read access). */
    instances?: Array<{ id: string; name: string; state: string; templateKey?: string }>;
    /** May this user choose a persistent sandbox (Sandbox write)? */
    canAttach?: boolean;
}

export interface AgentSandboxPanelProps {
    value: IAgentSandboxConfig | undefined;
    onChange: (next: IAgentSandboxConfig | undefined) => void;
    /** Needed to upload preloaded files. */
    agentId?: string;
}

/** A cleared NumberInput reports `''` — that means "unset", not 0. */
const optionalNumber = (next: string | number) => (typeof next === 'number' ? next : undefined);

const SANDBOX_TOOLS = [
    ['exec', 'Run commands (sandbox_exec)'],
    ['code', 'Run code (sandbox_run_code)'],
    ['files', 'Files (read / write / list)'],
] as const;

export default function AgentSandboxPanel({ value, onChange, agentId }: AgentSandboxPanelProps) {
    const tSeed = useTranslations('agents.sandboxSeed');
    const tSecrets = useTranslations('agents.sandboxSecrets');
    const [capabilities, setCapabilities] = useState<SandboxCapabilities | null>(null);
    const enabled = value?.enabled ?? false;
    const catalog = useConfigCatalog(enabled);
    const mode = resolveSandboxMode(value?.mode);
    const tools = { exec: true, code: true, files: true, ...(value?.tools ?? {}) };
    // Patches made in one event (Add from Config adds rows and binds groups at once) build on each other, not
    // each on the value this render got — the parent keeps only the last one it is handed.
    const pending = useRef<{ base: IAgentSandboxConfig | undefined; merged: IAgentSandboxConfig } | null>(null);
    const patch = (next: Partial<IAgentSandboxConfig>) => {
        const base = pending.current && pending.current.base === value ? pending.current.merged : value;
        const merged = { ...(base ?? {}), ...next };
        pending.current = { base: value, merged };
        onChange(merged);
    };
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
    const attached = mode === 'instance';
    const instanceOptions = (capabilities?.instances ?? []).map((instance) => ({
        value: instance.id,
        label: `${instance.name} (${instance.state})`,
    }));
    if (value?.instanceId && !instanceOptions.some((option) => option.value === value.instanceId)) {
        // The stored choice, even when this user cannot list it (no Sandbox read) or it is gone.
        instanceOptions.unshift({ value: value.instanceId, label: `Sandbox ${value.instanceId}` });
    }

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
                        {attached ? (
                            <Stack gap="sm">
                                <Select
                                    label="Persistent sandbox"
                                    description="An existing persistent sandbox of this project. Its template, resources, network and own variables apply; the agent starts it when it is stopped and never stops or deletes it."
                                    placeholder="Pick a persistent sandbox"
                                    withAsterisk
                                    error={!value?.instanceId ? 'Pick a sandbox — the agent cannot be saved without one.' : undefined}
                                    data={instanceOptions}
                                    value={value?.instanceId ?? null}
                                    onChange={(next) => patch({ instanceId: next ?? undefined })}
                                    disabled={capabilities?.canAttach === false}
                                    searchable
                                    nothingFoundMessage="No persistent sandboxes"
                                />
                                {capabilities?.canAttach === false ? (
                                    <Text size="xs" c="dimmed">
                                        Choosing a sandbox needs write access to Sandbox in this project. Ask someone with Sandbox access to pick it.
                                    </Text>
                                ) : capabilities?.available && (capabilities.instances ?? []).length === 0 ? (
                                    <Alert variant="light" color="orange" icon={<IconInfoCircle size={16} />} p="xs">
                                        <Text size="sm">
                                            No persistent sandboxes in this project yet. Create one with “Persistent” on, on the{' '}
                                            <Anchor component={Link} href="/dashboard/sandbox/instances" size="sm">Sandboxes</Anchor> page.
                                        </Text>
                                    </Alert>
                                ) : null}
                            </Stack>
                        ) : (
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
                        )}
                    </ConfigBlock>

                    <ConfigBlock title="Lifetime">
                        <Stack gap="sm">
                            <SegmentedControl
                                value={mode}
                                onChange={(next) => patch({ mode: next as ResolvedSandboxMode })}
                                data={[
                                    { value: 'session', label: 'Session' },
                                    { value: 'ephemeral', label: 'Per message' },
                                    { value: 'instance', label: 'Persistent sandbox' },
                                ]}
                            />
                            <Text size="xs" c="dimmed">
                                {mode === 'instance'
                                    ? 'Every conversation works in the same persistent sandbox you pick under Machine: files and installed packages stay until someone deletes them, and anyone with access to that sandbox sees what the agent writes. The agent\'s variables below go with each command instead of onto the machine; only files written to /outputs/ during a reply are delivered.'
                                    : mode === 'ephemeral'
                                        ? 'A fresh sandbox for every message, deleted when the reply is done. Nothing carries over between turns.'
                                        : 'One sandbox per conversation, kept running between messages: files and installed packages carry over, and every use extends its life. It is shut down and deleted once it has been idle for the sandbox idle timeout (Sandbox → Settings, or the template\'s own), or with the conversation; the next message then starts a fresh one. A call without a conversation gets a throwaway sandbox.'}
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
                            </Group>
                        </Stack>
                    </ConfigBlock>

                    <ConfigBlock title={tSeed('title')}>
                        <SandboxSeedFiles
                            agentId={agentId}
                            value={value?.seedFiles}
                            onChange={(next) => patch({ seedFiles: next.length > 0 ? next : undefined })}
                        />
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
                                        {attached ? null : (
                                            <NumberInput
                                                label="Keep running while idle (minutes)"
                                                description="A machine with a live preview is not stopped when the reply ends; it stops after this long without activity."
                                                placeholder="30"
                                                min={5}
                                                max={1440}
                                                value={value.preview.keepAliveMinutes ?? ''}
                                                onChange={(next) => patchPreview({ keepAliveMinutes: optionalNumber(next) })}
                                            />
                                        )}
                                    </Group>
                                    {value.blockNetwork && !attached ? (
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
                                refs={value?.envRefs}
                                onChange={({ values, refs }) => patch({ env: values, envRefs: refs })}
                                addLabel="Add variable"
                                catalog={catalog}
                                boundGroups={value?.groupRefs}
                                onAddGroups={(groups) => patch({ groupRefs: addGroupRefs(value?.groupRefs, groups) })}
                            />
                        </Stack>
                    </ConfigBlock>

                    <ConfigBlock title="Config groups">
                        <Stack gap="xs">
                            <Text size="xs" c="dimmed">
                                Bind a whole Config group: every item in it, now and later, becomes a variable named
                                after its key. Secret items are passed like Secrets (per command, masked), the others
                                are set like Environment variables. A variable you set by name above or below wins.
                            </Text>
                            <BoundGroupsList
                                catalog={catalog}
                                value={value?.groupRefs}
                                onChange={(next) => patch({ groupRefs: next.length > 0 ? next : undefined })}
                            />
                            <Group>
                                <AddFromConfigPopover
                                    catalog={catalog}
                                    takenNames={new Set()}
                                    boundGroups={value?.groupRefs}
                                    onAddItems={() => undefined}
                                    onAddGroups={(groups) => patch({ groupRefs: addGroupRefs(value?.groupRefs, groups) })}
                                    groupsOnly
                                />
                            </Group>
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
                            {value?.secretsUnreadable ? (
                                <Alert variant="light" color="orange" p="xs" icon={<IconAlertTriangle size={14} />} title={tSecrets('unreadableTitle')} data-testid="sandbox-secrets-unreadable">
                                    <Text size="xs">{tSecrets('unreadableBody')}</Text>
                                </Alert>
                            ) : null}
                            <KeyValueEditor
                                value={value?.secrets}
                                refs={value?.secretRefs}
                                onChange={({ values, refs }) => patch({ secrets: values ?? {}, secretRefs: refs })}
                                addLabel="Add secret"
                                secret
                                catalog={catalog}
                                boundGroups={value?.groupRefs}
                                onAddGroups={(groups) => patch({ groupRefs: addGroupRefs(value?.groupRefs, groups) })}
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
    refs,
    onChange,
    addLabel,
    catalog,
    secret = false,
    boundGroups,
    onAddGroups,
}: {
    value: Record<string, string> | undefined;
    refs: Record<string, IConfigValueRef> | undefined;
    onChange: (next: { values: Record<string, string> | undefined; refs: Record<string, IConfigValueRef> | undefined }) => void;
    addLabel: string;
    catalog: ConfigCatalog;
    secret?: boolean;
    boundGroups?: IConfigGroupRef[];
    onAddGroups?: (groups: ConfigCatalogGroup[]) => void;
}) {
    const [rows, setRows] = useState<EditorRow[]>(() => rowsFromMaps(value, refs));
    const forbidden = catalog.status === 'forbidden';

    // Re-seed when the stored value changes from outside (agent reload/save).
    const serialized = serializeMaps({ values: value, refs });
    useEffect(() => {
        setRows((current) => (serializeMaps(rowsToMaps(current)) === serialized ? current : rowsFromMaps(value, refs)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serialized]);

    const update = (next: EditorRow[]) => {
        setRows(next);
        onChange(rowsToMaps(next));
    };
    const setRow = (id: number, next: Partial<EditorRow>) => update(rows.map((r) => (r.id === id ? { ...r, ...next } : r)));

    return (
        <Stack gap={6}>
            {rows.map((row) => {
                const problem = row.source === 'config' && row.key.trim() ? nameProblem(row.key, usedNames(rows, row.id)) : null;
                return (
                    <Group key={row.id} gap="xs" wrap="nowrap" align="flex-start">
                        <TextInput
                            placeholder="NAME"
                            aria-label="Variable name"
                            value={row.key}
                            onChange={(event) => setRow(row.id, { key: event.currentTarget.value })}
                            style={{ flex: 1 }}
                            ff="monospace"
                            error={problem ? nameProblemText(problem) : undefined}
                        />
                        <Tooltip label={CONFIG_FORBIDDEN_HINT} withArrow disabled={!forbidden}>
                            <SegmentedControl
                                size="xs"
                                aria-label="Value source"
                                value={row.source}
                                onChange={(next) => update(rows.map((r) => (r.id === row.id ? switchRowSource(r, next as 'value' | 'config') : r)))}
                                data={[
                                    { value: 'value', label: 'Value' },
                                    { value: 'config', label: 'Config', disabled: forbidden && row.source !== 'config' },
                                ]}
                            />
                        </Tooltip>
                        <div style={{ flex: 2, minWidth: 0 }}>
                            {row.source === 'config' ? (
                                <>
                                    <ConfigItemPicker
                                        catalog={catalog}
                                        value={row.ref}
                                        onChange={(ref) => setRow(row.id, row.key.trim() ? { ref } : { ref, key: envNameFromConfigKey(ref.key) ?? '' })}
                                        disableSecret={!secret}
                                    />
                                    {!row.ref ? <Text size="xs" c="red.7" mt={2}>Pick a config item — until then the current value is kept.</Text> : null}
                                </>
                            ) : secret ? (
                                <PasswordInput
                                    placeholder={row.value === SANDBOX_SECRET_MASK ? 'Stored — type to replace' : 'value'}
                                    aria-label="Secret value"
                                    value={row.value === SANDBOX_SECRET_MASK ? '' : row.value}
                                    onChange={(event) => setRow(row.id, { value: event.currentTarget.value || SANDBOX_SECRET_MASK })}
                                />
                            ) : (
                                <TextInput
                                    placeholder="value"
                                    aria-label="Value"
                                    value={row.value}
                                    onChange={(event) => setRow(row.id, { value: event.currentTarget.value })}
                                />
                            )}
                        </div>
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
                );
            })}
            <Group gap="xs">
                <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconPlus size={12} />}
                    onClick={() => update([...rows, { id: nextRowId(), key: '', source: 'value', value: '' }])}
                >
                    {addLabel}
                </Button>
                <AddFromConfigPopover
                    catalog={catalog}
                    takenNames={usedNames(rows)}
                    disableSecret={!secret}
                    boundGroups={boundGroups}
                    onAddItems={(picks) => update([...rows, ...rowsForPickedItems(picks, usedNames(rows))])}
                    onAddGroups={onAddGroups}
                />
            </Group>
        </Stack>
    );
}
