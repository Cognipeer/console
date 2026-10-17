/**
 * The routine editor's form state and its mapping to / from the routines API
 * (`/api/agents/:agentId/routines`). Pure, so it is tested without rendering.
 */

import type { IAgentInputField } from '@/lib/database/provider/types.domain';
import type { serializeAgentRoutine } from '@/lib/services/agents/agentRoutines';
import { DEFAULT_ROUTINE_TIMEZONE, isValidRoutineTimezone, validateRoutineCron } from '@/lib/services/agents/routineSchedule';

/** A routine as the API returns it. */
export type RoutineRow = ReturnType<typeof serializeAgentRoutine>;

/** The trigger types the editor offers, in order. A new type is added here and in the editor's switch. */
export const ROUTINE_TRIGGER_TYPES = ['schedule', 'once', 'manual'] as const;
export type RoutineTriggerType = (typeof ROUTINE_TRIGGER_TYPES)[number];

export type OnceMode = 'at' | 'in';
export type DelayUnit = 'minutes' | 'hours';

export interface RoutineForm {
    name: string;
    description: string;
    enabled: boolean;
    triggerType: RoutineTriggerType;
    cron: string;
    timezone: string;
    onceMode: OnceMode;
    /** `<input type="datetime-local">` value, in the browser's time. */
    runAtLocal: string;
    delayAmount: number;
    delayUnit: DelayUnit;
    prompt: string;
    /** Declared input name → value; absent = not set (the default applies). */
    inputs: Record<string, unknown>;
    /** null = the published version. */
    version: number | null;
    runClass: 'default' | 'deferred';
    /** `key=value` per line. */
    metadataText: string;
    callbackUrl: string;
    /** Typed only to set or replace it; empty keeps the stored one. */
    callbackSecret: string;
    callbackSigned: boolean;
    /** The response_format JSON as the API spells it; empty = none. */
    responseFormatText: string;
}

export const CRON_PRESETS = [
    { key: 'presetHourly', cron: '0 * * * *' },
    { key: 'presetWeekdays', cron: '0 9 * * 1-5' },
    { key: 'presetNightly', cron: '0 2 * * *' },
    { key: 'presetMonday', cron: '0 8 * * 1' },
] as const;

/** The browser's timezone when the runtime knows it, else UTC. */
export function browserTimezone(): string {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return isValidRoutineTimezone(zone) ? zone : DEFAULT_ROUTINE_TIMEZONE;
    } catch {
        return DEFAULT_ROUTINE_TIMEZONE;
    }
}

/** Every timezone the select offers: UTC first, then the runtime's IANA list. */
export function timezoneOptions(): string[] {
    try {
        return [DEFAULT_ROUTINE_TIMEZONE, ...Intl.supportedValuesOf('timeZone').filter((zone) => zone !== DEFAULT_ROUTINE_TIMEZONE)];
    } catch {
        return [DEFAULT_ROUTINE_TIMEZONE];
    }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A date as a `datetime-local` value in the browser's time. */
export function toLocalInputValue(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function emptyRoutineForm(timezone = browserTimezone(), now = new Date()): RoutineForm {
    return {
        name: '',
        description: '',
        enabled: true,
        triggerType: 'schedule',
        cron: '0 9 * * 1-5',
        timezone,
        onceMode: 'in',
        runAtLocal: toLocalInputValue(new Date(now.getTime() + 3_600_000)),
        delayAmount: 30,
        delayUnit: 'minutes',
        prompt: '',
        inputs: {},
        version: null,
        runClass: 'default',
        metadataText: '',
        callbackUrl: '',
        callbackSecret: '',
        callbackSigned: false,
        responseFormatText: '',
    };
}

export function formatMetadataLines(metadata: Record<string, string> | null | undefined): string {
    return Object.entries(metadata ?? {}).map(([key, value]) => `${key}=${value}`).join('\n');
}

/** `key=value` lines → an object; null when a non-empty line has no `=` or no key. */
export function parseMetadataLines(text: string): Record<string, string> | null {
    const out: Record<string, string> = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const at = line.indexOf('=');
        if (at <= 0) return null;
        out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return out;
}

/** The editor's state for a stored routine. */
export function formFromRoutine(routine: RoutineRow, fallbackTimezone = browserTimezone()): RoutineForm {
    const base = emptyRoutineForm(fallbackTimezone);
    const trigger = routine.trigger as { type: string; cron?: string; timezone?: string; run_at?: string };
    const triggerType = (ROUTINE_TRIGGER_TYPES as readonly string[]).includes(trigger.type) ? trigger.type as RoutineTriggerType : 'manual';
    return {
        ...base,
        name: routine.name,
        description: routine.description ?? '',
        enabled: routine.enabled,
        triggerType,
        ...(triggerType === 'schedule' ? { cron: trigger.cron ?? base.cron, timezone: trigger.timezone ?? base.timezone } : {}),
        ...(triggerType === 'once' && trigger.run_at ? { onceMode: 'at' as const, runAtLocal: toLocalInputValue(new Date(trigger.run_at)) } : {}),
        prompt: routine.prompt ?? '',
        inputs: { ...(routine.inputs ?? {}) },
        version: routine.version ?? null,
        runClass: routine.class === 'deferred' ? 'deferred' : 'default',
        metadataText: formatMetadataLines(routine.metadata),
        callbackUrl: routine.callback?.url ?? '',
        callbackSigned: Boolean(routine.callback?.signed),
        responseFormatText: routine.response_format ? JSON.stringify(routine.response_format, null, 2) : '',
    };
}

export type RoutineFormProblem = { field: keyof RoutineForm | 'trigger'; key: string };

/** The trigger part of the request body, or why it cannot be sent. */
export function triggerBodyFromForm(form: RoutineForm, now = new Date()): { ok: true; trigger: Record<string, unknown> } | { ok: false; problem: RoutineFormProblem } {
    switch (form.triggerType) {
        case 'schedule':
            if (validateRoutineCron(form.cron)) return { ok: false, problem: { field: 'cron', key: 'previewInvalid' } };
            return { ok: true, trigger: { type: 'schedule', cron: form.cron.trim(), timezone: form.timezone } };
        case 'once': {
            if (form.onceMode === 'in') {
                if (!Number.isFinite(form.delayAmount) || form.delayAmount <= 0) return { ok: false, problem: { field: 'delayAmount', key: 'delayInvalid' } };
                const seconds = Math.round(form.delayAmount * (form.delayUnit === 'hours' ? 3600 : 60));
                return { ok: true, trigger: { type: 'once', delay_seconds: seconds } };
            }
            const at = new Date(form.runAtLocal);
            if (Number.isNaN(at.getTime())) return { ok: false, problem: { field: 'runAtLocal', key: 'runAtInvalid' } };
            if (at.getTime() < now.getTime()) return { ok: false, problem: { field: 'runAtLocal', key: 'oncePast' } };
            return { ok: true, trigger: { type: 'once', run_at: at.toISOString() } };
        }
        default:
            return { ok: true, trigger: { type: 'manual' } };
    }
}

/**
 * The create / PATCH body. `stored` (editing) leaves out the trigger when it
 * is unchanged — a once routine that already fired keeps its time — and the
 * callback secret unless one was typed.
 */
export function routineBodyFromForm(
    form: RoutineForm,
    declared: IAgentInputField[] | undefined,
    stored?: RoutineRow | null,
    now = new Date(),
): { ok: true; body: Record<string, unknown> } | { ok: false; problem: RoutineFormProblem } {
    if (!form.name.trim()) return { ok: false, problem: { field: 'name', key: 'nameRequired' } };
    const metadata = parseMetadataLines(form.metadataText);
    if (!metadata) return { ok: false, problem: { field: 'metadataText', key: 'invalidMetadata' } };
    let responseFormat: unknown = null;
    if (form.responseFormatText.trim()) {
        try {
            responseFormat = JSON.parse(form.responseFormatText);
        } catch {
            return { ok: false, problem: { field: 'responseFormatText', key: 'invalidJson' } };
        }
    }
    const declaredNames = new Set((declared ?? []).map((field) => field.name));
    const inputs = Object.fromEntries(Object.entries(form.inputs).filter(([name, value]) => declaredNames.has(name) && value !== undefined && value !== ''));

    const body: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        enabled: form.enabled,
        prompt: form.prompt,
        inputs: Object.keys(inputs).length > 0 ? inputs : null,
        version: form.version,
        class: form.runClass,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        response_format: responseFormat,
        callback: form.callbackUrl.trim()
            ? { url: form.callbackUrl.trim(), ...(form.callbackSecret ? { secret: form.callbackSecret } : {}) }
            : null,
    };

    const unchangedOnce = stored && stored.trigger.type === 'once' && form.triggerType === 'once' && form.onceMode === 'at'
        && toLocalInputValue(new Date(String((stored.trigger as { run_at?: string }).run_at))) === form.runAtLocal;
    if (!unchangedOnce) {
        const trigger = triggerBodyFromForm(form, now);
        if (!trigger.ok) return trigger;
        body.trigger = trigger.trigger;
    }
    return { ok: true, body };
}
