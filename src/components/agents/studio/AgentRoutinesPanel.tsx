'use client';

/**
 * Routines of one agent: saved ways of starting it — a prompt (+ inputs) and a
 * trigger (a schedule, one time, or by hand). Each fire is a background run;
 * "Runs" opens Sessions → Background runs filtered to the routine.
 *
 * The editor is a full-screen FormShell; deleting asks through the shared
 * confirm dialog.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Group,
    NumberInput,
    PasswordInput,
    SegmentedControl,
    Select,
    Skeleton,
    Stack,
    Switch,
    Table,
    Text,
    Textarea,
    TextInput,
    Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle,
    IconCalendarTime,
    IconHistory,
    IconPencil,
    IconPlayerPlay,
    IconPlus,
    IconTrash,
} from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';
import FormShell, { FormField, FormRow, FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { useDeleteResource } from '@/components/common/confirm';
import type { IAgentInputField } from '@/lib/database/provider/types.domain';
import { useLocale, useTranslations } from '@/lib/i18n';
import { upcomingCronFires, validateRoutineCron } from '@/lib/services/agents/routineSchedule';
import {
    CRON_PRESETS,
    ROUTINE_TRIGGER_TYPES,
    emptyRoutineForm,
    formFromRoutine,
    routineBodyFromForm,
    timezoneOptions,
    type RoutineForm,
    type RoutineFormProblem,
    type RoutineRow,
    type RoutineTriggerType,
} from './routineForm';

export interface AgentRoutinesPanelProps {
    agentId: string;
    agentName: string;
    /** The inputs the agent declares (its draft; the server checks the version that runs). */
    declaredInputs?: IAgentInputField[];
    /** Saved versions, newest first, for the version select. */
    versions: number[];
    /** Open the runs this routine started. */
    onShowRuns: (routine: { id: string; name: string }) => void;
}

const TRIGGER_LABEL_KEY: Record<RoutineTriggerType, string> = {
    schedule: 'triggerSchedule',
    once: 'triggerOnce',
    manual: 'triggerManual',
};

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

export default function AgentRoutinesPanel({ agentId, agentName, declaredInputs, versions, onShowRuns }: AgentRoutinesPanelProps) {
    const t = useTranslations('agents.routines');
    const tConfirm = useTranslations('common.confirm');
    const locale = useLocale();
    const deleteResource = useDeleteResource();
    const [routines, setRoutines] = useState<RoutineRow[] | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [editing, setEditing] = useState<{ routine: RoutineRow | null } | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/agents/${agentId}/routines`, { cache: 'no-store' });
            if (!res.ok) throw new Error(await errorMessage(res));
            const data = await res.json() as { data: RoutineRow[] };
            setRoutines(data.data ?? []);
        } catch {
            setRoutines((prev) => prev ?? []);
            notifications.show({ color: 'red', message: t('loadFailed') });
        }
    }, [agentId, t]);

    useEffect(() => { void load(); }, [load]);

    const triggerSummary = (routine: RoutineRow): string => {
        const trigger = routine.trigger as { type: string; cron?: string; timezone?: string; run_at?: string };
        if (trigger.type === 'schedule') return t('summarySchedule', { cron: trigger.cron ?? '', timezone: trigger.timezone ?? '' });
        if (trigger.type === 'once' && trigger.run_at) return t('summaryOnce', { time: formatInZone(new Date(trigger.run_at), locale) });
        return t('summaryManual');
    };

    const toggle = async (routine: RoutineRow, enabled: boolean) => {
        setBusyId(routine.id);
        try {
            const res = await fetch(`/api/agents/${agentId}/routines/${routine.id}`, {
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

    const runNow = async (routine: RoutineRow) => {
        setBusyId(routine.id);
        try {
            const res = await fetch(`/api/agents/${agentId}/routines/${routine.id}/run`, {
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

    const remove = async (routine: RoutineRow) => {
        await deleteResource({
            noun: tConfirm('nouns.agentRoutine'),
            name: routine.name,
            extraWarning: tConfirm('extras.agentRoutineStops'),
            action: async () => {
                const res = await fetch(`/api/agents/${agentId}/routines/${routine.id}`, { method: 'DELETE' });
                if (!res.ok) throw new Error(await errorMessage(res));
                await load();
            },
        });
    };

    return (
        <Stack gap="sm">
            <Group justify="flex-end">
                <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing({ routine: null })}>
                    {t('add')}
                </Button>
            </Group>

            {routines === null ? (
                <Stack gap="xs">{[0, 1].map((i) => <Skeleton key={i} h={36} />)}</Stack>
            ) : routines.length === 0 ? (
                <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} minHeight={160} />
            ) : (
                <Table highlightOnHover verticalSpacing={6}>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>{t('colName')}</Table.Th>
                            <Table.Th>{t('colTrigger')}</Table.Th>
                            <Table.Th w={170}>{t('colNext')}</Table.Th>
                            <Table.Th w={200}>{t('colLast')}</Table.Th>
                            <Table.Th w={60}>{t('colEnabled')}</Table.Th>
                            <Table.Th w={140} />
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {routines.map((routine) => {
                            const next = fromEpoch(routine.next_fire_at);
                            const last = fromEpoch(routine.last_fire_at);
                            return (
                                <Table.Tr key={routine.id}>
                                    <Table.Td>
                                        <Text size="sm" fw={500}>{routine.name}</Text>
                                        {routine.description ? <Text size="xs" c="dimmed" lineClamp={1}>{routine.description}</Text> : null}
                                    </Table.Td>
                                    <Table.Td>
                                        <Group gap={6} wrap="nowrap">
                                            <Badge size="xs" variant="light">{t(TRIGGER_LABEL_KEY[routine.trigger.type as RoutineTriggerType] ?? 'triggerManual')}</Badge>
                                            <Text size="xs" ff={routine.trigger.type === 'schedule' ? 'monospace' : undefined} c="dimmed">{triggerSummary(routine)}</Text>
                                        </Group>
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="xs">{next ? formatInZone(next, locale) : t('none')}</Text>
                                    </Table.Td>
                                    <Table.Td>
                                        {last ? (
                                            <Group gap={6} wrap="nowrap">
                                                <Text size="xs">{formatInZone(last, locale)}</Text>
                                                {routine.last_status ? (
                                                    <Tooltip label={routine.last_error ?? ''} disabled={!routine.last_error} withArrow multiline maw={360}>
                                                        <Badge size="xs" variant="light" color={routine.last_status === 'failed' ? 'red' : 'teal'}>
                                                            {t(routine.last_status === 'failed' ? 'statusFailed' : 'statusStarted')}
                                                        </Badge>
                                                    </Tooltip>
                                                ) : null}
                                            </Group>
                                        ) : <Text size="xs" c="dimmed">{t('never')}</Text>}
                                    </Table.Td>
                                    <Table.Td>
                                        <Switch
                                            size="xs"
                                            checked={routine.enabled}
                                            disabled={busyId === routine.id}
                                            aria-label={t('colEnabled')}
                                            onChange={(event) => void toggle(routine, event.currentTarget.checked)}
                                        />
                                    </Table.Td>
                                    <Table.Td>
                                        <Group gap={2} justify="flex-end" wrap="nowrap">
                                            <Tooltip label={t('runNow')} withArrow>
                                                <ActionIcon size="sm" variant="subtle" color="teal" loading={busyId === routine.id} aria-label={t('runNow')} onClick={() => void runNow(routine)}>
                                                    <IconPlayerPlay size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                            <Tooltip label={t('history')} withArrow>
                                                <ActionIcon size="sm" variant="subtle" color="gray" aria-label={t('history')} onClick={() => onShowRuns({ id: routine.id, name: routine.name })}>
                                                    <IconHistory size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                            <Tooltip label={t('edit')} withArrow>
                                                <ActionIcon size="sm" variant="subtle" color="gray" aria-label={t('edit')} onClick={() => setEditing({ routine })}>
                                                    <IconPencil size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                            <Tooltip label={t('delete')} withArrow>
                                                <ActionIcon size="sm" variant="subtle" color="red" aria-label={t('delete')} onClick={() => void remove(routine)}>
                                                    <IconTrash size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                        </Group>
                                    </Table.Td>
                                </Table.Tr>
                            );
                        })}
                    </Table.Tbody>
                </Table>
            )}

            {editing ? (
                <RoutineEditor
                    agentId={agentId}
                    agentName={agentName}
                    routine={editing.routine}
                    declaredInputs={declaredInputs}
                    versions={versions}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        notifications.show({ color: 'teal', message: t('saved') });
                        void load();
                    }}
                />
            ) : null}
        </Stack>
    );
}

// ── Editor ───────────────────────────────────────────────────────────────

interface RoutineEditorProps {
    agentId: string;
    agentName: string;
    routine: RoutineRow | null;
    declaredInputs?: IAgentInputField[];
    versions: number[];
    onClose: () => void;
    onSaved: () => void;
}

function RoutineEditor({ agentId, agentName, routine, declaredInputs, versions, onClose, onSaved }: RoutineEditorProps) {
    const t = useTranslations('agents.routines');
    const locale = useLocale();
    const [form, setForm] = useState<RoutineForm>(() => (routine ? formFromRoutine(routine) : emptyRoutineForm()));
    const [problem, setProblem] = useState<RoutineFormProblem | null>(null);
    const [saving, setSaving] = useState(false);
    const zones = useMemo(() => timezoneOptions(), []);
    const set = <K extends keyof RoutineForm>(key: K, value: RoutineForm[K]) => {
        setForm((prev) => ({ ...prev, [key]: value }));
        setProblem(null);
    };
    const errorOf = (field: RoutineFormProblem['field']) => (problem?.field === field ? t(problem.key) : undefined);

    const preview = useMemo(() => {
        if (form.triggerType !== 'schedule' || validateRoutineCron(form.cron)) return null;
        return upcomingCronFires(form.cron, form.timezone, new Date(), 3);
    }, [form.triggerType, form.cron, form.timezone]);

    const save = async () => {
        const built = routineBodyFromForm(form, declaredInputs, routine);
        if (!built.ok) {
            setProblem(built.problem);
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(routine ? `/api/agents/${agentId}/routines/${routine.id}` : `/api/agents/${agentId}/routines`, {
                method: routine ? 'PATCH' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(built.body),
            });
            if (!res.ok) {
                notifications.show({ color: 'red', message: t('saveFailed', { message: await errorMessage(res) }) });
                return;
            }
            onSaved();
        } finally {
            setSaving(false);
        }
    };

    const triggerSummary = form.triggerType === 'schedule'
        ? `${form.cron} (${form.timezone})`
        : form.triggerType === 'once'
            ? (form.onceMode === 'in' ? `+${form.delayAmount} ${t(form.delayUnit)}` : form.runAtLocal.replace('T', ' '))
            : t('triggerManual');

    return (
        <FormShell
            open
            onClose={onClose}
            icon={<IconCalendarTime size={16} />}
            title={routine ? t('titleEdit') : t('titleNew')}
            subtitle={t('subtitle', { agent: agentName })}
            primaryAction={{ label: t('save'), color: 'teal', loading: saving, onClick: () => void save() }}
            secondaryAction={{ label: t('cancel'), onClick: onClose }}
            summary={(
                <SummaryGroup title={t('summaryTitle')}>
                    <SummaryKV label={t('summaryTrigger')} value={triggerSummary} mono={form.triggerType === 'schedule'} />
                    {preview && preview[0] ? <SummaryKV label={t('summaryNext')} value={formatInZone(preview[0], locale)} /> : null}
                    <SummaryKV label={t('summaryVersion')} value={form.version === null ? t('versionPublished') : t('versionN', { n: form.version })} />
                    <SummaryKV label={t('summaryClass')} value={t(form.runClass === 'deferred' ? 'classDeferred' : 'classDefault')} />
                </SummaryGroup>
            )}
        >
            <FormSection number={1} title={t('sectionBasics')} description={t('sectionBasicsDescription')}>
                <FormField label={t('name')} required>
                    <TextInput value={form.name} placeholder={t('namePlaceholder')} error={errorOf('name')} onChange={(event) => set('name', event.currentTarget.value)} />
                </FormField>
                <FormField label={t('description')} optional>
                    <TextInput value={form.description} onChange={(event) => set('description', event.currentTarget.value)} />
                </FormField>
                <Switch label={t('enabled')} description={t('enabledHint')} checked={form.enabled} onChange={(event) => set('enabled', event.currentTarget.checked)} />
            </FormSection>

            <FormSection number={2} title={t('sectionTrigger')} description={t('sectionTriggerDescription')}>
                <SegmentedControl
                    value={form.triggerType}
                    onChange={(value) => set('triggerType', value as RoutineTriggerType)}
                    data={ROUTINE_TRIGGER_TYPES.map((type) => ({ value: type, label: t(TRIGGER_LABEL_KEY[type]) }))}
                />
                {form.triggerType === 'schedule' ? (
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
                                <Badge key={preset.cron} variant={form.cron === preset.cron ? 'filled' : 'light'} style={{ cursor: 'pointer' }} onClick={() => set('cron', preset.cron)}>
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
                {form.triggerType === 'once' ? (
                    <Stack gap="sm">
                        <SegmentedControl
                            size="xs"
                            w="fit-content"
                            value={form.onceMode}
                            onChange={(value) => set('onceMode', value as RoutineForm['onceMode'])}
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
                                        onChange={(value) => value && set('delayUnit', value as RoutineForm['delayUnit'])}
                                    />
                                </FormField>
                            </FormRow>
                        )}
                    </Stack>
                ) : null}
                {form.triggerType === 'manual' ? <Text size="sm" c="dimmed">{t('manualHint')}</Text> : null}
            </FormSection>

            <FormSection number={3} title={t('sectionPrompt')} description={t('sectionPromptDescription')}>
                <FormField label={t('prompt')} hint={t('promptHint')}>
                    <Textarea autosize minRows={4} maxRows={14} value={form.prompt} placeholder={t('promptPlaceholder')} onChange={(event) => set('prompt', event.currentTarget.value)} />
                </FormField>
                {(declaredInputs ?? []).length > 0 ? (
                    <Stack gap="sm">
                        <Text size="sm" fw={500}>{t('inputsTitle')}</Text>
                        {(declaredInputs ?? []).map((field) => (
                            <InputValueField
                                key={field.name}
                                field={field}
                                value={form.inputs[field.name]}
                                onChange={(value) => set('inputs', { ...form.inputs, [field.name]: value })}
                            />
                        ))}
                    </Stack>
                ) : null}
            </FormSection>

            <FormSection number={4} title={t('sectionRun')} description={t('sectionRunDescription')} collapsible defaultOpen={Boolean(routine)}>
                <FormRow>
                    <FormField label={t('version')}>
                        <Select
                            allowDeselect={false}
                            value={form.version === null ? 'published' : String(form.version)}
                            data={[{ value: 'published', label: t('versionPublished') }, ...versions.map((n) => ({ value: String(n), label: t('versionN', { n }) }))]}
                            onChange={(value) => set('version', !value || value === 'published' ? null : Number(value))}
                        />
                    </FormField>
                    <FormField label={t('class')} hint={t('classHint')}>
                        <SegmentedControl
                            value={form.runClass}
                            onChange={(value) => set('runClass', value as RoutineForm['runClass'])}
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
        </FormShell>
    );
}

/** One declared input's value: a field for its type; empty = not set (the default applies). */
function InputValueField({ field, value, onChange }: { field: IAgentInputField; value: unknown; onChange: (value: unknown) => void }) {
    const t = useTranslations('agents.routines');
    const label = field.label || field.name;
    const common = { label, description: field.description, required: field.required };
    if (field.enum && field.enum.length > 0) {
        return (
            <Select
                {...common}
                clearable
                placeholder={t('inputUnset')}
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
                    placeholder={t('inputUnset')}
                    value={typeof value === 'number' ? value : ''}
                    onChange={(next) => onChange(next === '' ? undefined : Number(next))}
                />
            );
        case 'boolean':
            return (
                <Select
                    {...common}
                    clearable
                    placeholder={t('inputUnset')}
                    value={value === true ? 'true' : value === false ? 'false' : null}
                    data={[{ value: 'true', label: t('inputYes') }, { value: 'false', label: t('inputNo') }]}
                    onChange={(next) => onChange(next === null ? undefined : next === 'true')}
                />
            );
        case 'json':
            return <JsonInputValue field={field} value={value} onChange={onChange} />;
        default:
            return (
                <TextInput
                    {...common}
                    placeholder={t('inputUnset')}
                    value={typeof value === 'string' ? value : ''}
                    onChange={(event) => onChange(event.currentTarget.value === '' ? undefined : event.currentTarget.value)}
                />
            );
    }
}

function JsonInputValue({ field, value, onChange }: { field: IAgentInputField; value: unknown; onChange: (value: unknown) => void }) {
    const t = useTranslations('agents.routines');
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
            placeholder={t('inputUnset')}
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
