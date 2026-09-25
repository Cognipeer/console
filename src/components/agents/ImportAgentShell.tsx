'use client';

/**
 * New → Import: bring an agent in from a definition document.
 *
 * Paste or upload JSON, YAML or a Markdown file with YAML front-matter. The
 * server detects the format (a console manifest or a Claude Managed Agent);
 * when it cannot tell, the format picker decides. The preview is where the
 * mapping is settled before anything is written: which console model, what
 * to do with each MCP server (reuse one already here, create it — with its
 * credentials — or skip) and each skill (map, create, skip). Import creates
 * everything in one go and rolls back if any part fails.
 */

import { useMemo, useRef, useState } from 'react';
import {
    Alert,
    Badge,
    Button,
    Code,
    FileButton,
    Group,
    PasswordInput,
    SegmentedControl,
    Select,
    Stack,
    Text,
    TextInput,
    Textarea,
} from '@mantine/core';
import { IconAlertTriangle, IconFileImport, IconUpload } from '@tabler/icons-react';
import FormShell, { FormField, FormRow, FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';

type FormatId = 'cognipeer' | 'claude-managed-agent';

interface Preview {
    format: { id: FormatId | null; label?: string; detected: boolean; candidates: Array<{ id: FormatId; label: string; confidence: number }> };
    envelope: 'json' | 'yaml' | 'markdown';
    agent?: { name: string; key: string; description?: string; exists: boolean };
    model?: { requested?: string; suggestedKey?: string; options: Array<{ key: string; name: string; modelId: string }> };
    mcpServers: Array<{ ref: string; url: string; referenced: boolean; existing?: { key: string; name: string } }>;
    skills: Array<{ ref: string; label: string; kind: 'anthropic' | 'custom' | 'cognipeer'; existing?: { key: string; title: string } }>;
    skillOptions: Array<{ key: string; title: string }>;
    resources: ResourceRow[];
    capabilities: {
        sandbox: { requested: string[]; available: boolean; reason?: string };
        webSearch: { requested: boolean; available: boolean };
        webFetch: { requested: boolean };
    };
    warnings: Array<{ code: string; message: string }>;
}

type ResourceType = 'skills' | 'prompts' | 'mcpServers' | 'tools';
interface ResourceRow {
    type: ResourceType;
    key: string;
    name: string;
    detail?: string;
    existing?: { key: string; name: string };
    auth?: { type: 'none' | 'token' | 'header' | 'basic'; headerName?: string; username?: string };
    envKeys?: string[];
}
type ResourceChoice = {
    action: 'reuse' | 'create' | 'skip';
    token?: string;
    headerName?: string;
    headerValue?: string;
    username?: string;
    password?: string;
    env?: Record<string, string>;
};
const RESOURCE_LABELS: Record<ResourceType, string> = { skills: 'Skill', prompts: 'Prompt', mcpServers: 'MCP server', tools: 'Tool' };
const resourceRef = (row: ResourceRow) => `${row.type}:${row.key}`;

type McpChoice = {
    action: 'reuse' | 'create' | 'skip';
    key?: string;
    authType: 'none' | 'token' | 'header';
    token?: string;
    headerName?: string;
    headerValue?: string;
    transport: 'streamable-http' | 'sse';
};
type SkillChoice = { action: 'skip' | 'map' | 'create'; key?: string; title?: string; header?: string; body?: string };

const FORMAT_OPTIONS = [
    { value: 'auto', label: 'Detect automatically' },
    { value: 'claude-managed-agent', label: 'Claude Managed Agent' },
    { value: 'cognipeer', label: 'Cognipeer agent manifest' },
];

export interface ImportAgentShellProps {
    opened: boolean;
    onClose: () => void;
    onImported: (agentId: string) => void;
}

export default function ImportAgentShell({ opened, onClose, onImported }: ImportAgentShellProps) {
    const [content, setContent] = useState('');
    const [fileName, setFileName] = useState<string | null>(null);
    const [format, setFormat] = useState<string>('auto');
    const [preview, setPreview] = useState<Preview | null>(null);
    const [reading, setReading] = useState(false);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [key, setKey] = useState('');
    const [modelKey, setModelKey] = useState<string | null>(null);
    const [mcp, setMcp] = useState<Record<string, McpChoice>>({});
    const [skills, setSkills] = useState<Record<string, SkillChoice>>({});
    const [resources, setResources] = useState<Record<string, ResourceChoice>>({});
    const resetRef = useRef<() => void>(null);

    const reset = () => {
        setContent('');
        setFileName(null);
        setFormat('auto');
        setPreview(null);
        setError(null);
        resetRef.current?.();
    };

    const close = () => {
        reset();
        onClose();
    };

    const read = async (text = content, formatHint = format) => {
        setReading(true);
        setError(null);
        try {
            const res = await fetch('/api/agents/import/document/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: text, format: formatHint }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
            const next = data as Preview;
            setPreview(next);
            setName(next.agent?.name ?? '');
            setKey(next.agent?.key ?? '');
            setModelKey(next.model?.suggestedKey ?? null);
            setMcp(Object.fromEntries(next.mcpServers.map((server) => [server.ref, {
                action: server.existing ? 'reuse' : 'create',
                key: server.existing?.key,
                authType: 'none',
                transport: 'streamable-http',
            } satisfies McpChoice])));
            setSkills(Object.fromEntries(next.skills.map((skill) => [skill.ref, skill.existing
                ? { action: 'map', key: skill.existing.key }
                : { action: 'skip', title: skill.label, header: `Imported ${skill.kind} skill ${skill.label}`, body: '' }])));
            setResources(Object.fromEntries((next.resources ?? []).map((row) => [resourceRef(row), {
                action: row.existing ? 'reuse' : 'create',
                ...(row.auth?.headerName ? { headerName: row.auth.headerName } : {}),
                ...(row.auth?.username ? { username: row.auth.username } : {}),
            } satisfies ResourceChoice])));
        } catch (err) {
            setPreview(null);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setReading(false);
        }
    };

    const onFile = async (file: File | null) => {
        if (!file) return;
        const text = await file.text();
        setFileName(file.name);
        setContent(text);
        await read(text, format);
    };

    const needsFormat = Boolean(preview && !preview.format.id);
    const isClaude = preview?.format.id === 'claude-managed-agent';
    const blockers = useMemo(() => {
        const list: string[] = [];
        if (!preview || !preview.format.id) list.push('Choose the document format');
        if (preview?.format.id && !modelKey) list.push('Choose a model');
        if (isClaude && !key.trim()) list.push('Set an agent key');
        for (const [ref, choice] of Object.entries(skills)) {
            if (choice.action === 'map' && !choice.key) list.push(`Pick a skill for ${ref}`);
            if (choice.action === 'create' && (!choice.title?.trim() || !choice.header?.trim())) list.push(`Name the new skill for ${ref}`);
        }
        for (const [ref, choice] of Object.entries(mcp)) {
            if (choice.action === 'reuse' && !choice.key) list.push(`Pick an MCP server for ${ref}`);
        }
        return list;
    }, [preview, modelKey, isClaude, key, skills, mcp]);

    const submit = async () => {
        if (!preview?.format.id) return;
        setImporting(true);
        setError(null);
        try {
            const res = await fetch('/api/agents/import/document', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content,
                    format: preview.format.id,
                    key: key.trim() || undefined,
                    name: name.trim() || undefined,
                    modelKey,
                    mcp: Object.fromEntries(Object.entries(mcp).map(([ref, choice]) => [ref,
                        choice.action === 'reuse' ? { action: 'reuse', key: choice.key }
                            : choice.action === 'skip' ? { action: 'skip' }
                                : {
                                    action: 'create',
                                    transport: choice.transport,
                                    auth: {
                                        type: choice.authType,
                                        ...(choice.authType === 'token' ? { token: choice.token } : {}),
                                        ...(choice.authType === 'header' ? { headerName: choice.headerName, headerValue: choice.headerValue } : {}),
                                    },
                                }])),
                    skills: Object.fromEntries(Object.entries(skills).map(([ref, choice]) => [ref,
                        choice.action === 'map' ? { action: 'map', key: choice.key }
                            : choice.action === 'create' ? { action: 'create', title: choice.title, header: choice.header, body: choice.body ?? '' }
                                : { action: 'skip' }])),
                    resources: Object.fromEntries(Object.entries(resources).map(([ref, choice]) => [ref,
                        choice.action !== 'create' ? { action: choice.action }
                            : {
                                action: 'create',
                                auth: {
                                    token: choice.token || undefined,
                                    headerName: choice.headerName || undefined,
                                    headerValue: choice.headerValue || undefined,
                                    username: choice.username || undefined,
                                    password: choice.password || undefined,
                                },
                                ...(choice.env ? { env: choice.env } : {}),
                            }])),
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
            reset();
            onImported(String(data.agent._id));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setImporting(false);
        }
    };

    const summary = (
        <Stack gap="md">
            <SummaryGroup title="Document">
                <SummaryKV label="File" value={fileName ?? (content ? 'Pasted' : '—')} />
                <SummaryKV label="Format" value={preview?.format.label ?? (preview ? 'Not recognised' : '—')} />
                <SummaryKV label="Envelope" value={preview?.envelope?.toUpperCase() ?? '—'} />
            </SummaryGroup>
            {preview?.format.id ? (
                <SummaryGroup title="Will create">
                    <SummaryKV label="Agent" value={key || '—'} />
                    <SummaryKV label="MCP servers" value={String(Object.values(mcp).filter((c) => c.action === 'create').length)} />
                    <SummaryKV label="Skills" value={String(Object.values(skills).filter((c) => c.action === 'create').length)} />
                    {preview.resources?.length ? (
                        <SummaryKV label="Embedded definitions" value={`${Object.values(resources).filter((c) => c.action === 'create').length} new · ${Object.values(resources).filter((c) => c.action === 'reuse').length} reused`} />
                    ) : null}
                </SummaryGroup>
            ) : null}
        </Stack>
    );

    return (
        <FormShell
            open={opened}
            onClose={close}
            icon={<IconFileImport size={16} />}
            title="Import agent"
            subtitle="From a Claude Managed Agent definition or a console agent manifest — JSON, YAML or Markdown with front-matter."
            summary={summary}
            footerStatus={preview ? (blockers.length === 0 ? 'Ready to import' : blockers[0]) : 'Paste or upload a document'}
            primaryAction={{
                label: 'Import agent',
                color: 'teal',
                loading: importing,
                disabled: !preview || blockers.length > 0,
                onClick: () => { void submit(); },
            }}
            secondaryAction={{ label: 'Cancel', variant: 'default', onClick: close }}
        >
            <FormSection number={1} title="Document" description="Paste the definition or upload a .json, .yaml or .md file." done={Boolean(preview?.format.id)}>
                <Stack gap="sm">
                    <Group gap="sm">
                        <FileButton resetRef={resetRef} onChange={(file) => { void onFile(file); }} accept=".json,.yaml,.yml,.md,.markdown,application/json,text/yaml,text/markdown">
                            {(props) => <Button {...props} variant="default" size="xs" leftSection={<IconUpload size={14} />}>Upload file</Button>}
                        </FileButton>
                        {fileName ? <Text size="xs" c="dimmed">{fileName}</Text> : null}
                        <Select
                            size="xs"
                            ml="auto"
                            w={240}
                            data={FORMAT_OPTIONS}
                            value={format}
                            onChange={(value) => {
                                const next = value ?? 'auto';
                                setFormat(next);
                                if (content.trim()) void read(content, next);
                            }}
                            allowDeselect={false}
                            aria-label="Document format"
                        />
                    </Group>
                    <Textarea
                        placeholder={'---\nname: Support agent\nmodel: claude-opus-5-5\nmcp_servers:\n  - type: url\n    name: github\n    url: https://api.githubcopilot.com/mcp/\n---\n\nYou are a helpful support agent.'}
                        autosize
                        minRows={8}
                        maxRows={16}
                        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
                        value={content}
                        onChange={(event) => { setContent(event.currentTarget.value); setPreview(null); }}
                    />
                    <Group justify="flex-end">
                        <Button size="xs" variant="light" loading={reading} disabled={!content.trim()} onClick={() => { void read(); }}>
                            Read document
                        </Button>
                    </Group>
                    {preview?.format.id ? (
                        <Group gap="xs">
                            <Badge variant="light" color="teal">{preview.format.label}</Badge>
                            <Text size="xs" c="dimmed">{preview.format.detected ? 'detected automatically' : 'chosen manually'}</Text>
                        </Group>
                    ) : null}
                    {needsFormat ? (
                        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
                            <Text size="sm">
                                This document doesn’t match a known format by itself. Choose the format above to read it.
                            </Text>
                        </Alert>
                    ) : null}
                    {error ? <Alert color="red" variant="light">{error}</Alert> : null}
                </Stack>
            </FormSection>

            {preview?.format.id ? (
                <FormSection number={2} title="Agent" description="Name, key and the console model that will run it." done={Boolean(modelKey && key)}>
                    <Stack gap="sm">
                        <FormRow cols={2}>
                            <FormField label="Name" required>
                                <TextInput value={name} onChange={(event) => setName(event.currentTarget.value)} />
                            </FormField>
                            <FormField label="Key" required hint={preview.agent?.exists ? 'An agent with this key already exists — choose another.' : undefined}>
                                <TextInput value={key} onChange={(event) => setKey(event.currentTarget.value)} error={preview.agent?.exists && key === preview.agent.key ? true : undefined} />
                            </FormField>
                        </FormRow>
                        <FormField
                            label="Model"
                            required
                            hint={preview.model?.requested ? <>The document asks for <Code>{preview.model.requested}</Code>.</> : undefined}
                        >
                            <Select
                                searchable
                                placeholder="Choose a model"
                                data={(preview.model?.options ?? []).map((m) => ({ value: m.key, label: `${m.name} (${m.modelId})` }))}
                                value={modelKey}
                                onChange={setModelKey}
                            />
                        </FormField>
                        {isClaude ? (
                            <Group gap="xs">
                                {preview.capabilities.sandbox.requested.length > 0 ? (
                                    <Badge variant="light" color={preview.capabilities.sandbox.available ? 'grape' : 'gray'}>
                                        Sandbox: {preview.capabilities.sandbox.requested.join(', ')}{preview.capabilities.sandbox.available ? '' : ' — unavailable'}
                                    </Badge>
                                ) : null}
                                {preview.capabilities.webSearch.requested ? (
                                    <Badge variant="light" color={preview.capabilities.webSearch.available ? 'blue' : 'gray'}>
                                        web_search → Web Search{preview.capabilities.webSearch.available ? '' : ' (no provider yet)'}
                                    </Badge>
                                ) : null}
                                {preview.capabilities.webFetch.requested ? <Badge variant="light" color="blue">web_fetch → Browser Use</Badge> : null}
                            </Group>
                        ) : null}
                    </Stack>
                </FormSection>
            ) : null}

            {preview?.format.id && preview.mcpServers.length > 0 ? (
                <FormSection number={3} title="MCP servers" description="Each one is reused if it already exists here, or created now — with its credentials — and its tools are bound to the agent.">
                    <Stack gap="md">
                        {preview.mcpServers.map((server) => {
                            const choice = mcp[server.ref];
                            if (!choice) return null;
                            const set = (patch: Partial<McpChoice>) => setMcp((prev) => ({ ...prev, [server.ref]: { ...prev[server.ref], ...patch } }));
                            return (
                                <Stack key={server.ref} gap={6} p="sm" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }}>
                                    <Group justify="space-between" wrap="nowrap">
                                        <div style={{ minWidth: 0 }}>
                                            <Text size="sm" fw={600}>{server.ref}</Text>
                                            <Text size="xs" c="dimmed" ff="monospace" truncate>{server.url}</Text>
                                        </div>
                                        <SegmentedControl
                                            size="xs"
                                            value={choice.action}
                                            onChange={(value) => set({ action: value as McpChoice['action'] })}
                                            data={[
                                                ...(server.existing ? [{ value: 'reuse', label: `Reuse ${server.existing.name}` }] : []),
                                                { value: 'create', label: 'Create' },
                                                { value: 'skip', label: 'Skip' },
                                            ]}
                                        />
                                    </Group>
                                    {!server.referenced ? <Text size="xs" c="dimmed">Listed without an mcp_toolset — created, but no tools are bound.</Text> : null}
                                    {choice.action === 'create' ? (
                                        <FormRow cols={3}>
                                            <FormField label="Credentials">
                                                <Select
                                                    size="xs"
                                                    data={[{ value: 'none', label: 'None' }, { value: 'token', label: 'Bearer token' }, { value: 'header', label: 'Custom header' }]}
                                                    value={choice.authType}
                                                    onChange={(value) => set({ authType: (value ?? 'none') as McpChoice['authType'] })}
                                                    allowDeselect={false}
                                                />
                                            </FormField>
                                            {choice.authType === 'token' ? (
                                                <FormField label="Token">
                                                    <PasswordInput size="xs" value={choice.token ?? ''} onChange={(event) => set({ token: event.currentTarget.value })} />
                                                </FormField>
                                            ) : choice.authType === 'header' ? (
                                                <>
                                                    <FormField label="Header">
                                                        <TextInput size="xs" placeholder="X-API-Key" value={choice.headerName ?? ''} onChange={(event) => set({ headerName: event.currentTarget.value })} />
                                                    </FormField>
                                                    <FormField label="Value">
                                                        <PasswordInput size="xs" value={choice.headerValue ?? ''} onChange={(event) => set({ headerValue: event.currentTarget.value })} />
                                                    </FormField>
                                                </>
                                            ) : (
                                                <FormField label="Transport">
                                                    <Select
                                                        size="xs"
                                                        data={[{ value: 'streamable-http', label: 'Streamable HTTP' }, { value: 'sse', label: 'SSE' }]}
                                                        value={choice.transport}
                                                        onChange={(value) => set({ transport: (value ?? 'streamable-http') as McpChoice['transport'] })}
                                                        allowDeselect={false}
                                                    />
                                                </FormField>
                                            )}
                                        </FormRow>
                                    ) : null}
                                </Stack>
                            );
                        })}
                    </Stack>
                </FormSection>
            ) : null}

            {preview?.format.id && preview.skills.length > 0 ? (
                <FormSection number={4} title="Skills" description="A Claude skill is referenced by id — its content is not in the file. Map it to a console skill, create a new one to fill in, or skip it.">
                    <Stack gap="md">
                        {preview.skills.map((skill) => {
                            const choice = skills[skill.ref];
                            if (!choice) return null;
                            const set = (patch: Partial<SkillChoice>) => setSkills((prev) => ({ ...prev, [skill.ref]: { ...prev[skill.ref], ...patch } }));
                            return (
                                <Stack key={skill.ref} gap={6} p="sm" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }}>
                                    <Group justify="space-between" wrap="nowrap">
                                        <Group gap="xs">
                                            <Text size="sm" fw={600} ff="monospace">{skill.label}</Text>
                                            <Badge size="xs" variant="light" color={skill.kind === 'anthropic' ? 'orange' : 'gray'}>{skill.kind}</Badge>
                                        </Group>
                                        <SegmentedControl
                                            size="xs"
                                            value={choice.action}
                                            onChange={(value) => set({ action: value as SkillChoice['action'] })}
                                            data={[{ value: 'map', label: 'Use existing' }, { value: 'create', label: 'Create new' }, { value: 'skip', label: 'Skip' }]}
                                        />
                                    </Group>
                                    {choice.action === 'map' ? (
                                        <Select
                                            size="xs"
                                            searchable
                                            placeholder="Choose a skill"
                                            data={preview.skillOptions.map((s) => ({ value: s.key, label: s.title }))}
                                            value={choice.key ?? null}
                                            onChange={(value) => set({ key: value ?? undefined })}
                                        />
                                    ) : null}
                                    {choice.action === 'create' ? (
                                        <Stack gap={6}>
                                            <FormRow cols={2}>
                                                <FormField label="Title" required>
                                                    <TextInput size="xs" value={choice.title ?? ''} onChange={(event) => set({ title: event.currentTarget.value })} />
                                                </FormField>
                                                <FormField label="When to use it" required>
                                                    <TextInput size="xs" value={choice.header ?? ''} onChange={(event) => set({ header: event.currentTarget.value })} />
                                                </FormField>
                                            </FormRow>
                                            <Textarea size="xs" autosize minRows={2} maxRows={6} placeholder="Instructions (can be filled in later under Skills)" value={choice.body ?? ''} onChange={(event) => set({ body: event.currentTarget.value })} />
                                        </Stack>
                                    ) : null}
                                </Stack>
                            );
                        })}
                    </Stack>
                </FormSection>
            ) : null}

            {preview?.format.id && preview.resources?.length > 0 ? (
                <FormSection number={3} title="Included definitions" description="The manifest carries these definitions. Each is reused when this project already has it, or created now — credentials were not exported, so enter them here.">
                    <Stack gap="md">
                        {preview.resources.map((row) => {
                            const ref = resourceRef(row);
                            const choice = resources[ref];
                            if (!choice) return null;
                            const set = (patch: Partial<ResourceChoice>) => setResources((prev) => ({ ...prev, [ref]: { ...prev[ref], ...patch } }));
                            return (
                                <Stack key={ref} gap={6} p="sm" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }}>
                                    <Group justify="space-between" wrap="nowrap">
                                        <div style={{ minWidth: 0 }}>
                                            <Group gap="xs">
                                                <Text size="sm" fw={600}>{row.name}</Text>
                                                <Badge size="xs" variant="light" color="gray">{RESOURCE_LABELS[row.type]}</Badge>
                                                <Text size="xs" c="dimmed" ff="monospace">{row.key}</Text>
                                            </Group>
                                            {row.detail ? <Text size="xs" c="dimmed" truncate>{row.detail}</Text> : null}
                                        </div>
                                        <SegmentedControl
                                            size="xs"
                                            value={choice.action}
                                            onChange={(value) => set({ action: value as ResourceChoice['action'] })}
                                            data={[
                                                ...(row.existing ? [{ value: 'reuse', label: `Use existing ${row.existing.name}` }] : []),
                                                { value: 'create', label: row.existing ? 'Create a copy' : 'Create' },
                                                { value: 'skip', label: 'Skip' },
                                            ]}
                                        />
                                    </Group>
                                    {choice.action === 'create' && row.auth && row.auth.type !== 'none' ? (
                                        <FormRow cols={2}>
                                            {row.auth.type === 'token' ? (
                                                <FormField label="Bearer token">
                                                    <PasswordInput size="xs" value={choice.token ?? ''} onChange={(event) => set({ token: event.currentTarget.value })} />
                                                </FormField>
                                            ) : row.auth.type === 'header' ? (
                                                <>
                                                    <FormField label="Header">
                                                        <TextInput size="xs" value={choice.headerName ?? ''} onChange={(event) => set({ headerName: event.currentTarget.value })} />
                                                    </FormField>
                                                    <FormField label="Value">
                                                        <PasswordInput size="xs" value={choice.headerValue ?? ''} onChange={(event) => set({ headerValue: event.currentTarget.value })} />
                                                    </FormField>
                                                </>
                                            ) : (
                                                <>
                                                    <FormField label="Username">
                                                        <TextInput size="xs" value={choice.username ?? ''} onChange={(event) => set({ username: event.currentTarget.value })} />
                                                    </FormField>
                                                    <FormField label="Password">
                                                        <PasswordInput size="xs" value={choice.password ?? ''} onChange={(event) => set({ password: event.currentTarget.value })} />
                                                    </FormField>
                                                </>
                                            )}
                                        </FormRow>
                                    ) : null}
                                    {choice.action === 'create' && row.envKeys?.length ? (
                                        <FormRow cols={2}>
                                            {row.envKeys.map((name) => (
                                                <FormField key={name} label={name}>
                                                    <PasswordInput
                                                        size="xs"
                                                        value={choice.env?.[name] ?? ''}
                                                        onChange={(event) => set({ env: { ...(choice.env ?? {}), [name]: event.currentTarget.value } })}
                                                    />
                                                </FormField>
                                            ))}
                                        </FormRow>
                                    ) : null}
                                </Stack>
                            );
                        })}
                    </Stack>
                </FormSection>
            ) : null}

            {preview?.format.id && preview.warnings.length > 0 ? (
                <FormSection title="Notes" description="What will not carry over as-is.">
                    <Stack gap={6}>
                        {preview.warnings.map((warning, index) => (
                            <Alert key={index} color="yellow" variant="light" p="xs" icon={<IconAlertTriangle size={14} />}>
                                <Text size="xs">{warning.message}</Text>
                            </Alert>
                        ))}
                    </Stack>
                </FormSection>
            ) : null}
        </FormShell>
    );
}
