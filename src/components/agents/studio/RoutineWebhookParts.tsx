'use client';

/**
 * The webhook parts of the routine editor (SPEC-webhooks W8): the webhook
 * fields, the Connect card shown after a save (URL, the secret once, the
 * sender's setup steps, rotation), the Test tab (a sample delivery → dry run →
 * run) and the Deliveries tab (the delivery log).
 */

import { useCallback, useEffect, useState } from 'react';
import {
    ActionIcon,
    Alert,
    Badge,
    Box,
    Button,
    Card,
    Code,
    CopyButton,
    Group,
    List,
    PasswordInput,
    SegmentedControl,
    Select,
    SimpleGrid,
    Stack,
    Switch,
    Table,
    TagsInput,
    Text,
    Textarea,
    TextInput,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck, IconCopy, IconInfoCircle, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { FormField } from '@/components/common/ui/FormShell';
import { useConfirm } from '@/components/common/confirm';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
    WEBHOOK_ACTION_PATH,
    WEBHOOK_ACTION_SUGGESTIONS,
    WEBHOOK_EVENT_SUGGESTIONS,
    WEBHOOK_FILTER_EXAMPLES,
    WEBHOOK_FILTER_OPS,
    WEBHOOK_PRESET_AUTH,
    WEBHOOK_PRESETS,
    WEBHOOK_SAMPLES,
    WEBHOOK_TEMPLATE_VARIABLES,
    hasWebhookAuthorRule,
    type RoutineForm,
    type WebhookAuth,
    type WebhookFilterOp,
    type WebhookPreset,
} from './routineForm';

export const WEBHOOK_PRESET_LABEL_KEY: Record<WebhookPreset, string> = {
    github: 'presetGithub',
    gitlab: 'presetGitlab',
    azure_devops: 'presetAzureDevops',
    generic: 'presetGeneric',
};

const AUTH_LABEL_KEY: Record<WebhookAuth, string> = {
    github_signature: 'authGithubSignature',
    gitlab_token: 'authGitlabToken',
    standard_webhooks: 'authStandardWebhooks',
    basic: 'authBasic',
    header: 'authHeader',
    bearer: 'authBearer',
    signature: 'authSignature',
};

/** The message of an API error body (`{ error: { message } }`), else the status. */
async function errorMessage(res: Response): Promise<string> {
    const data = await res.json().catch(() => null) as { error?: { message?: string } | string } | null;
    const error = data?.error;
    if (typeof error === 'string') return error;
    return error?.message ?? `HTTP ${res.status}`;
}

const tag = (variable: string) => `{{${variable}}}`;

// ── Webhook fields ───────────────────────────────────────────────────────

export interface WebhookFieldsProps {
    form: RoutineForm;
    set: <K extends keyof RoutineForm>(key: K, value: RoutineForm[K]) => void;
    /** The stored routine already has a Standard Webhooks secret (an empty field keeps it). */
    storedStandardSecret: boolean;
    errorOf: (field: keyof RoutineForm) => string | undefined;
}

export function WebhookFields({ form, set, storedStandardSecret, errorOf }: WebhookFieldsProps) {
    const t = useTranslations('agents.routines');
    const preset = form.webhookPreset;
    const auths = WEBHOOK_PRESET_AUTH[preset];
    const actionPath = WEBHOOK_ACTION_PATH[preset];
    const ops = WEBHOOK_FILTER_OPS.map((op) => ({ value: op, label: t(`op_${op}`) }));

    const choosePreset = (next: WebhookPreset) => {
        set('webhookPreset', next);
        if (!WEBHOOK_PRESET_AUTH[next].includes(form.webhookAuth)) set('webhookAuth', WEBHOOK_PRESET_AUTH[next][0]);
        // Actions are per preset (their path differs).
        if (WEBHOOK_ACTION_PATH[next] !== WEBHOOK_ACTION_PATH[preset]) set('webhookActions', []);
    };
    const setRow = (index: number, patch: Partial<RoutineForm['webhookFilter'][number]>) =>
        set('webhookFilter', form.webhookFilter.map((row, at) => (at === index ? { ...row, ...patch } : row)));

    return (
        <Stack gap="md">
            <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
                {WEBHOOK_PRESETS.map((item) => (
                    <UnstyledButton key={item} onClick={() => choosePreset(item)} aria-pressed={preset === item}>
                        <Card withBorder padding="sm" radius="md" style={{ borderColor: preset === item ? 'var(--mantine-color-teal-6)' : undefined }}>
                            <Text size="sm" fw={600}>{t(WEBHOOK_PRESET_LABEL_KEY[item])}</Text>
                            <Text size="xs" c="dimmed">{t(`${WEBHOOK_PRESET_LABEL_KEY[item]}Hint`)}</Text>
                        </Card>
                    </UnstyledButton>
                ))}
            </SimpleGrid>

            <Group grow align="flex-start">
                <FormField label={t('webhookAuth')} required>
                    <Select
                        allowDeselect={false}
                        disabled={auths.length === 1}
                        value={form.webhookAuth}
                        data={auths.map((auth) => ({ value: auth, label: t(AUTH_LABEL_KEY[auth]) }))}
                        onChange={(value) => value && set('webhookAuth', value as WebhookAuth)}
                    />
                </FormField>
                {form.webhookAuth === 'header' ? (
                    <FormField label={t('webhookHeaderName')} hint={t('webhookHeaderNameHint')} required>
                        <TextInput ff="monospace" value={form.webhookHeaderName} onChange={(event) => set('webhookHeaderName', event.currentTarget.value)} />
                    </FormField>
                ) : null}
                {form.webhookAuth === 'standard_webhooks' ? (
                    <FormField label={t('webhookStandardSecret')} hint={t('webhookStandardSecretHint')} required={!storedStandardSecret}>
                        <PasswordInput
                            value={form.webhookSecret}
                            placeholder={storedStandardSecret ? t('callbackSecretStored') : 'whsec_…'}
                            error={errorOf('webhookSecret')}
                            onChange={(event) => set('webhookSecret', event.currentTarget.value)}
                        />
                    </FormField>
                ) : null}
            </Group>

            <FormField label={t('webhookEvents')} hint={t(preset === 'azure_devops' ? 'webhookEventsHintAzure' : 'webhookEventsHint')} optional>
                <TagsInput
                    value={form.webhookEvents}
                    data={[...WEBHOOK_EVENT_SUGGESTIONS[preset]]}
                    placeholder={t('webhookEventsPlaceholder')}
                    clearable
                    onChange={(value) => set('webhookEvents', value)}
                />
            </FormField>

            {actionPath ? (
                <FormField label={t('webhookActions')} hint={t('webhookActionsHint', { path: actionPath })} optional>
                    <TagsInput
                        value={form.webhookActions}
                        data={[...(WEBHOOK_ACTION_SUGGESTIONS[preset] ?? [])]}
                        clearable
                        onChange={(value) => set('webhookActions', value)}
                    />
                </FormField>
            ) : null}

            <Stack gap={6}>
                <Group justify="space-between">
                    <Text size="sm" fw={500}>{t('webhookFilter')}</Text>
                    <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={() => set('webhookFilter', [...form.webhookFilter, { path: 'payload.', op: 'eq', value: '' }])}>
                        {t('webhookFilterAdd')}
                    </Button>
                </Group>
                <Text size="xs" c="dimmed">{t('webhookFilterHint')}</Text>
                {form.webhookFilter.map((row, index) => (
                    <Group key={index} gap="xs" wrap="nowrap" align="flex-start">
                        <TextInput ff="monospace" style={{ flex: 2 }} value={row.path} aria-label={t('webhookFilterPath')} onChange={(event) => setRow(index, { path: event.currentTarget.value })} />
                        <Select style={{ flex: '0 0 190px' }} comboboxProps={{ width: 'max-content' }} allowDeselect={false} data={ops} value={row.op} aria-label={t('webhookFilterOp')} onChange={(value) => value && setRow(index, { op: value as WebhookFilterOp })} />
                        <TextInput
                            style={{ flex: 2 }}
                            disabled={row.op === 'exists' || row.op === 'not_exists'}
                            placeholder={row.op === 'in' || row.op === 'not_in' ? t('webhookFilterListPlaceholder') : ''}
                            value={row.value}
                            aria-label={t('webhookFilterValue')}
                            onChange={(event) => setRow(index, { value: event.currentTarget.value })}
                        />
                        <ActionIcon variant="subtle" color="red" mt={6} aria-label={t('delete')} onClick={() => set('webhookFilter', form.webhookFilter.filter((_, at) => at !== index))}>
                            <IconTrash size={14} />
                        </ActionIcon>
                    </Group>
                ))}
                {errorOf('webhookFilter') ? <Text size="xs" c="red">{errorOf('webhookFilter')}</Text> : null}
                {WEBHOOK_FILTER_EXAMPLES[preset].length > 0 ? (
                    <Group gap={6}>
                        <Text size="xs" c="dimmed">{t('webhookFilterExamples')}</Text>
                        {WEBHOOK_FILTER_EXAMPLES[preset].map((example) => (
                            <Badge key={example.key} component="button" type="button" variant="light" style={{ cursor: 'pointer' }} onClick={() => set('webhookFilter', [...form.webhookFilter, ...example.rows])}>
                                {t(example.key)}
                            </Badge>
                        ))}
                    </Group>
                ) : null}
                {preset !== 'generic' && !hasWebhookAuthorRule(form) ? (
                    <Alert color="yellow" variant="light" icon={<IconInfoCircle size={14} />}>{t('webhookAuthorHint')}</Alert>
                ) : null}
            </Stack>

            <Switch
                label={t('webhookIncludePayload')}
                description={t('webhookIncludePayloadHint')}
                checked={form.webhookIncludePayload}
                onChange={(event) => set('webhookIncludePayload', event.currentTarget.checked)}
            />
        </Stack>
    );
}

/** The variables a webhook prompt template may use, shown under the prompt. */
export function WebhookTemplateVariables() {
    const t = useTranslations('agents.routines');
    return (
        <Stack gap={4}>
            <Text size="xs" c="dimmed">{t('webhookVariables')}</Text>
            <Group gap={4}>
                {WEBHOOK_TEMPLATE_VARIABLES.map((variable) => <Code key={variable}>{tag(variable)}</Code>)}
            </Group>
        </Stack>
    );
}

// ── Connect card ─────────────────────────────────────────────────────────

function CopyValue({ value, label }: { value: string; label: string }) {
    const t = useTranslations('agents.routines');
    return (
        <Group gap="xs" wrap="nowrap">
            <Text size="xs" c="dimmed" w={70}>{label}</Text>
            <Code style={{ flex: 1, overflowWrap: 'anywhere' }}>{value}</Code>
            <CopyButton value={value}>
                {({ copied, copy }) => (
                    <Tooltip label={copied ? t('copied') : t('copy')} withArrow>
                        <ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} aria-label={t('copy')} onClick={copy}>
                            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                        </ActionIcon>
                    </Tooltip>
                )}
            </CopyButton>
        </Group>
    );
}

/** The sender's setup steps for the preset and auth mode. */
function ConnectSteps({ preset, auth, headerName }: { preset: WebhookPreset; auth: WebhookAuth; headerName: string }) {
    const t = useTranslations('agents.routines');
    const steps: Array<{ text: string; strong?: boolean }> = [];
    switch (preset) {
        case 'github':
            steps.push({ text: t('connectGithub1') }, { text: t('connectGithub2') }, { text: t('connectGithubContentType'), strong: true }, { text: t('connectGithub3') }, { text: t('connectGithub4') });
            break;
        case 'gitlab':
            steps.push({ text: t('connectGitlab1') }, { text: t('connectGitlab2') });
            steps.push({ text: t(auth === 'standard_webhooks' ? 'connectGitlabSigning' : 'connectGitlabToken') }, { text: t('connectGitlab3') });
            break;
        case 'azure_devops':
            steps.push({ text: t('connectAzure1') }, { text: t('connectAzure2') }, { text: t('connectAzureResource'), strong: true });
            steps.push({ text: auth === 'basic' ? t('connectAzureBasic') : t('connectAzureHeader', { header: headerName }) });
            break;
        default:
            steps.push({ text: t('connectGenericJson') });
            if (auth === 'bearer') steps.push({ text: t('connectGenericBearer') });
            else if (auth === 'signature') steps.push({ text: t('connectGenericSignature') });
            else if (auth === 'header') steps.push({ text: t('connectGenericHeader', { header: headerName }) });
            else steps.push({ text: t('connectGenericStandard') });
            steps.push({ text: t('connectGenericDedup') });
    }
    return (
        <List type="ordered" size="sm" spacing={4}>
            {steps.map((step) => (
                <List.Item key={step.text}>{step.strong ? <Text span size="sm" fw={700}>{step.text}</Text> : step.text}</List.Item>
            ))}
        </List>
    );
}

const GRACE_OPTIONS = [
    { value: '0', key: 'graceNow' },
    { value: '3600', key: 'grace1h' },
    { value: '86400', key: 'grace24h' },
] as const;
type GraceSeconds = (typeof GRACE_OPTIONS)[number]['value'];

export interface WebhookConnectCardProps {
    agentId: string;
    routineId: string;
    /** The stored routine's `webhook` object. */
    webhook: { url?: string; preset?: string; auth?: string; header_name?: string | null; secret_hint?: string; previous_secret_valid_until?: number | null };
    /** The secret from the answer that created / replaced it: shown this once. */
    revealedSecret: string | null;
    onSecret: (secret: string | null) => void;
}

export function WebhookConnectCard({ agentId, routineId, webhook, revealedSecret, onSecret }: WebhookConnectCardProps) {
    const t = useTranslations('agents.routines');
    const locale = useLocale();
    const { confirm } = useConfirm();
    const [grace, setGrace] = useState<GraceSeconds>('0');
    const [standardSecret, setStandardSecret] = useState('');
    const [rotating, setRotating] = useState(false);
    // What the stored routine says is the source of truth; a rotation answers with newer values, which hold only
    // until the routine itself is read again (a save that replaced the secret brings its own hint and grace).
    const storedState = `${webhook.secret_hint ?? ''}|${webhook.previous_secret_valid_until ?? ''}`;
    const [rotated, setRotated] = useState<{ base: string; hint: string; previousUntil: number | null } | null>(null);
    const latest = rotated && rotated.base === storedState ? rotated : null;
    const hint = latest ? latest.hint : webhook.secret_hint ?? '';
    const previousUntil = latest ? latest.previousUntil : webhook.previous_secret_valid_until ?? null;
    const preset = (WEBHOOK_PRESETS as readonly string[]).includes(webhook.preset ?? '') ? webhook.preset as WebhookPreset : 'generic';
    const auth = (webhook.auth ?? WEBHOOK_PRESET_AUTH[preset][0]) as WebhookAuth;
    const standard = auth === 'standard_webhooks';

    const rotate = async () => {
        const ok = await confirm({ title: t('rotateTitle'), message: t('rotateMessage'), confirmLabel: t('rotate') });
        if (!ok) return;
        setRotating(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/routines/${routineId}/webhook/rotate-secret`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ grace_seconds: Number(grace), ...(standard ? { secret: standardSecret.trim() } : {}) }),
            });
            if (!res.ok) throw new Error(await errorMessage(res));
            const data = await res.json() as { secret?: string; secret_hint: string; previous_valid_until: number | null };
            setRotated({ base: storedState, hint: data.secret_hint, previousUntil: data.previous_valid_until });
            setStandardSecret('');
            onSecret(data.secret ?? null);
            notifications.show({ color: 'teal', message: t('rotated') });
        } catch (error) {
            notifications.show({ color: 'red', message: t('rotateFailed', { message: error instanceof Error ? error.message : String(error) }) });
        } finally {
            setRotating(false);
        }
    };

    return (
        <Card withBorder radius="md" padding="md">
            <Stack gap="sm">
                <Text fw={600}>{t('connectTitle')}</Text>
                {webhook.url ? <CopyValue label={t('connectUrl')} value={webhook.url} /> : null}
                {revealedSecret ? (
                    <Stack gap={4}>
                        <CopyValue label={t('connectSecret')} value={revealedSecret} />
                        <Alert color="orange" variant="light" icon={<IconInfoCircle size={14} />}>{t('connectSecretOnce')}</Alert>
                    </Stack>
                ) : (
                    <Text size="xs" c="dimmed">{t(standard ? 'connectSecretProvided' : 'connectSecretHidden', { hint })}</Text>
                )}
                {previousUntil ? (
                    <Text size="xs" c="dimmed">{t('connectPreviousUntil', { time: new Date(previousUntil * 1000).toLocaleString(locale) })}</Text>
                ) : null}
                <ConnectSteps preset={preset} auth={auth} headerName={webhook.header_name ?? ''} />

                <Stack gap={6}>
                    <Text size="sm" fw={500}>{t('rotate')}</Text>
                    <Group gap="sm" align="flex-end">
                        <SegmentedControl
                            size="xs"
                            value={grace}
                            onChange={(value) => setGrace(value as GraceSeconds)}
                            data={GRACE_OPTIONS.map((option) => ({ value: option.value, label: t(option.key) }))}
                        />
                        {standard ? (
                            <PasswordInput size="xs" w={260} placeholder="whsec_…" aria-label={t('webhookStandardSecret')} value={standardSecret} onChange={(event) => setStandardSecret(event.currentTarget.value)} />
                        ) : null}
                        <Button size="xs" variant="light" color="orange" leftSection={<IconRefresh size={14} />} loading={rotating} disabled={standard && !standardSecret.trim()} onClick={() => void rotate()}>
                            {t('rotate')}
                        </Button>
                    </Group>
                    <Text size="xs" c="dimmed">{t('graceHint')}</Text>
                </Stack>
            </Stack>
        </Card>
    );
}

// ── Test tab ─────────────────────────────────────────────────────────────

interface DryRun {
    matched: boolean;
    reason: string | null;
    event: string | null;
    delivery_id: string | null;
    prompt: string | null;
    inputs: Record<string, unknown> | null;
    errors: Array<{ field: string; message: string }>;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
    try {
        const value = JSON.parse(text) as unknown;
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export function WebhookTestPanel({ agentId, routineId, preset }: { agentId: string; routineId: string; preset: WebhookPreset }) {
    const t = useTranslations('agents.routines');
    const sample = WEBHOOK_SAMPLES[preset];
    const [headersText, setHeadersText] = useState(() => JSON.stringify(sample.headers, null, 2));
    const [payloadText, setPayloadText] = useState(() => JSON.stringify(sample.payload, null, 2));
    const [result, setResult] = useState<DryRun | null>(null);
    const [busy, setBusy] = useState<'preview' | 'run' | null>(null);
    const headers = parseJsonObject(headersText);
    const payload = parseJsonObject(payloadText);

    const send = async (dryRun: boolean) => {
        if (!headers || !payload) return;
        setBusy(dryRun ? 'preview' : 'run');
        try {
            const res = await fetch(`/api/agents/${agentId}/routines/${routineId}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payload, headers, ...(dryRun ? { dry_run: true } : {}) }),
            });
            if (!res.ok) throw new Error(await errorMessage(res));
            const data = await res.json() as DryRun & { id?: string };
            if (dryRun) setResult(data);
            else notifications.show({ color: 'teal', message: t('runStarted', { id: data.id ?? '' }) });
        } catch (error) {
            notifications.show({ color: 'red', message: t('runFailed', { message: error instanceof Error ? error.message : String(error) }) });
        } finally {
            setBusy(null);
        }
    };

    return (
        <Stack gap="sm">
            <Text size="sm" c="dimmed">{t('testHint')}</Text>
            <Group grow align="flex-start">
                <Textarea label={t('testHeaders')} ff="monospace" autosize minRows={4} maxRows={10} value={headersText} error={headers ? undefined : t('invalidJson')} onChange={(event) => setHeadersText(event.currentTarget.value)} />
                <Textarea label={t('testPayload')} ff="monospace" autosize minRows={8} maxRows={24} value={payloadText} error={payload ? undefined : t('invalidJson')} onChange={(event) => setPayloadText(event.currentTarget.value)} />
            </Group>
            <Group gap="xs">
                <Button size="xs" variant="light" loading={busy === 'preview'} disabled={!headers || !payload} onClick={() => void send(true)}>{t('testPreview')}</Button>
                <Button size="xs" color="teal" loading={busy === 'run'} disabled={!headers || !payload} onClick={() => void send(false)}>{t('testRun')}</Button>
                <Button size="xs" variant="subtle" color="gray" onClick={() => { setHeadersText(JSON.stringify(sample.headers, null, 2)); setPayloadText(JSON.stringify(sample.payload, null, 2)); }}>
                    {t('testReset')}
                </Button>
            </Group>
            {result ? (
                <Card withBorder radius="md" padding="sm">
                    <Stack gap={6}>
                        <Group gap="xs">
                            <Badge color={result.matched ? 'teal' : 'gray'} variant="light">{t(result.matched ? 'testMatched' : 'testNotMatched')}</Badge>
                            {result.event ? <Text size="xs">{t('testEvent', { event: result.event })}</Text> : null}
                            {result.delivery_id ? <Text size="xs" c="dimmed">{t('testDelivery', { id: result.delivery_id })}</Text> : null}
                        </Group>
                        {result.reason ? <Text size="xs" c="dimmed">{result.reason}</Text> : null}
                        {result.errors.map((issue) => <Text key={`${issue.field}:${issue.message}`} size="xs" c="red">{issue.field}: {issue.message}</Text>)}
                        {result.inputs ? <Code block>{JSON.stringify(result.inputs, null, 2)}</Code> : null}
                        {result.prompt !== null ? <Code block style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto' }}>{result.prompt}</Code> : null}
                    </Stack>
                </Card>
            ) : null}
        </Stack>
    );
}

// ── Deliveries tab ───────────────────────────────────────────────────────

interface DeliveryRow {
    id: string;
    received_at: number;
    outcome: string;
    http_status: number;
    event: string | null;
    delivery_id: string | null;
    run_id: string | null;
    reason: string | null;
}

/** A dot and the outcome in words: readable at any width, and the contrast comes from the theme's text colors. */
const OUTCOME_COLOR: Record<string, string> = {
    accepted: 'teal', duplicate: 'blue', filtered: 'yellow', ignored: 'gray', unauthorized: 'red', rejected: 'orange', failed: 'red',
};

function OutcomeLabel({ outcome, label }: { outcome: string; label: string }) {
    const color = OUTCOME_COLOR[outcome] ?? 'gray';
    return (
        <Group gap={6} wrap="nowrap">
            <Box w={8} h={8} style={{ borderRadius: '50%', flexShrink: 0, background: `var(--mantine-color-${color}-6)` }} />
            <Text size="xs" fw={500} style={{ whiteSpace: 'nowrap' }}>{label}</Text>
        </Group>
    );
}

export function WebhookDeliveriesPanel({ agentId, routineId, onShowRuns }: { agentId: string; routineId: string; onShowRuns: () => void }) {
    const t = useTranslations('agents.routines');
    const locale = useLocale();
    const [rows, setRows] = useState<DeliveryRow[] | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);

    const load = useCallback(async (before?: string) => {
        setLoading(true);
        try {
            const query = new URLSearchParams({ limit: '20', ...(before ? { before } : {}) });
            const res = await fetch(`/api/agents/${agentId}/routines/${routineId}/deliveries?${query.toString()}`, { cache: 'no-store' });
            if (!res.ok) throw new Error(await errorMessage(res));
            const data = await res.json() as { data: DeliveryRow[]; has_more: boolean };
            setRows((prev) => (before ? [...(prev ?? []), ...data.data] : data.data));
            setHasMore(data.has_more);
            setLoadFailed(false);
        } catch {
            // A failed load is not "no deliveries": show the error with a retry, and keep rows already loaded.
            setLoadFailed(true);
            notifications.show({ color: 'red', message: t('deliveriesFailed') });
        } finally {
            setLoading(false);
        }
    }, [agentId, routineId, t]);

    useEffect(() => { void load(); }, [load]);

    return (
        <Stack gap="sm">
            <Group justify="space-between">
                <Text size="sm" c="dimmed">{t('deliveriesHint')}</Text>
                <Button size="xs" variant="subtle" leftSection={<IconRefresh size={14} />} loading={loading && rows !== null} onClick={() => void load()}>{t('refresh')}</Button>
            </Group>
            {loadFailed ? (
                <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} role="alert">
                    <Group justify="space-between" wrap="nowrap" gap="sm">
                        <Text size="sm">{t('deliveriesFailed')}</Text>
                        <Button size="compact-xs" variant="light" color="red" loading={loading} onClick={() => void load()}>{t('retry')}</Button>
                    </Group>
                </Alert>
            ) : null}
            {!loadFailed && rows && rows.length === 0 ? <Text size="sm" c="dimmed">{t('deliveriesEmpty')}</Text> : null}
            {rows && rows.length > 0 ? (
                <Table verticalSpacing={4} highlightOnHover>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th w={170}>{t('colReceived')}</Table.Th>
                            <Table.Th>{t('colEvent')}</Table.Th>
                            <Table.Th w={130}>{t('colOutcome')}</Table.Th>
                            <Table.Th w={60}>{t('colHttp')}</Table.Th>
                            <Table.Th>{t('colRun')}</Table.Th>
                            <Table.Th>{t('colReason')}</Table.Th>
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {rows.map((row) => (
                            <Table.Tr key={row.id}>
                                <Table.Td><Text size="xs">{new Date(row.received_at * 1000).toLocaleString(locale)}</Text></Table.Td>
                                <Table.Td>
                                    <Text size="xs">{row.event ?? t('none')}</Text>
                                    {row.delivery_id ? <Text size="xs" c="dimmed" ff="monospace" lineClamp={1}>{row.delivery_id}</Text> : null}
                                </Table.Td>
                                <Table.Td><OutcomeLabel outcome={row.outcome} label={t(`outcome_${row.outcome}`)} /></Table.Td>
                                <Table.Td><Text size="xs">{row.http_status}</Text></Table.Td>
                                <Table.Td>
                                    {row.run_id ? (
                                        <UnstyledButton onClick={onShowRuns}><Text size="xs" ff="monospace" c="teal">{row.run_id}</Text></UnstyledButton>
                                    ) : <Text size="xs" c="dimmed">{t('none')}</Text>}
                                </Table.Td>
                                <Table.Td><Text size="xs" c="dimmed">{row.reason ?? ''}</Text></Table.Td>
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            ) : null}
            {hasMore && rows ? (
                <Button size="xs" variant="subtle" loading={loading} onClick={() => void load(rows[rows.length - 1]?.id)}>{t('loadMore')}</Button>
            ) : null}
        </Stack>
    );
}
