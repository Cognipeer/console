'use client';

/**
 * Triggers of one agent: saved ways of starting it — a prompt (+ variables) and a
 * type (a schedule, one time, by hand, an incoming webhook or a connector event)
 * with that type's settings. Each fire is a background run; "Runs" opens
 * Sessions → Background runs filtered to the trigger.
 *
 * The editor is a full-screen FormShell; deleting asks through the shared
 * confirm dialog. A saved webhook trigger's editor stays open with its Connect
 * card (the secret is shown there once) and the Test / Deliveries tabs; a saved
 * connector trigger's with the subscription's status and the same two tabs. The
 * connector choice is offered only where the Connectors module is (the
 * enterprise parts behind `EnterpriseConnectorTriggerUi`). A webhook trigger of
 * a retired vendor preset is marked and can be converted to a connector trigger.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActionIcon,
    Alert,
    Badge,
    Box,
    Button,
    Group,
    NumberInput,
    PasswordInput,
    SegmentedControl,
    Select,
    Skeleton,
    Stack,
    Switch,
    Tabs,
    Text,
    Textarea,
    TextInput,
    Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle,
    IconCalendarTime,
    IconClockPlay,
    IconHandClick,
    IconHistory,
    IconInfoCircle,
    IconPencil,
    IconPlayerPlay,
    IconPlug,
    IconPlugConnected,
    IconPlus,
    IconRefresh,
    IconRepeat,
    IconTrash,
    IconWebhook,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import EmptyState from '@/components/common/EmptyState';
import FormShell, { FormField, FormRow, FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { useDeleteResource } from '@/components/common/confirm';
import {
    ConnectorTriggerPicker,
    ConnectorTriggerStatus,
    useConnectorTriggerCatalog,
    type ConnectorTriggerCatalogState,
} from '@/components/enterprise/EnterpriseConnectorTriggerUi';
import type { IAgentVariable } from '@/lib/database/provider/types.domain';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { ConnectorSecretReveal, ConnectorSubscriptionWire } from '@/lib/shared/connectorTriggers';
import { upcomingCronFires, validateTriggerCron } from '@/lib/services/agents/agentTriggerSchedule';
import {
    CONNECTOR_TEMPLATE_VARIABLES,
    CRON_PRESETS,
    TRIGGER_TYPES,
    connectorFormFromRetired,
    connectorTriggerLabel,
    emptyTriggerForm,
    formFromTrigger,
    isRetiredWebhook,
    rowsOnWebhookOnlyData,
    triggerBodyFromForm,
    timezoneOptions,
    webhookVariableText,
    webhookVariableValue,
    withTriggerLocale,
    type ConnectorTriggerRow,
    type TriggerForm,
    type TriggerFormProblem,
    type TriggerRow,
    type TriggerType,
} from './triggerForm';
import { ConnectorTestPanel } from './TriggerConnectorParts';
import {
    WEBHOOK_PRESET_LABEL_KEY,
    WebhookConnectCard,
    WebhookDeliveriesPanel,
    WebhookFields,
    WebhookFilterEditor,
    WebhookIncludePayload,
    WebhookTemplateVariables,
    WebhookTestPanel,
} from './TriggerWebhookParts';

export interface AgentTriggersPanelProps {
    agentId: string;
    agentName: string;
    /** The variables the agent declares (its draft; the server checks the version that runs). */
    declaredVariables?: IAgentVariable[];
    /** Saved versions, newest first, for the version select. */
    versions: number[];
    /** Open the runs this trigger started. */
    onShowRuns: (trigger: { id: string; name: string }) => void;
}

const TYPE_LABEL_KEY: Record<TriggerType, string> = {
    schedule: 'typeSchedule',
    once: 'typeOnce',
    manual: 'typeManual',
    webhook: 'typeWebhook',
    connector: 'typeConnector',
};

const TYPE_ICON: Record<TriggerType, ReactNode> = {
    schedule: <IconRepeat size={14} />,
    once: <IconClockPlay size={14} />,
    manual: <IconHandClick size={14} />,
    webhook: <IconWebhook size={14} />,
    connector: <IconPlug size={14} />,
};

const WEBHOOK_PROMPT_PLACEHOLDER = 'Review pull request #{{payload.number}}: {{payload.pull_request.title}}';
const CONNECTOR_PROMPT_PLACEHOLDER = 'Handle this {{event}} event and report what needs attention.';

/** The `webhook` settings object of a stored trigger, as far as the list summary reads it. */
type StoredWebhookSummary = { preset?: string; events?: string[] };

/** What an API error body (`{ error: { message, errors? } }`) says: the message, and the fields a validation failure names. */
async function readFailure(res: Response): Promise<{ message: string; fields: Array<{ field: string; message: string }> }> {
    const data = await res.json().catch(() => null) as { error?: { message?: string; errors?: Array<{ field: string; message: string }> } | string } | null;
    const error = data?.error;
    if (typeof error === 'string') return { message: error, fields: [] };
    return { message: error?.message ?? `HTTP ${res.status}`, fields: Array.isArray(error?.errors) ? error.errors : [] };
}

/** The message of an API error body, else the status. */
async function errorMessage(res: Response): Promise<string> {
    return (await readFailure(res)).message;
}

/** The subscription state a trigger answer carries (create, update and get-one answers of a connector trigger). */
const subscriptionOf = (row: TriggerRow) => (row as ConnectorTriggerRow).connector_subscription;

function formatInZone(date: Date, locale: string, timeZone?: string): string {
    try {
        return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(date);
    } catch {
        return date.toLocaleString(locale);
    }
}

const fromEpoch = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000) : null);

export default function AgentTriggersPanel({ agentId, agentName, declaredVariables, versions, onShowRuns }: AgentTriggersPanelProps) {
    const t = useTranslations('agents.triggers');
    const tConfirm = useTranslations('common.confirm');
    const locale = useLocale();
    const deleteResource = useDeleteResource();
    const [triggers, setTriggers] = useState<TriggerRow[] | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [editing, setEditing] = useState<{ trigger: TriggerRow | null; convert?: boolean } | null>(null);
    const catalog = useConnectorTriggerCatalog();

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/agents/${agentId}/triggers`, { cache: 'no-store' });
            if (!res.ok) throw new Error(await errorMessage(res));
            const data = await res.json() as { data: TriggerRow[] };
            setTriggers(data.data ?? []);
            setLoadFailed(false);
        } catch {
            // A failed first load is not "no triggers": the list stays unset and an error state with a retry shows.
            setLoadFailed(true);
            notifications.show({ color: 'red', message: t('loadFailed') });
        }
    }, [agentId, t]);

    useEffect(() => { void load(); }, [load]);

    const typeSummary = (trigger: TriggerRow): string => {
        if (trigger.type === 'webhook') {
            const webhook = trigger.webhook as StoredWebhookSummary;
            const preset = t(WEBHOOK_PRESET_LABEL_KEY[webhook.preset as keyof typeof WEBHOOK_PRESET_LABEL_KEY] ?? 'presetGeneric');
            return webhook.events && webhook.events.length > 0 ? `${preset} · ${webhook.events.join(', ')}` : t('summaryWebhookAny', { preset });
        }
        if (trigger.type === 'connector') {
            const connector = trigger.connector;
            const label = connectorTriggerLabel(connector, catalog.connectors);
            const summary = connector.events.length > 0 ? t('summaryConnector', { label, events: connector.events.join(', ') }) : t('summaryConnectorAny', { label });
            return connector.kind === 'poll' && connector.schedule ? `${summary} · ${connector.schedule.cron}` : summary;
        }
        if (trigger.type === 'schedule') return t('summarySchedule', { cron: trigger.schedule.cron ?? '', timezone: trigger.schedule.timezone ?? '' });
        if (trigger.type === 'once' && trigger.once.run_at) return t('summaryOnce', { time: formatInZone(new Date(trigger.once.run_at), locale) });
        return t('summaryManual');
    };

    const toggle = async (trigger: TriggerRow, enabled: boolean) => {
        setBusyId(trigger.id);
        try {
            const res = await fetch(`/api/agents/${agentId}/triggers/${trigger.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            });
            if (!res.ok) throw new Error(await errorMessage(res));
            await load();
        } catch (error) {
            notifications.show({ color: 'red', message: t('saveFailed', { message: error instanceof Error ? error.message : String(error) }) });
        } finally {
            setBusyId(null);
        }
    };

    const runNow = async (trigger: TriggerRow) => {
        setBusyId(trigger.id);
        try {
            const res = await fetch(`/api/agents/${agentId}/triggers/${trigger.id}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            if (!res.ok) throw new Error(await errorMessage(res));
            const run = await res.json() as { id: string };
            notifications.show({ color: 'teal', message: t('runStarted', { id: run.id }) });
            await load();
        } catch (error) {
            notifications.show({ color: 'red', message: t('runFailed', { message: error instanceof Error ? error.message : String(error) }) });
        } finally {
            setBusyId(null);
        }
    };

    const remove = async (trigger: TriggerRow) => {
        await deleteResource({
            noun: tConfirm('nouns.agentTrigger'),
            name: trigger.name,
            extraWarning: tConfirm('extras.agentTriggerStops'),
            action: async () => {
                const res = await fetch(`/api/agents/${agentId}/triggers/${trigger.id}`, { method: 'DELETE' });
                if (!res.ok) throw new Error(await errorMessage(res));
                await load();
            },
        });
    };

    return (
        <Stack gap="sm">
            <Group justify="flex-end">
                <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing({ trigger: null })}>
                    {t('add')}
                </Button>
            </Group>

            {triggers === null && !loadFailed ? (
                <Stack gap="xs">{[0, 1].map((i) => <Skeleton key={i} h={36} />)}</Stack>
            ) : triggers === null ? (
                <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} role="alert">
                    <Group justify="space-between" wrap="nowrap" gap="sm">
                        <Text size="sm">{t('loadFailed')}</Text>
                        <Button size="compact-xs" variant="light" color="red" onClick={() => { setLoadFailed(false); void load(); }}>{t('retry')}</Button>
                    </Group>
                </Alert>
            ) : triggers.length === 0 ? (
                <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} minHeight={160} />
            ) : (
                <Stack gap={0} role="list" aria-label={t('sectionTitle')}>
                    {triggers.map((trigger) => {
                        const next = fromEpoch(trigger.next_fire_at);
                        const last = fromEpoch(trigger.last_fire_at);
                        const triggerType: TriggerType = trigger.type in TYPE_LABEL_KEY ? trigger.type : 'manual';
                        const summary = typeSummary(trigger);
                        const retired = isRetiredWebhook(trigger);
                        const connectorKind = trigger.type === 'connector' && trigger.connector.kind === 'poll' ? 'poll' : 'webhook';
                        const typeLabel = trigger.type === 'connector' ? t(connectorKind === 'poll' ? 'kindConnectorPoll' : 'kindConnectorWebhook') : t(TYPE_LABEL_KEY[triggerType]);
                        const typeIcon = trigger.type === 'connector' ? (connectorKind === 'poll' ? <IconRefresh size={14} /> : <IconWebhook size={14} />) : TYPE_ICON[triggerType];
                        const connectorGone = trigger.type === 'connector' && !trigger.connector_available;
                        return (
                            <Group
                                key={trigger.id}
                                role="listitem"
                                gap="md"
                                wrap="wrap"
                                align="center"
                                py={8}
                                style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
                            >
                                <Stack gap={2} style={{ flex: '1 1 220px', minWidth: 0 }}>
                                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                                        <Text size="sm" fw={500} truncate title={trigger.name}>{trigger.name}</Text>
                                        {retired ? (
                                            <Tooltip label={t('retiredHint')} withArrow multiline maw={320}>
                                                <Badge color="orange" variant="light" size="sm" style={{ flexShrink: 0 }}>{t('retired')}</Badge>
                                            </Tooltip>
                                        ) : null}
                                        {connectorGone ? (
                                            <Tooltip label={t('connectorUnavailable')} withArrow multiline maw={320}>
                                                <Badge color="gray" variant="light" size="sm" style={{ flexShrink: 0 }}>{t('connectorUnavailableBadge')}</Badge>
                                            </Tooltip>
                                        ) : null}
                                    </Group>
                                    <Group gap={6} wrap="nowrap" c="dimmed" style={{ minWidth: 0 }}>
                                        <Tooltip label={typeLabel} withArrow>
                                            <Box component="span" role="img" aria-label={typeLabel} style={{ display: 'inline-flex', flexShrink: 0 }}>
                                                {typeIcon}
                                            </Box>
                                        </Tooltip>
                                        <Text size="xs" c="dimmed" ff={triggerType === 'schedule' ? 'monospace' : undefined} truncate title={summary}>{summary}</Text>
                                    </Group>
                                    {trigger.description ? <Text size="xs" c="dimmed" lineClamp={1}>{trigger.description}</Text> : null}
                                </Stack>
                                <Stack gap={2} style={{ flex: '0 0 200px' }}>
                                    <Text size="xs" c="dimmed" truncate>{t('colNext')}: <Text span size="xs" c="var(--mantine-color-text)">{next ? formatInZone(next, locale) : t('none')}</Text></Text>
                                    <Group gap={6} wrap="nowrap">
                                        <Text size="xs" c="dimmed" truncate>
                                            {t('colLast')}: <Text span size="xs" c="var(--mantine-color-text)">{last ? formatInZone(last, locale) : t('never')}</Text>
                                        </Text>
                                        {last && trigger.last_status ? (
                                            <Tooltip label={trigger.last_error ?? ''} disabled={!trigger.last_error} withArrow multiline maw={360}>
                                                <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                                                    <Box
                                                        w={8}
                                                        h={8}
                                                        style={{ borderRadius: '50%', background: trigger.last_status === 'failed' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-teal-6)' }}
                                                    />
                                                    <Text size="xs" fw={500} c={trigger.last_status === 'failed' ? 'var(--mantine-color-red-light-color)' : 'var(--mantine-color-teal-light-color)'}>
                                                        {t(trigger.last_status === 'failed' ? 'statusFailed' : 'statusStarted')}
                                                    </Text>
                                                </Group>
                                            </Tooltip>
                                        ) : null}
                                    </Group>
                                </Stack>
                                <Group gap="xs" wrap="nowrap" style={{ flex: '0 0 auto' }}>
                                    <Switch
                                        size="xs"
                                        checked={trigger.enabled}
                                        disabled={busyId === trigger.id}
                                        aria-label={`${t('colEnabled')}: ${trigger.name}`}
                                        onChange={(event) => void toggle(trigger, event.currentTarget.checked)}
                                    />
                                    <Group gap={2} wrap="nowrap">
                                        {retired && catalog.available ? (
                                            <Tooltip label={t('convert')} withArrow>
                                                <ActionIcon size="sm" variant="subtle" color="orange" aria-label={t('convert')} onClick={() => setEditing({ trigger, convert: true })}>
                                                    <IconPlugConnected size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                        ) : null}
                                        {retired || connectorGone ? null : (
                                            <Tooltip label={t('runNow')} withArrow>
                                                <ActionIcon size="sm" variant="subtle" color="teal" loading={busyId === trigger.id} aria-label={t('runNow')} onClick={() => void runNow(trigger)}>
                                                    <IconPlayerPlay size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                        )}
                                        <Tooltip label={t('history')} withArrow>
                                            <ActionIcon size="sm" variant="subtle" color="gray" aria-label={t('history')} onClick={() => onShowRuns({ id: trigger.id, name: trigger.name })}>
                                                <IconHistory size={14} />
                                            </ActionIcon>
                                        </Tooltip>
                                        <Tooltip label={t('edit')} withArrow>
                                            <ActionIcon size="sm" variant="subtle" color="gray" aria-label={t('edit')} onClick={() => setEditing({ trigger })}>
                                                <IconPencil size={14} />
                                            </ActionIcon>
                                        </Tooltip>
                                        <Tooltip label={t('delete')} withArrow>
                                            <ActionIcon size="sm" variant="subtle" color="red" aria-label={t('delete')} onClick={() => void remove(trigger)}>
                                                <IconTrash size={14} />
                                            </ActionIcon>
                                        </Tooltip>
                                    </Group>
                                </Group>
                            </Group>
                        );
                    })}
                </Stack>
            )}

            {editing ? (
                <TriggerEditor
                    agentId={agentId}
                    agentName={agentName}
                    trigger={editing.trigger}
                    convert={editing.convert}
                    catalog={catalog}
                    declaredVariables={declaredVariables}
                    versions={versions}
                    onClose={() => setEditing(null)}
                    onSaved={(saved, keepOpen) => {
                        // A webhook or connector trigger stays open on the saved row: its Connect card or status holds the URL and the secret.
                        setEditing(keepOpen ? { trigger: saved } : null);
                        notifications.show({ color: 'teal', message: t('saved') });
                        void load();
                    }}
                    onShowRuns={onShowRuns}
                />
            ) : null}
        </Stack>
    );
}

// ── Editor ───────────────────────────────────────────────────────────────

interface TriggerEditorProps {
    agentId: string;
    agentName: string;
    trigger: TriggerRow | null;
    /** Edit a retired vendor webhook trigger as the connector trigger that replaces it. */
    convert?: boolean;
    catalog: ConnectorTriggerCatalogState;
    declaredVariables?: IAgentVariable[];
    versions: number[];
    onClose: () => void;
    onSaved: (trigger: TriggerRow, keepOpen: boolean) => void;
    onShowRuns: (trigger: { id: string; name: string }) => void;
}

type EditorTab = 'settings' | 'test' | 'deliveries';

function TriggerEditor({ agentId, agentName, trigger, convert, catalog, declaredVariables, versions, onClose, onSaved, onShowRuns }: TriggerEditorProps) {
    const t = useTranslations('agents.triggers');
    const locale = useLocale();
    const [form, setForm] = useState<TriggerForm>(() => (trigger ? (convert ? connectorFormFromRetired(trigger) : formFromTrigger(trigger)) : emptyTriggerForm()));
    const [problem, setProblem] = useState<TriggerFormProblem | null>(null);
    /** Field errors the server named for the connector part, keyed like its answer (`connector.params.<key>`). */
    const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [tab, setTab] = useState<EditorTab>('settings');
    /** The webhook secret from the last save / rotation: shown once, never read back. */
    const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
    const retired = trigger ? isRetiredWebhook(trigger) : false;
    // A retired trigger receives nothing: no Connect card, no Test, no deliveries.
    const storedWebhook = trigger?.type === 'webhook' && !retired ? trigger.webhook as Parameters<typeof WebhookConnectCard>[0]['webhook'] : null;
    const savedConnector = trigger?.type === 'connector' ? trigger : null;
    const savedId = trigger?.id;
    /** The subscription of a saved connector trigger. Lists do not carry it; a create / update answer does (with the secret, once). */
    const [subscription, setSubscription] = useState<ConnectorSubscriptionWire | null | undefined>(() => (trigger ? subscriptionOf(trigger) : undefined));
    /** The signing secret a save or a rotation showed once. Kept here, not in the card: the tabs unmount it. It belongs to one subscription. */
    const [reveal, setReveal] = useState<ConnectorSecretReveal | null>(null);
    const subscriptionId = subscription?.subscription_id ?? null;
    const currentReveal = reveal && reveal.subscriptionId === subscriptionId ? reveal : null;
    const zones = useMemo(() => timezoneOptions(), []);
    const set = <K extends keyof TriggerForm>(key: K, value: TriggerForm[K]) => {
        setForm((prev) => ({ ...prev, [key]: value }));
        setProblem(null);
        setServerErrors({});
    };
    const errorOf = (field: TriggerFormProblem['field']) => (problem?.field === field ? t(problem.key) : undefined);
    const connectorErrors: Record<string, string> = {
        ...serverErrors,
        // The one thing the form refuses on the connector choice is a missing pick; the schedule is judged by the server.
        ...(problem?.field === 'connector' ? { 'connector.connector_id': t(problem.key) } : {}),
    };

    /**
     * Counts the reads of the trigger and the answers that outrank them. Reads are not answered in the order they are asked (a slow
     * link, a retry and a rotation close together), and a save, a retry or a rotation answers with the subscription it left: only the
     * newest of all of these may set the subscription, or a late read of an older row would take the one-time secret off the screen.
     */
    const reads = useRef(0);
    /** The subscription a save, a retry or a rotation answered with: shown now, and no read that began before it may replace it. */
    const showAnswered = (answered: ConnectorSubscriptionWire | null) => {
        reads.current += 1;
        setSubscription(answered);
    };

    const loadSubscription = useCallback(async () => {
        if (!savedId) return;
        const mine = ++reads.current;
        try {
            const res = await fetch(withTriggerLocale(`/api/agents/${agentId}/triggers/${savedId}`, locale), { cache: 'no-store' });
            if (!res.ok) return;
            const read = subscriptionOf(await res.json() as TriggerRow) ?? null;
            if (mine === reads.current) setSubscription(read);
        } catch {
            // The status stays as it was; the next open or retry reads it again.
        }
    }, [agentId, savedId, locale]);

    const needsSubscription = Boolean(savedConnector) && subscription === undefined;
    useEffect(() => { if (needsSubscription) void loadSubscription(); }, [needsSubscription, loadSubscription]);

    const preview = useMemo(() => {
        if (form.type !== 'schedule' || validateTriggerCron(form.cron)) return null;
        return upcomingCronFires(form.cron, form.timezone, new Date(), 3);
    }, [form.type, form.cron, form.timezone]);

    const save = async () => {
        const built = triggerBodyFromForm(form, declaredVariables, trigger);
        if (!built.ok) {
            setProblem(built.problem);
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(withTriggerLocale(trigger ? `/api/agents/${agentId}/triggers/${trigger.id}` : `/api/agents/${agentId}/triggers`, locale), {
                method: trigger ? 'PATCH' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(built.body),
            });
            if (!res.ok) {
                const failure = await readFailure(res);
                setServerErrors(Object.fromEntries(failure.fields.filter((issue) => issue.field.startsWith('connector')).map((issue) => [issue.field, issue.message])));
                notifications.show({ color: 'red', message: t('saveFailed', { message: failure.message }) });
                return;
            }
            const saved = await res.json() as TriggerRow;
            const keepOpen = saved.type === 'webhook' || saved.type === 'connector';
            if (saved.type === 'connector') {
                // The editor stays open on the saved row, so the form shows what was stored, as the status card does (a schedule field
                // left empty is the package's own schedule now).
                setForm(formFromTrigger(saved));
                const answered = subscriptionOf(saved) ?? null;
                showAnswered(answered);
                // The answer that created the hook shows its secret once; a later read of the trigger does not.
                if (answered?.secret) setReveal({ subscriptionId: answered.subscription_id, secret: answered.secret, previousValidUntil: answered.previous_secret_valid_until ?? null });
            }
            if (saved.type === 'webhook') {
                // The answer that created or replaced a generated secret carries it in `webhook.secret` — shown once.
                const secret = (saved.webhook as { secret?: string }).secret;
                if (secret) setRevealedSecret(secret);
                setForm((prev) => ({ ...prev, webhookSecret: '' }));
            }
            onSaved(saved, keepOpen);
        } catch (error) {
            notifications.show({ color: 'red', message: t('saveFailed', { message: error instanceof Error ? error.message : String(error) }) });
        } finally {
            setSaving(false);
        }
    };

    /** "Connector · Trigger" for the summary, from the catalog; the trigger's own name until the catalog has it. */
    function connectorSummary(): string {
        const picked = form.connector;
        if (!picked) return t('typeConnector');
        const entry = catalog.connectors.find((item) => item.id === picked.connectorId);
        const title = entry?.triggers.find((item) => item.name === picked.trigger)?.title ?? picked.trigger;
        return [entry?.name, title, ...picked.events].filter(Boolean).join(' · ');
    }

    const typeSummary = form.type === 'schedule'
        ? `${form.cron} (${form.timezone})`
        : form.type === 'once'
            ? (form.onceMode === 'in' ? `+${form.delayAmount} ${t(form.delayUnit)}` : form.runAtLocal.replace('T', ' '))
            : form.type === 'webhook'
                ? [t(WEBHOOK_PRESET_LABEL_KEY[form.webhookPreset]), ...form.webhookEvents].join(' · ')
                : form.type === 'connector'
                    ? connectorSummary()
                    : t('typeManual');
    const webhook = form.type === 'webhook';
    const connector = form.type === 'connector';
    /** A converted trigger's filter rows on data a connector event lacks: the ones that match nothing and the ones that match everything. */
    const webhookOnlyRows = convert ? rowsOnWebhookOnlyData(form.webhookFilter) : null;
    /** A webhook's and a connector trigger's prompt is a template over the event, and its variables a mapping. */
    const eventDriven = webhook || connector;
    const declared = declaredVariables ?? [];
    // Connector triggers are offered where the module is; an existing one stays selectable so it can be seen and removed.
    const offeredTypes = TRIGGER_TYPES.filter((type) => type !== 'connector' || catalog.available || connector);

    const settings = (
        <>
            <FormSection number={1} title={t('sectionBasics')} description={t('sectionBasicsDescription')}>
                <FormField label={t('name')} required>
                    <TextInput value={form.name} placeholder={t('namePlaceholder')} error={errorOf('name')} onChange={(event) => set('name', event.currentTarget.value)} />
                </FormField>
                <FormField label={t('description')} optional>
                    <TextInput value={form.description} onChange={(event) => set('description', event.currentTarget.value)} />
                </FormField>
                <Switch label={t('enabled')} description={t('enabledHint')} checked={form.enabled} onChange={(event) => set('enabled', event.currentTarget.checked)} />
            </FormSection>

            <FormSection number={2} title={t('sectionType')} description={t('sectionTypeDescription')}>
                {retired && !convert ? <Alert color="orange" variant="light" icon={<IconAlertTriangle size={14} />}>{t('retiredNotice')}</Alert> : null}
                {convert && form.type === 'connector' ? <Alert color="orange" variant="light" icon={<IconAlertTriangle size={14} />}>{t('convertNotice')}</Alert> : null}
                <SegmentedControl
                    value={form.type}
                    onChange={(value) => set('type', value as TriggerType)}
                    data={offeredTypes.map((type) => ({ value: type, label: t(TYPE_LABEL_KEY[type]) }))}
                />
                {form.type === 'schedule' ? (
                    <Stack gap="sm">
                        <FormRow>
                            <FormField label={t('cron')} hint={t('cronHint')} required>
                                <TextInput ff="monospace" value={form.cron} error={errorOf('cron')} onChange={(event) => set('cron', event.currentTarget.value)} />
                            </FormField>
                            <FormField label={t('timezone')} required>
                                <Select searchable allowDeselect={false} data={zones} value={form.timezone} onChange={(value) => value && set('timezone', value)} />
                            </FormField>
                        </FormRow>
                        <Group gap={6}>
                            <Text size="xs" c="dimmed">{t('presets')}</Text>
                            {CRON_PRESETS.map((preset) => (
                                <Badge
                                    key={preset.cron}
                                    component="button"
                                    type="button"
                                    aria-pressed={form.cron === preset.cron}
                                    variant={form.cron === preset.cron ? 'filled' : 'light'}
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => set('cron', preset.cron)}
                                >
                                    {t(preset.key)}
                                </Badge>
                            ))}
                        </Group>
                        {preview ? (
                            <Stack gap={2}>
                                <Text size="xs" fw={500}>{t('preview')}</Text>
                                {preview.map((date) => (
                                    <Text key={date.toISOString()} size="xs" c="dimmed">
                                        {formatInZone(date, locale, form.timezone)} · {t('previewLocal', { time: formatInZone(date, locale) })}
                                    </Text>
                                ))}
                            </Stack>
                        ) : (
                            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={14} />}>{t('previewInvalid')}</Alert>
                        )}
                    </Stack>
                ) : null}
                {form.type === 'once' ? (
                    <Stack gap="sm">
                        <SegmentedControl
                            size="xs"
                            w="fit-content"
                            value={form.onceMode}
                            onChange={(value) => set('onceMode', value as TriggerForm['onceMode'])}
                            data={[{ value: 'in', label: t('onceIn') }, { value: 'at', label: t('onceAt') }]}
                        />
                        {form.onceMode === 'at' ? (
                            <FormField label={t('runAt')} required>
                                <TextInput type="datetime-local" value={form.runAtLocal} error={errorOf('runAtLocal')} onChange={(event) => set('runAtLocal', event.currentTarget.value)} />
                            </FormField>
                        ) : (
                            <FormRow>
                                <FormField label={t('delay')} required>
                                    <NumberInput min={1} value={form.delayAmount} error={errorOf('delayAmount')} onChange={(value) => set('delayAmount', Number(value))} />
                                </FormField>
                                <FormField label={t('delayUnit')}>
                                    <Select
                                        allowDeselect={false}
                                        value={form.delayUnit}
                                        data={[{ value: 'minutes', label: t('minutes') }, { value: 'hours', label: t('hours') }]}
                                        onChange={(value) => value && set('delayUnit', value as TriggerForm['delayUnit'])}
                                    />
                                </FormField>
                            </FormRow>
                        )}
                    </Stack>
                ) : null}
                {form.type === 'manual' ? <Text size="sm" c="dimmed">{t('manualHint')}</Text> : null}
                {webhook ? (
                    <WebhookFields
                        form={form}
                        set={set}
                        storedStandardSecret={(storedWebhook as { auth?: string } | null)?.auth === 'standard_webhooks'}
                        errorOf={errorOf}
                    />
                ) : null}
                {connector ? (
                    <Stack gap="md">
                        {catalog.available ? (
                            <>
                                {catalog.error ? (
                                    <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} role="alert">
                                        <Group justify="space-between" wrap="nowrap" gap="sm">
                                            <Text size="sm">{t('connectorCatalogFailed')}</Text>
                                            <Button size="compact-xs" variant="light" color="red" onClick={() => catalog.reload()}>{t('retry')}</Button>
                                        </Group>
                                    </Alert>
                                ) : null}
                                <ConnectorTriggerPicker value={form.connector} onChange={(value) => set('connector', value)} errors={connectorErrors} disabled={saving} />
                                <WebhookFilterEditor
                                    form={form}
                                    set={set}
                                    errorOf={errorOf}
                                    flagged={webhookOnlyRows ? [
                                        { rows: webhookOnlyRows.never, reason: t('convertRowHint') },
                                        { rows: webhookOnlyRows.always, reason: t('convertRowAlwaysHint') },
                                    ] : undefined}
                                />
                                <WebhookIncludePayload form={form} set={set} />
                            </>
                        ) : catalog.loading ? (
                            // The first answer is on its way: not "unavailable" yet.
                            <Stack gap="xs" aria-busy="true" data-testid="connector-catalog-loading">{[0, 1].map((i) => <Skeleton key={i} h={36} />)}</Stack>
                        ) : (
                            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={14} />}>
                                {catalog.forbidden ? t('connectorForbidden') : t('connectorUnavailable')}
                            </Alert>
                        )}
                        <Alert color="blue" variant="light" icon={<IconInfoCircle size={14} />}>{t('connectorUnattendedHint')}</Alert>
                    </Stack>
                ) : null}
            </FormSection>

            <FormSection number={3} title={t('sectionPrompt')} description={t('sectionPromptDescription')}>
                <FormField label={t('prompt')} hint={t(eventDriven ? 'webhookPromptHint' : 'promptHint')}>
                    <Textarea
                        autosize
                        minRows={4}
                        maxRows={14}
                        ff={eventDriven ? 'monospace' : undefined}
                        value={form.prompt}
                        placeholder={webhook ? WEBHOOK_PROMPT_PLACEHOLDER : connector ? CONNECTOR_PROMPT_PLACEHOLDER : t('promptPlaceholder')}
                        onChange={(event) => set('prompt', event.currentTarget.value)}
                    />
                </FormField>
                {webhook ? <WebhookTemplateVariables /> : null}
                {connector ? <WebhookTemplateVariables variables={CONNECTOR_TEMPLATE_VARIABLES} /> : null}
                {declared.length > 0 && eventDriven ? (
                    <Stack gap="sm">
                        <Text size="sm" fw={500}>{t('variablesTitle')}</Text>
                        <Text size="xs" c="dimmed">{t('webhookVariablesHint')}</Text>
                        {declared.map((field) => (
                            <TextInput
                                key={field.name}
                                label={field.label || field.name}
                                description={field.description}
                                required={field.required}
                                ff="monospace"
                                placeholder={t('variableUnset')}
                                value={webhookVariableText(form.variables[field.name])}
                                onChange={(event) => {
                                    const text = event.currentTarget.value;
                                    set('variables', { ...form.variables, [field.name]: text === '' ? undefined : webhookVariableValue(field, text) });
                                }}
                            />
                        ))}
                    </Stack>
                ) : null}
                {declared.length > 0 && !eventDriven ? (
                    <Stack gap="sm">
                        <Text size="sm" fw={500}>{t('variablesTitle')}</Text>
                        <Text size="xs" c="dimmed">{t('variablesHint')}</Text>
                        {declared.map((field) => (
                            <VariableValueField
                                key={field.name}
                                field={field}
                                value={form.variables[field.name]}
                                onChange={(value) => set('variables', { ...form.variables, [field.name]: value })}
                            />
                        ))}
                    </Stack>
                ) : null}
            </FormSection>

            <FormSection number={4} title={t('sectionRun')} description={t('sectionRunDescription')} collapsible defaultOpen={Boolean(trigger)}>
                <FormRow>
                    <FormField label={t('version')}>
                        <Select
                            allowDeselect={false}
                            value={form.version === null ? 'published' : String(form.version)}
                            data={[{ value: 'published', label: t('versionPublished') }, ...versions.map((n) => ({ value: String(n), label: t('versionN', { n }) }))]}
                            onChange={(value) => set('version', !value || value === 'published' ? null : Number(value))}
                        />
                    </FormField>
                    <FormField label={t('class')} hint={t(eventDriven ? 'webhookClassHint' : 'classHint')}>
                        <SegmentedControl
                            value={form.runClass}
                            onChange={(value) => set('runClass', value as TriggerForm['runClass'])}
                            data={[{ value: 'default', label: t('classDefault') }, { value: 'deferred', label: t('classDeferred') }]}
                        />
                    </FormField>
                </FormRow>
                <FormField label={t('metadata')} hint={t('metadataHint')} optional>
                    <Textarea ff="monospace" autosize minRows={2} value={form.metadataText} error={errorOf('metadataText')} onChange={(event) => set('metadataText', event.currentTarget.value)} />
                </FormField>
                <FormRow>
                    <FormField label={t('callbackUrl')} hint={t('callbackHint')} optional>
                        <TextInput value={form.callbackUrl} placeholder="https://" onChange={(event) => set('callbackUrl', event.currentTarget.value)} />
                    </FormField>
                    <FormField label={t('callbackSecret')} optional>
                        <PasswordInput
                            value={form.callbackSecret}
                            placeholder={form.callbackSigned ? t('callbackSecretStored') : ''}
                            onChange={(event) => set('callbackSecret', event.currentTarget.value)}
                        />
                    </FormField>
                </FormRow>
                <FormField label={t('responseFormat')} hint={t('responseFormatHint')} optional>
                    <Textarea ff="monospace" autosize minRows={3} maxRows={14} value={form.responseFormatText} error={errorOf('responseFormatText')} onChange={(event) => set('responseFormatText', event.currentTarget.value)} />
                </FormField>
            </FormSection>
        </>
    );

    return (
        <FormShell
            open
            onClose={onClose}
            icon={<IconCalendarTime size={16} />}
            title={trigger ? t('titleEdit') : t('titleNew')}
            subtitle={t('subtitle', { agent: agentName })}
            primaryAction={{ label: t('save'), color: 'teal', loading: saving, onClick: () => void save() }}
            secondaryAction={{ label: t('cancel'), onClick: onClose }}
            summary={(
                <SummaryGroup title={t('summaryTitle')}>
                    <SummaryKV label={t('summaryType')} value={typeSummary} mono={form.type === 'schedule'} />
                    {preview && preview[0] ? <SummaryKV label={t('summaryNext')} value={formatInZone(preview[0], locale)} /> : null}
                    <SummaryKV label={t('summaryVersion')} value={form.version === null ? t('versionPublished') : t('versionN', { n: form.version })} />
                    <SummaryKV label={t('summaryClass')} value={t(form.runClass === 'deferred' ? 'classDeferred' : 'classDefault')} />
                </SummaryGroup>
            )}
        >
            {trigger && (storedWebhook || savedConnector) ? (
                <Tabs value={tab} onChange={(value) => setTab((value as EditorTab | null) ?? 'settings')} keepMounted={false}>
                    <Tabs.List mb="md">
                        <Tabs.Tab value="settings">{t('tabSettings')}</Tabs.Tab>
                        <Tabs.Tab value="test">{t('tabTest')}</Tabs.Tab>
                        <Tabs.Tab value="deliveries">{t('tabDeliveries')}</Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panel value="settings">
                        <Stack gap="md">
                            {storedWebhook ? (
                                <WebhookConnectCard
                                    agentId={agentId}
                                    triggerId={trigger.id}
                                    webhook={storedWebhook}
                                    revealedSecret={revealedSecret}
                                    onSecret={setRevealedSecret}
                                />
                            ) : null}
                            {savedConnector ? (
                                <ConnectorTriggerStatus
                                    agentId={agentId}
                                    triggerId={trigger.id}
                                    subscription={subscription ?? null}
                                    onChanged={(answered?: ConnectorSubscriptionWire | null) => {
                                        // A retry or a rotation hands over the subscription its answer carried: it shows now, and the read confirms it.
                                        if (answered?.subscription_id) showAnswered(answered);
                                        void loadSubscription();
                                    }}
                                    reveal={currentReveal}
                                    onReveal={setReveal}
                                />
                            ) : null}
                            {settings}
                        </Stack>
                    </Tabs.Panel>
                    <Tabs.Panel value="test">
                        {savedConnector ? (
                            <ConnectorTestPanel agentId={agentId} triggerId={trigger.id} connectorId={savedConnector.connector.connector_id} trigger={savedConnector.connector.trigger} />
                        ) : (
                            <WebhookTestPanel agentId={agentId} triggerId={trigger.id} preset={form.webhookPreset} />
                        )}
                    </Tabs.Panel>
                    <Tabs.Panel value="deliveries">
                        <WebhookDeliveriesPanel agentId={agentId} triggerId={trigger.id} connector={Boolean(savedConnector)} onShowRuns={() => onShowRuns({ id: trigger.id, name: trigger.name })} />
                    </Tabs.Panel>
                </Tabs>
            ) : settings}
        </FormShell>
    );
}

/** One declared variable's value: a field for its type; empty = not set (the default applies). */
function VariableValueField({ field, value, onChange }: { field: IAgentVariable; value: unknown; onChange: (value: unknown) => void }) {
    const t = useTranslations('agents.triggers');
    const label = field.label || field.name;
    const common = { label, description: field.description, required: field.required };
    if (field.enum && field.enum.length > 0) {
        return (
            <Select
                {...common}
                clearable
                placeholder={t('variableUnset')}
                value={value === undefined || value === null ? null : String(value)}
                data={field.enum.map(String)}
                onChange={(next) => onChange(next === null ? undefined : field.type === 'string' ? next : Number(next))}
            />
        );
    }
    switch (field.type) {
        case 'number':
        case 'integer':
            return (
                <NumberInput
                    {...common}
                    allowDecimal={field.type === 'number'}
                    placeholder={t('variableUnset')}
                    value={typeof value === 'number' ? value : ''}
                    onChange={(next) => onChange(next === '' ? undefined : Number(next))}
                />
            );
        case 'boolean':
            return (
                <Select
                    {...common}
                    clearable
                    placeholder={t('variableUnset')}
                    value={value === true ? 'true' : value === false ? 'false' : null}
                    data={[{ value: 'true', label: t('variableYes') }, { value: 'false', label: t('variableNo') }]}
                    onChange={(next) => onChange(next === null ? undefined : next === 'true')}
                />
            );
        case 'json':
            return <JsonVariableValue field={field} value={value} onChange={onChange} />;
        default:
            return (
                <TextInput
                    {...common}
                    placeholder={t('variableUnset')}
                    value={typeof value === 'string' ? value : ''}
                    onChange={(event) => onChange(event.currentTarget.value === '' ? undefined : event.currentTarget.value)}
                />
            );
    }
}

function JsonVariableValue({ field, value, onChange }: { field: IAgentVariable; value: unknown; onChange: (value: unknown) => void }) {
    const t = useTranslations('agents.triggers');
    const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
    const [invalid, setInvalid] = useState(false);
    return (
        <Textarea
            label={field.label || field.name}
            description={field.description}
            required={field.required}
            ff="monospace"
            autosize
            minRows={2}
            placeholder={t('variableUnset')}
            value={text}
            error={invalid ? t('invalidJson') : undefined}
            onChange={(event) => {
                const next = event.currentTarget.value;
                setText(next);
                if (!next.trim()) {
                    setInvalid(false);
                    onChange(undefined);
                    return;
                }
                try {
                    onChange(JSON.parse(next));
                    setInvalid(false);
                } catch {
                    setInvalid(true);
                }
            }}
        />
    );
}
