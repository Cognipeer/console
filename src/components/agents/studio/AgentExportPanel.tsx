'use client';

/**
 * Export / Import.
 *
 * Three things live here because they answer the same question — "how do I get
 * this agent out of the console?" — with different amounts of coupling:
 *
 *   manifest  round-trips; the agent stays a console agent
 *   code      does not round-trip; the team owns the source afterwards
 *   import    the other direction, always via a dry run first
 */

import { useCallback, useEffect, useState } from 'react';
import {
    Accordion,
    Alert,
    Badge,
    Button,
    Card,
    Checkbox,
    Code,
    CopyButton,
    FileButton,
    Group,
    List,
    LoadingOverlay,
    ScrollArea,
    SegmentedControl,
    Select,
    Stack,
    Switch,
    Tabs,
    Text,
    TextInput,
    Textarea,
    Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle,
    IconCheck,
    IconCode,
    IconCopy,
    IconDownload,
    IconFileCode,
    IconFileImport,
    IconRefresh,
} from '@tabler/icons-react';
import { versionSelectData } from './StartSessionModal';

type CodegenTarget = 'cli' | 'server' | 'worker' | 'lambda';

interface GeneratedFile {
    path: string;
    contents: string;
    description?: string;
}

interface CodegenResult {
    rootDir: string;
    files: GeneratedFile[];
    warnings: string[];
}

interface DependencyStatus {
    type: string;
    key: string;
    usedBy: string;
    present: boolean;
}

interface ImportPreview {
    exists: boolean;
    dependencies: DependencyStatus[];
    missing: DependencyStatus[];
    manifest: { metadata: { key: string; name: string } };
}

export interface AgentExportPanelProps {
    agentId: string;
    agentKey: string;
    versions: Array<{ version: number }>;
    publishedVersion?: number | null;
    onImported?: () => void;
}

const TARGET_DESCRIPTIONS: Record<CodegenTarget, string> = {
    server: 'Fastify service with POST /chat, /health and an A2A agent card — the console can register it back as a connected agent.',
    cli: 'One-shot command: `npm start -- "your question"`. The quickest way to see the agent run outside the console.',
    worker: 'Queue-consumer skeleton with the agent built once outside the loop and an idempotency key per job.',
    lambda: 'AWS Lambda handler. The agent is built at module scope so a warm container skips tool discovery.',
};

export default function AgentExportPanel({
    agentId,
    agentKey,
    versions,
    publishedVersion,
    onImported,
}: AgentExportPanelProps) {
    // ── Manifest ──────────────────────────────────────────────────────────
    const [format, setFormat] = useState<'yaml' | 'json'>('yaml');
    const [sourceVersion, setSourceVersion] = useState<string | null>(null);
    const [manifestText, setManifestText] = useState('');
    const [manifestLoading, setManifestLoading] = useState(false);
    // Definitions to embed next to the references, so the manifest can be
    // imported into a project that does not have them yet.
    const [include, setInclude] = useState<string[]>([]);
    const [skippedResources, setSkippedResources] = useState<Array<{ type: string; key: string; reason: string }>>([]);

    const manifestParams = useCallback((extra: Record<string, string> = {}) => {
        const params = new URLSearchParams({ format, ...extra });
        if (sourceVersion) params.set('version', sourceVersion);
        if (include.length > 0) params.set('include', include.join(','));
        return params;
    }, [format, sourceVersion, include]);

    const loadManifest = useCallback(async () => {
        setManifestLoading(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/export?${manifestParams()}`);
            if (!res.ok) throw new Error(`Export failed (${res.status})`);
            const data = await res.json();
            setManifestText(data.content ?? '');
            setSkippedResources(Array.isArray(data.skippedResources) ? data.skippedResources : []);
        } catch (error) {
            notifications.show({
                title: 'Export failed',
                message: error instanceof Error ? error.message : String(error),
                color: 'red',
            });
        } finally {
            setManifestLoading(false);
        }
    }, [agentId, manifestParams]);

    useEffect(() => {
        void loadManifest();
    }, [loadManifest]);

    // The manifest and code tabs share one source-version picker.
    const versionSelect = {
        data: versionSelectData(versions, publishedVersion),
        value: sourceVersion ?? '',
        onChange: (next: string | null) => setSourceVersion(next || null),
        allowDeselect: false,
    };

    const downloadManifest = () => {
        window.open(`/api/agents/${agentId}/export?${manifestParams({ download: '1' })}`, '_blank');
    };

    // ── Code export ───────────────────────────────────────────────────────
    const [target, setTarget] = useState<CodegenTarget>('server');
    const [packageName, setPackageName] = useState('');
    const [includeDockerfile, setIncludeDockerfile] = useState(true);
    const [codegen, setCodegen] = useState<CodegenResult | null>(null);
    const [codegenLoading, setCodegenLoading] = useState(false);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);

    // Preview and .zip are the same request — only the output format and what is read back differ.
    const runCodegen = async (output: 'json' | 'zip', failTitle: string, onResponse: (res: Response) => Promise<void>) => {
        setCodegenLoading(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/codegen`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    target,
                    packageName: packageName.trim() || undefined,
                    includeDockerfile,
                    consoleBaseUrl: window.location.origin,
                    ...(sourceVersion ? { version: Number(sourceVersion) } : {}),
                    format: output,
                }),
            });
            if (!res.ok) throw new Error(`Code export failed (${res.status})`);
            await onResponse(res);
        } catch (error) {
            notifications.show({
                title: failTitle,
                message: error instanceof Error ? error.message : String(error),
                color: 'red',
            });
        } finally {
            setCodegenLoading(false);
        }
    };

    const preview = () => runCodegen('json', 'Code export failed', async (res) => {
        const data: CodegenResult = await res.json();
        setCodegen(data);
        setSelectedFile(data.files.find((f) => f.path === 'src/agent.ts')?.path ?? data.files[0]?.path ?? null);
    });

    const downloadZip = () => runCodegen('zip', 'Download failed', async (res) => {
        const url = URL.createObjectURL(await res.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = `${packageName.trim() || agentKey}.zip`;
        link.click();
        URL.revokeObjectURL(url);
    });

    const activeFile = codegen?.files.find((f) => f.path === selectedFile) ?? null;

    // ── Import ────────────────────────────────────────────────────────────
    const [importText, setImportText] = useState('');
    const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
    const [importIssues, setImportIssues] = useState<string[]>([]);
    const [importBusy, setImportBusy] = useState(false);

    const runImport = async (dryRun: boolean) => {
        setImportBusy(true);
        setImportIssues([]);
        try {
            const res = await fetch('/api/agents/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: importText, dryRun, mode: 'upsert' }),
            });
            const data = await res.json();
            if (!res.ok) {
                setImportIssues(data.issues ?? [data.error ?? 'Import failed']);
                if (!dryRun) setImportPreview(null);
                return;
            }
            if (dryRun) {
                setImportPreview(data);
                return;
            }
            notifications.show({
                title: data.action === 'created' ? 'Agent imported' : 'Agent updated',
                message: `${data.agent?.name ?? 'Agent'} — ${data.missing?.length ?? 0} missing dependencies`,
                color: data.missing?.length ? 'yellow' : 'teal',
            });
            setImportText('');
            setImportPreview(null);
            onImported?.();
        } catch (error) {
            setImportIssues([error instanceof Error ? error.message : String(error)]);
        } finally {
            setImportBusy(false);
        }
    };

    return (
        <Tabs defaultValue="manifest">
            <Tabs.List mb="md">
                <Tabs.Tab value="manifest" leftSection={<IconFileCode size={14} />}>Manifest</Tabs.Tab>
                <Tabs.Tab value="code" leftSection={<IconCode size={14} />}>Code</Tabs.Tab>
                <Tabs.Tab value="import" leftSection={<IconFileImport size={14} />}>Import</Tabs.Tab>
            </Tabs.List>

            {/* ── Manifest ────────────────────────────────────────────── */}
            <Tabs.Panel value="manifest">
                <Stack gap="md">
                    <Alert variant="light" color="blue">
                        <Text size="sm">
                            The manifest is the agent&apos;s config with every tenant-local id replaced by a key.
                            That is what makes it portable: keys are what your other environment also has.
                            Secrets are never included.
                        </Text>
                    </Alert>

                    <Stack gap={6}>
                        <Text size="sm" fw={600}>Include definitions</Text>
                        <Text size="xs" c="dimmed">
                            Embed what the agent uses, so importing into a project that lacks them creates them.
                            Credentials stay out — the importer is asked for them.
                        </Text>
                        <Checkbox.Group value={include} onChange={setInclude}>
                            <Group gap="lg" mt={4}>
                                <Checkbox size="xs" value="skills" label="Skills" />
                                <Checkbox size="xs" value="prompts" label="Prompt" />
                                <Checkbox size="xs" value="mcp" label="MCP servers" />
                                <Checkbox size="xs" value="tools" label="Tools" />
                            </Group>
                        </Checkbox.Group>
                        {skippedResources.length > 0 ? (
                            <Alert variant="light" color="yellow" p="xs" icon={<IconAlertTriangle size={14} />}>
                                <Text size="xs">
                                    Kept as references only:{' '}
                                    {skippedResources.map((r) => `${r.key} (${r.reason})`).join('; ')}
                                </Text>
                            </Alert>
                        ) : null}
                    </Stack>

                    <Group>
                        <SegmentedControl
                            size="xs"
                            value={format}
                            onChange={(next) => setFormat(next as 'yaml' | 'json')}
                            data={[{ value: 'yaml', label: 'YAML' }, { value: 'json', label: 'JSON' }]}
                        />
                        <Select size="xs" w={240} {...versionSelect} />
                        <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={() => void loadManifest()}>
                            Reload
                        </Button>
                        <CopyButton value={manifestText}>
                            {({ copied, copy }) => (
                                <Button
                                    size="xs"
                                    variant="default"
                                    color={copied ? 'teal' : undefined}
                                    leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                                    onClick={copy}
                                >
                                    {copied ? 'Copied' : 'Copy'}
                                </Button>
                            )}
                        </CopyButton>
                        <Button size="xs" leftSection={<IconDownload size={14} />} onClick={downloadManifest}>
                            Download
                        </Button>
                    </Group>

                    <Card withBorder padding={0} radius="md" pos="relative">
                        <LoadingOverlay visible={manifestLoading} />
                        <ScrollArea h={420}>
                            <Code block style={{ fontSize: 12, border: 'none' }}>{manifestText || '—'}</Code>
                        </ScrollArea>
                    </Card>
                </Stack>
            </Tabs.Panel>

            {/* ── Code ────────────────────────────────────────────────── */}
            <Tabs.Panel value="code">
                <Stack gap="md">
                    <Alert variant="light" color="blue">
                        <Text size="sm">
                            The generated project calls the model through <Code>/api/client/v1</Code> and reaches
                            tools and MCP servers through <Code>@cognipeer/console-sdk</Code>. It holds one
                            credential — a console API key — so an exported agent still spends against this
                            tenant&apos;s quota and still shows up in tracing.
                        </Text>
                    </Alert>

                    <Group align="flex-end">
                        <Select
                            label="Project shape"
                            w={220}
                            data={[
                                { value: 'server', label: 'HTTP service' },
                                { value: 'cli', label: 'CLI' },
                                { value: 'worker', label: 'Queue worker' },
                                { value: 'lambda', label: 'AWS Lambda' },
                            ]}
                            value={target}
                            onChange={(next) => setTarget((next as CodegenTarget) ?? 'server')}
                            allowDeselect={false}
                        />
                        <TextInput
                            label="Package name"
                            placeholder={agentKey}
                            value={packageName}
                            onChange={(event) => setPackageName(event.currentTarget.value)}
                            w={220}
                        />
                        <Select label="Source" w={200} {...versionSelect} />
                        <Switch
                            mb={8}
                            label="Dockerfile"
                            checked={includeDockerfile}
                            onChange={(event) => setIncludeDockerfile(event.currentTarget.checked)}
                        />
                    </Group>

                    <Text size="xs" c="dimmed">{TARGET_DESCRIPTIONS[target]}</Text>

                    <Group>
                        <Button variant="default" onClick={() => void preview()} loading={codegenLoading}>
                            Generate preview
                        </Button>
                        <Button leftSection={<IconDownload size={14} />} onClick={() => void downloadZip()} loading={codegenLoading}>
                            Download .zip
                        </Button>
                    </Group>

                    {codegen?.warnings.length ? (
                        <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />} title="What does not come across">
                            <List size="sm" spacing={4}>
                                {codegen.warnings.map((warning) => (
                                    <List.Item key={warning}>{warning}</List.Item>
                                ))}
                            </List>
                        </Alert>
                    ) : null}

                    {codegen ? (
                        <Group align="flex-start" gap="md" wrap="nowrap">
                            <Card withBorder padding="xs" radius="md" w={280} style={{ flexShrink: 0 }}>
                                <ScrollArea h={420}>
                                    <Stack gap={2}>
                                        {codegen.files.map((file) => (
                                            <Tooltip key={file.path} label={file.description ?? file.path} position="right" openDelay={400}>
                                                <Button
                                                    size="compact-xs"
                                                    variant={selectedFile === file.path ? 'light' : 'subtle'}
                                                    justify="flex-start"
                                                    fullWidth
                                                    onClick={() => setSelectedFile(file.path)}
                                                    styles={{ label: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 11 } }}
                                                >
                                                    {file.path}
                                                </Button>
                                            </Tooltip>
                                        ))}
                                    </Stack>
                                </ScrollArea>
                            </Card>
                            <Card withBorder padding={0} radius="md" style={{ flex: 1, minWidth: 0 }}>
                                <ScrollArea h={420}>
                                    <Code block style={{ fontSize: 12, border: 'none' }}>
                                        {activeFile?.contents ?? '—'}
                                    </Code>
                                </ScrollArea>
                            </Card>
                        </Group>
                    ) : null}
                </Stack>
            </Tabs.Panel>

            {/* ── Import ──────────────────────────────────────────────── */}
            <Tabs.Panel value="import">
                <Stack gap="md">
                    <Alert variant="light" color="blue">
                        <Text size="sm">
                            An import lands as a <strong>draft</strong> on the agent with that key, never on the
                            published version — so importing can never change what <Code>/v1/responses</Code> is
                            currently serving. Always check the dry run first.
                        </Text>
                    </Alert>

                    <Group>
                        <FileButton
                            accept=".yaml,.yml,.json"
                            onChange={async (file) => {
                                if (!file) return;
                                setImportText(await file.text());
                                setImportPreview(null);
                            }}
                        >
                            {(props) => <Button {...props} size="xs" variant="default">Choose file…</Button>}
                        </FileButton>
                        <Button
                            size="xs"
                            variant="default"
                            onClick={() => void runImport(true)}
                            disabled={!importText.trim()}
                            loading={importBusy}
                        >
                            Dry run
                        </Button>
                        <Button
                            size="xs"
                            onClick={() => void runImport(false)}
                            disabled={!importText.trim() || !importPreview}
                            loading={importBusy}
                        >
                            {importPreview?.exists ? 'Overwrite draft' : 'Create agent'}
                        </Button>
                    </Group>

                    <Textarea
                        placeholder="Paste a YAML or JSON agent manifest…"
                        value={importText}
                        onChange={(event) => {
                            setImportText(event.currentTarget.value);
                            setImportPreview(null);
                        }}
                        autosize
                        minRows={12}
                        maxRows={24}
                        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
                    />

                    {importIssues.length > 0 ? (
                        <Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />} title="Manifest rejected">
                            <List size="sm" spacing={4}>
                                {importIssues.map((issue) => (
                                    <List.Item key={issue}>{issue}</List.Item>
                                ))}
                            </List>
                        </Alert>
                    ) : null}

                    {importPreview ? (
                        <Card withBorder padding="md" radius="md">
                            <Stack gap="sm">
                                <Group gap="xs">
                                    <Text size="sm" fw={600}>{importPreview.manifest.metadata.name}</Text>
                                    <Badge size="xs" variant="light" color={importPreview.exists ? 'yellow' : 'teal'}>
                                        {importPreview.exists ? 'will overwrite the existing draft' : 'will be created'}
                                    </Badge>
                                    {importPreview.missing.length > 0 ? (
                                        <Badge size="xs" variant="light" color="red">
                                            {importPreview.missing.length} missing
                                        </Badge>
                                    ) : (
                                        <Badge size="xs" variant="light" color="teal" leftSection={<IconCheck size={9} />}>
                                            all dependencies present
                                        </Badge>
                                    )}
                                </Group>

                                <Accordion variant="contained">
                                    <Accordion.Item value="deps">
                                        <Accordion.Control>
                                            <Text size="sm">Dependencies ({importPreview.dependencies.length})</Text>
                                        </Accordion.Control>
                                        <Accordion.Panel>
                                            <Stack gap={4}>
                                                {importPreview.dependencies.map((dep) => (
                                                    <Group key={`${dep.type}:${dep.key}`} gap="xs">
                                                        <Badge size="xs" variant="outline" color={dep.present ? 'teal' : 'red'}>
                                                            {dep.type}
                                                        </Badge>
                                                        <Text size="xs" ff="monospace">{dep.key}</Text>
                                                        <Text size="xs" c="dimmed">{dep.usedBy}</Text>
                                                    </Group>
                                                ))}
                                            </Stack>
                                        </Accordion.Panel>
                                    </Accordion.Item>
                                </Accordion>

                                {importPreview.missing.length > 0 ? (
                                    <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />}>
                                        <Text size="xs">
                                            The agent will still be written, but it cannot run until these exist in this
                                            project. Create them first, or import and fix the bindings afterwards.
                                        </Text>
                                    </Alert>
                                ) : null}
                            </Stack>
                        </Card>
                    ) : null}
                </Stack>
            </Tabs.Panel>
        </Tabs>
    );
}
