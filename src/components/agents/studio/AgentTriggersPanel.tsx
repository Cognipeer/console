'use client';

/**
 * Triggers of one agent: saved ways of starting it — a prompt (+ variables) and a
 * type (a schedule, one time, by hand, or an incoming webhook) with that type's
 * settings. Each fire is a background run; "Runs" opens Sessions → Background
 * runs filtered to the trigger.
 *
 * The editor is a full-screen FormShell; deleting asks through the shared
 * confirm dialog. A saved webhook trigger's editor stays open with its Connect
 * card (the secret is shown there once) and the Test / Deliveries tabs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
    IconPencil,
    IconPlayerPlay,
    IconPlus,
    IconRepeat,
    IconTrash,
    IconWebhook,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import EmptyState from '@/components/common/EmptyState';
import FormShell, { FormField, FormRow, FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { useDeleteResource } from '@/components/common/confirm';
import type { IAgentVariable } from '@/lib/database/provider/types.domain';
import { useLocale, useTranslations } from '@/lib/i18n';
import { upcomingCronFires, validateTriggerCron } from '@/lib/services/agents/agentTriggerSchedule';
import {
    CRON_PRESETS,
    TRIGGER_TYPES,
    emptyTriggerForm,
    formFromTrigger,
    triggerBodyFromForm,
    timezoneOptions,
    webhookVariableText,
    webhookVariableValue,
    type TriggerForm,
    type TriggerFormProblem,
    type TriggerRow,
    type TriggerType,
} from './triggerForm';
import {
    WEBHOOK_PRESET_LABEL_KEY,
    WebhookConnectCard,
    WebhookDeliveriesPanel,
    WebhookTemplateVariables,
    WebhookTestPanel,
    WebhookFields,
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
};

const TYPE_ICON: Record<TriggerType, ReactNode> = {
    schedule: <IconRepeat size={14} />,
    once: <IconClockPlay size={14} />,
    manual: <IconHandClick size={14} />,
    webhook: <IconWebhook size={14} />,
};

const WEBHOOK_PROMPT_PLACEHOLDER = 'Review pull request #{{payload.number}}: {{payload.pull_request.title}}';

/** The `webhook` settings object of a stored trigger, as far as the list summary reads it. */
type StoredWebhookSummary = { preset?: string; events?: string[] };

/** The message of an API error body (`{ error: { message } }`), else the status. */
async function errorMessage(res: Response): Promise<string> {
    const data = await res.json().catch(() => null) as { error?: { message?: string } | string } | null;
    const error = data?.error;
    if (typeof error === 'string') return error;
    return error?.message ?? `HTTP ${res.status}`;
}

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
    const [editing, setEditing] = useState<{ trigger: TriggerRow | null } | null>(null);

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
                                    <Text size="sm" fw={500} truncate title={trigger.name}>{trigger.name}</Text>
                                    <Group gap={6} wrap="nowrap" c="dimmed" style={{ minWidth: 0 }}>
                                        <Tooltip label={t(TYPE_LABEL_KEY[triggerType])} withArrow>
                                            <Box component="span" role="img" aria-label={t(TYPE_LABEL_KEY[triggerType])} style={{ display: 'inline-flex', flexShrink: 0 }}>
                                                {TYPE_ICON[triggerType]}
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
                                        <Tooltip label={t('runNow')} withArrow>
                                            <ActionIcon size="sm" variant="subtle" color="teal" loading={busyId === trigger.id} aria-label={t('runNow')} onClick={() => void runNow(trigger)}>
                                                <IconPlayerPlay size={14} />
                                            </ActionIcon>
                                        </Tooltip>
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
                    declaredVariables={declaredVariables}
                    versions={versions}
                    onClose={() => setEditing(null)}
                    onSaved={(saved, keepOpen) => {
                        // A webhook trigger stays open on the saved row: its Connect card holds the URL and the secret.
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
    declaredVariables?: IAgentVariable[];
    versions: number[];
    onClose: () => void;
    onSaved: (trigger: TriggerRow, keepOpen: boolean) => void;
    onShowRuns: (trigger: { id: string; name: string }) => void;
}

type EditorTab = 'settings' | 'test' | 'deliveries';

function TriggerEditor({ agentId, agentName, trigger, declaredVariables, versions, onClose, onSaved, onShowRuns }: TriggerEditorProps) {
    const t = useTranslations('agents.triggers');
    const locale = useLocale();
    const [form, setForm] = useState<TriggerForm>(() => (trigger ? formFromTrigger(trigger) : emptyTriggerForm()));
    const [problem, setProblem] = useState<TriggerFormProblem | null>(null);
    const [saving, setSaving] = useState(false);
    const [tab, setTab] = useState<EditorTab>('settings');
    /** The webhook secret from the last save / rotation: shown once, never read back. */
    const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
    const storedWebhook = trigger?.type === 'webhook' ? trigger.webhook as Parameters<typeof WebhookConnectCard>[0]['webhook'] : null;
    const zones = useMemo(() => timezoneOptions(), []);
    const set = <K extends keyof TriggerForm>(key: K, value: TriggerForm[K]) => {
        setForm((prev) => ({ ...prev, [key]: value }));
        setProblem(null);
    };
    const errorOf = (field: TriggerFormProblem['field']) => (problem?.field === field ? t(problem.key) : undefined);

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
            const res = await fetch(trigger ? `/api/agents/${agentId}/triggers/${trigger.id}` : `/api/agents/${agentId}/triggers`, {
                method: trigger ? 'PATCH' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(built.body),
            });
            if (!res.ok) {
                notifications.show({ color: 'red', message: t('saveFailed', { message: await errorMessage(res) }) });
                return;
            }
            const saved = await res.json() as TriggerRow;
            const keepOpen = saved.type === 'webhook';
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

    const typeSummary = form.type === 'schedule'
        ? `${form.cron} (${form.timezone})`
        : form.type === 'once'
            ? (form.onceMode === 'in' ? `+${form.delayAmount} ${t(form.delayUnit)}` : form.runAtLocal.replace('T', ' '))
            : form.type === 'webhook'
                ? [t(WEBHOOK_PRESET_LABEL_KEY[form.webhookPreset]), ...form.webhookEvents].join(' · ')
                : t('typeManual');
    const webhook = form.type === 'webhook';
    const declared = declaredVariables ?? [];

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
                <SegmentedControl
                    value={form.type}
                    onChange={(value) => set('type', value as TriggerType)}
                    data={TRIGGER_TYPES.map((type) => ({ value: type, label: t(TYPE_LABEL_KEY[type]) }))}
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
            </FormSection>

            <FormSection number={3} title={t('sectionPrompt')} description={t('sectionPromptDescription')}>
                <FormField label={t('prompt')} hint={t(webhook ? 'webhookPromptHint' : 'promptHint')}>
                    <Textarea
                        autosize
                        minRows={4}
                        maxRows={14}
                        ff={webhook ? 'monospace' : undefined}
                        value={form.prompt}
                        placeholder={webhook ? WEBHOOK_PROMPT_PLACEHOLDER : t('promptPlaceholder')}
                        onChange={(event) => set('prompt', event.currentTarget.value)}
                    />
                </FormField>
                {webhook ? <WebhookTemplateVariables /> : null}
                {declared.length > 0 && webhook ? (
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
                {declared.length > 0 && !webhook ? (
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
                    <FormField label={t('class')} hint={t(webhook ? 'webhookClassHint' : 'classHint')}>
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
            {storedWebhook && trigger ? (
                <Tabs value={tab} onChange={(value) => setTab((value as EditorTab | null) ?? 'settings')} keepMounted={false}>
                    <Tabs.List mb="md">
                        <Tabs.Tab value="settings">{t('tabSettings')}</Tabs.Tab>
                        <Tabs.Tab value="test">{t('tabTest')}</Tabs.Tab>
                        <Tabs.Tab value="deliveries">{t('tabDeliveries')}</Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panel value="settings">
                        <Stack gap="md">
                            <WebhookConnectCard
                                agentId={agentId}
                                triggerId={trigger.id}
                                webhook={storedWebhook}
                                revealedSecret={revealedSecret}
                                onSecret={setRevealedSecret}
                            />
                            {settings}
                        </Stack>
                    </Tabs.Panel>
                    <Tabs.Panel value="test">
                        <WebhookTestPanel agentId={agentId} triggerId={trigger.id} preset={form.webhookPreset} />
                    </Tabs.Panel>
                    <Tabs.Panel value="deliveries">
                        <WebhookDeliveriesPanel agentId={agentId} triggerId={trigger.id} onShowRuns={() => onShowRuns({ id: trigger.id, name: trigger.name })} />
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
