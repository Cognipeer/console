/**
 * The trigger editor's form state and its mapping to / from the triggers API
 * (`/api/agents/:agentId/triggers`): a trigger's `type` and the one settings
 * object named after it (`schedule`, `once`, `webhook`). Pure, so it is tested
 * without rendering.
 */

import type { IAgentVariable } from '@/lib/database/provider/types.domain';
import type { serializeAgentTrigger } from '@/lib/services/agents/agentTriggers';
import { DEFAULT_TRIGGER_TIMEZONE, isValidTriggerTimezone, validateTriggerCron } from '@/lib/services/agents/agentTriggerSchedule';

/** A trigger as the API returns it. */
export type TriggerRow = ReturnType<typeof serializeAgentTrigger>;

/** The types the editor offers, in order. A new type is added here and in the editor's switch. */
export const TRIGGER_TYPES = ['schedule', 'once', 'manual', 'webhook'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

// ── Webhook ──────────────────────────────────────────────────────────────
// The preset / auth lists mirror agentTriggerWebhookAuth.ts, which uses node:crypto
// and cannot be imported here; trigger-form.test.ts keeps the two equal.

export const WEBHOOK_PRESETS = ['github', 'gitlab', 'azure_devops', 'generic'] as const;
export type WebhookPreset = (typeof WEBHOOK_PRESETS)[number];
export type WebhookAuth = 'github_signature' | 'gitlab_token' | 'standard_webhooks' | 'basic' | 'header' | 'bearer' | 'signature';

/** The auth modes each preset offers; the first is its default. */
export const WEBHOOK_PRESET_AUTH: Record<WebhookPreset, readonly WebhookAuth[]> = {
    github: ['github_signature'],
    gitlab: ['gitlab_token', 'standard_webhooks'],
    azure_devops: ['basic', 'header'],
    generic: ['bearer', 'signature', 'header', 'standard_webhooks'],
};

export const DEFAULT_WEBHOOK_HEADER_NAME = 'x-cognipeer-token';

export const WEBHOOK_FILTER_OPS = ['eq', 'neq', 'in', 'not_in', 'exists', 'not_exists', 'contains', 'starts_with', 'glob'] as const;
export type WebhookFilterOp = (typeof WEBHOOK_FILTER_OPS)[number];

/** One filter row as edited: `in` / `not_in` take a comma-separated list; `exists` / `not_exists` no value. */
export interface WebhookFilterRow {
    path: string;
    op: WebhookFilterOp;
    value: string;
}

/**
 * The template tags the editor offers for a prompt template / variable mapping. A subset of the roots the server accepts
 * (agentTriggerWebhookView WEBHOOK_CONTEXT_ROOTS): `received_at` is valid in a template but is not offered as an example.
 */
export const WEBHOOK_TEMPLATE_VARIABLES = [
    'payload.…', 'headers.…', 'event', 'delivery_id', 'preset', 'trigger.id', 'trigger.name', 'agent.key',
] as const;

/** Event-name suggestions per preset (generic senders name their own). */
export const WEBHOOK_EVENT_SUGGESTIONS: Record<WebhookPreset, readonly string[]> = {
    github: ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'push', 'issues', 'issue_comment', 'release', 'workflow_run'],
    gitlab: ['merge_request', 'push', 'tag_push', 'note', 'issue', 'work_item', 'pipeline', 'build', 'release', 'deployment'],
    azure_devops: [
        'git.pullrequest.created', 'git.pullrequest.updated', 'git.pullrequest.merged', 'ms.vss-code.git-pullrequest-comment-event',
        'git.push', 'build.complete', 'workitem.created', 'workitem.updated', 'workitem.commented',
    ],
    generic: [],
};

/** GitHub / GitLab "Actions" chips: compiled to a `<path> in [...]` rule placed first in the filter. */
export const WEBHOOK_ACTION_PATH: Partial<Record<WebhookPreset, string>> = {
    github: 'payload.action',
    gitlab: 'payload.object_attributes.action',
};

export const WEBHOOK_ACTION_SUGGESTIONS: Partial<Record<WebhookPreset, readonly string[]>> = {
    github: ['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited', 'closed', 'created', 'submitted', 'completed'],
    gitlab: ['open', 'update', 'reopen', 'approved', 'merge', 'close'],
};

/** One-click filter examples per preset (i18n key under agents.triggers → rows they add). */
export const WEBHOOK_FILTER_EXAMPLES: Record<WebhookPreset, ReadonlyArray<{ key: string; rows: WebhookFilterRow[] }>> = {
    github: [
        {
            key: 'exampleGithubOpened',
            rows: [
                { path: 'payload.action', op: 'in', value: 'opened, synchronize, reopened' },
                { path: 'payload.pull_request.draft', op: 'neq', value: 'true' },
            ],
        },
        { key: 'exampleGithubMain', rows: [{ path: 'payload.pull_request.base.ref', op: 'eq', value: 'main' }] },
        { key: 'exampleGithubMembers', rows: [{ path: 'payload.pull_request.author_association', op: 'in', value: 'OWNER, MEMBER, COLLABORATOR' }] },
    ],
    gitlab: [
        { key: 'exampleGitlabMr', rows: [{ path: 'payload.object_attributes.action', op: 'in', value: 'open, update' }] },
        { key: 'exampleGitlabNotDraft', rows: [{ path: 'payload.object_attributes.draft', op: 'neq', value: 'true' }] },
    ],
    azure_devops: [
        { key: 'exampleAdoMain', rows: [{ path: 'payload.resource.targetRefName', op: 'eq', value: 'refs/heads/main' }] },
        {
            key: 'exampleAdoCompleted',
            rows: [
                { path: 'payload.resource.status', op: 'eq', value: 'completed' },
                { path: 'payload.resource.mergeStatus', op: 'eq', value: 'succeeded' },
            ],
        },
    ],
    generic: [],
};

/** A sample delivery per preset for the editor's Test tab: what the sender would post (trimmed to the fields a trigger is likely to use). */
export const WEBHOOK_SAMPLES: Record<WebhookPreset, { headers: Record<string, string>; payload: Record<string, unknown> }> = {
    github: {
        headers: {
            'x-github-event': 'pull_request',
            'x-github-delivery': '00000000-0000-4000-8000-000000000001',
            'x-github-hook-id': '123456789',
            'user-agent': 'GitHub-Hookshot/0000000',
        },
        payload: {
            action: 'opened',
            number: 42,
            pull_request: {
                id: 1000000042,
                number: 42,
                state: 'open',
                locked: false,
                title: 'Add retry to the importer',
                body: 'Retries a failed import up to three times with a short back-off.',
                draft: false,
                merged: false,
                author_association: 'MEMBER',
                html_url: 'https://github.com/example/repo/pull/42',
                user: { login: 'octocat', id: 583231, type: 'User' },
                labels: [{ name: 'enhancement' }],
                base: { ref: 'main', sha: '9a4f1c2d8b7e6a5f4c3b2a1908f7e6d5c4b3a291', repo: { full_name: 'example/repo' } },
                head: { ref: 'feature/retry', sha: '3b7c9e1a5d2f4086b1c3e5a7d9f0b2c4e6a8d0f1', repo: { full_name: 'example/repo' } },
                commits: 3,
                additions: 48,
                deletions: 6,
                changed_files: 4,
                created_at: '2026-10-17T09:30:00Z',
                updated_at: '2026-10-17T09:30:00Z',
            },
            repository: { id: 1296269, name: 'repo', full_name: 'example/repo', private: false, html_url: 'https://github.com/example/repo', default_branch: 'main' },
            sender: { login: 'octocat', id: 583231, type: 'User' },
        },
    },
    gitlab: {
        headers: { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': '00000000-0000-4000-8000-000000000002', 'webhook-id': 'msg_sample_1' },
        payload: {
            object_kind: 'merge_request',
            event_type: 'merge_request',
            user: { id: 1, name: 'Jane Doe', username: 'jane' },
            project: { id: 15, name: 'repo', path_with_namespace: 'example/repo', web_url: 'https://gitlab.example.com/example/repo', default_branch: 'main' },
            object_attributes: {
                id: 99,
                iid: 7,
                title: 'Add retry to the importer',
                description: 'Retries a failed import up to three times with a short back-off.',
                action: 'open',
                state: 'opened',
                draft: false,
                source_branch: 'feature/retry',
                target_branch: 'main',
                url: 'https://gitlab.example.com/example/repo/-/merge_requests/7',
                last_commit: { id: '3b7c9e1a5d2f4086b1c3e5a7d9f0b2c4e6a8d0f1', message: 'Retry failed imports' },
                created_at: '2026-10-17 09:30:00 UTC',
            },
            labels: [{ title: 'enhancement' }],
        },
    },
    azure_devops: {
        headers: {},
        payload: {
            id: '6a1c3a1e-0000-4000-8000-000000000001',
            eventType: 'git.pullrequest.created',
            publisherId: 'tfs',
            message: { text: 'Jane Doe created pull request 12 (Add retry to the importer)' },
            resource: {
                pullRequestId: 12,
                title: 'Add retry to the importer',
                description: 'Retries a failed import up to three times with a short back-off.',
                status: 'active',
                mergeStatus: 'succeeded',
                isDraft: false,
                sourceRefName: 'refs/heads/feature/retry',
                targetRefName: 'refs/heads/main',
                lastMergeSourceCommit: { commitId: '3b7c9e1a5d2f4086b1c3e5a7d9f0b2c4e6a8d0f1' },
                createdBy: { displayName: 'Jane Doe', uniqueName: 'jane@example.com' },
                creationDate: '2026-10-17T09:30:00Z',
                repository: { id: '5a1b2c3d-0000-4000-8000-000000000003', name: 'repo', project: { name: 'Example' } },
                url: 'https://dev.azure.com/example/Example/_apis/git/repositories/repo/pullRequests/12',
            },
            createdDate: '2026-10-17T09:30:01Z',
        },
    },
    generic: {
        headers: { 'x-cognipeer-event-id': 'evt_sample_1' },
        payload: {
            id: 'evt_sample_1',
            event: 'ticket.created',
            created_at: '2026-10-17T09:30:00Z',
            ticket: { id: 'T-1001', title: 'Login page is slow', priority: 'high', status: 'open', url: 'https://support.example.com/tickets/T-1001' },
            actor: { name: 'Jane Doe', email: 'jane@example.com' },
        },
    },
};

export type OnceMode = 'at' | 'in';
export type DelayUnit = 'minutes' | 'hours';

export interface TriggerForm {
    name: string;
    description: string;
    enabled: boolean;
    type: TriggerType;
    cron: string;
    timezone: string;
    onceMode: OnceMode;
    /** `<input type="datetime-local">` value, in the browser's time. */
    runAtLocal: string;
    delayAmount: number;
    delayUnit: DelayUnit;
    prompt: string;
    /** Declared variable name → value; absent = not set (the default applies). */
    variables: Record<string, unknown>;
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
    webhookPreset: WebhookPreset;
    webhookAuth: WebhookAuth;
    webhookHeaderName: string;
    /** Standard Webhooks only: the sender's `whsec_…` secret; empty keeps the stored one. */
    webhookSecret: string;
    webhookEvents: string[];
    /** GitHub / GitLab only (WEBHOOK_ACTION_PATH). */
    webhookActions: string[];
    webhookFilter: WebhookFilterRow[];
    webhookIncludePayload: boolean;
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
        return isValidTriggerTimezone(zone) ? zone : DEFAULT_TRIGGER_TIMEZONE;
    } catch {
        return DEFAULT_TRIGGER_TIMEZONE;
    }
}

/** Every timezone the select offers: UTC first, then the runtime's IANA list. */
export function timezoneOptions(): string[] {
    try {
        return [DEFAULT_TRIGGER_TIMEZONE, ...Intl.supportedValuesOf('timeZone').filter((zone) => zone !== DEFAULT_TRIGGER_TIMEZONE)];
    } catch {
        return [DEFAULT_TRIGGER_TIMEZONE];
    }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A date as a `datetime-local` value in the browser's time. */
export function toLocalInputValue(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function emptyTriggerForm(timezone = browserTimezone(), now = new Date()): TriggerForm {
    return {
        name: '',
        description: '',
        enabled: true,
        type: 'schedule',
        cron: '0 9 * * 1-5',
        timezone,
        onceMode: 'in',
        runAtLocal: toLocalInputValue(new Date(now.getTime() + 3_600_000)),
        delayAmount: 30,
        delayUnit: 'minutes',
        prompt: '',
        variables: {},
        version: null,
        runClass: 'default',
        metadataText: '',
        callbackUrl: '',
        callbackSecret: '',
        callbackSigned: false,
        responseFormatText: '',
        webhookPreset: 'github',
        webhookAuth: 'github_signature',
        webhookHeaderName: DEFAULT_WEBHOOK_HEADER_NAME,
        webhookSecret: '',
        webhookEvents: [],
        webhookActions: [],
        webhookFilter: [],
        webhookIncludePayload: true,
    };
}

/** A stored variable value as the webhook mapping's text field shows it. */
export function webhookVariableText(value: unknown): string {
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A webhook mapping field's text → the value to store: text with a `{{tag}}`
 * stays a template (the server renders it per delivery); anything else is a
 * literal brought to the declared type, as a request's variables would be.
 */
export function webhookVariableValue(field: IAgentVariable | undefined, text: string): unknown {
    if (text.includes('{{')) return text;
    const trimmed = text.trim();
    switch (field?.type) {
        case 'number':
        case 'integer':
            // Only a complete number: "1." stays text while it is typed.
            return /^-?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : text;
        case 'boolean':
            return trimmed === 'true' ? true : trimmed === 'false' ? false : text;
        case 'json':
            try {
                return JSON.parse(trimmed);
            } catch {
                return text;
            }
        default:
            return text;
    }
}

const listText = (value: unknown) => (Array.isArray(value) ? value.map(String).join(', ') : value === undefined || value === null ? '' : String(value));
const splitList = (text: string) => text.split(',').map((item) => item.trim()).filter(Boolean);

/** A filter row → the API rule, or null when its value is missing. */
function ruleFromRow(row: WebhookFilterRow): Record<string, unknown> | null {
    const path = row.path.trim();
    if (row.op === 'exists' || row.op === 'not_exists') return { path, op: row.op };
    if (row.op === 'in' || row.op === 'not_in') {
        const list = splitList(row.value);
        return list.length > 0 ? { path, op: row.op, value: list } : null;
    }
    return row.value !== '' ? { path, op: row.op, value: row.value } : null;
}

/** A stored trigger's `webhook` object as the API returns it. */
interface StoredWebhook {
    url?: string;
    preset?: string;
    auth?: string;
    header_name?: string | null;
    events?: string[];
    filter?: Array<{ path: string; op: string; value?: unknown }>;
    include_payload?: boolean;
}

/** The webhook part of the form from a stored `webhook`: an action rule first in the filter becomes the Actions chips. */
function webhookFormFields(webhook: StoredWebhook, base: TriggerForm): Partial<TriggerForm> {
    const preset = (WEBHOOK_PRESETS as readonly string[]).includes(webhook.preset ?? '') ? webhook.preset as WebhookPreset : 'generic';
    const auth = WEBHOOK_PRESET_AUTH[preset].includes(webhook.auth as WebhookAuth) ? webhook.auth as WebhookAuth : WEBHOOK_PRESET_AUTH[preset][0];
    const rules = [...(webhook.filter ?? [])];
    const actionPath = WEBHOOK_ACTION_PATH[preset];
    let actions: string[] = [];
    const first = rules[0];
    if (actionPath && first && first.path === actionPath && first.op === 'in' && Array.isArray(first.value) && first.value.every((item) => typeof item === 'string')) {
        actions = first.value as string[];
        rules.shift();
    }
    return {
        webhookPreset: preset,
        webhookAuth: auth,
        webhookHeaderName: webhook.header_name ?? base.webhookHeaderName,
        webhookEvents: [...(webhook.events ?? [])],
        webhookActions: actions,
        webhookFilter: rules.map((rule) => ({
            path: rule.path,
            op: (WEBHOOK_FILTER_OPS as readonly string[]).includes(rule.op) ? rule.op as WebhookFilterOp : 'eq',
            value: listText(rule.value),
        })),
        webhookIncludePayload: webhook.include_payload !== false,
    };
}

/** The filter rules a save sends: the Actions chips first, then the rows. */
export function webhookFilterBody(form: TriggerForm): { ok: true; rules: Array<Record<string, unknown>> } | { ok: false; index: number } {
    const rules: Array<Record<string, unknown>> = [];
    const actionPath = WEBHOOK_ACTION_PATH[form.webhookPreset];
    if (actionPath && form.webhookActions.length > 0) rules.push({ path: actionPath, op: 'in', value: [...form.webhookActions] });
    for (const [index, row] of form.webhookFilter.entries()) {
        if (!row.path.trim() && !row.value.trim()) continue;
        const rule = ruleFromRow(row);
        if (!rule || !row.path.trim()) return { ok: false, index };
        rules.push(rule);
    }
    return { ok: true, rules };
}

/**
 * Whether the filter limits who can start the trigger (an author / sender
 * rule). On GitHub, GitLab and Azure DevOps anyone who can open a pull request
 * can otherwise start it; the editor shows a hint, never a prefill.
 */
export function hasWebhookAuthorRule(form: TriggerForm): boolean {
    return form.webhookFilter.some((row) => /^payload\..*(author|sender|user|createdBy)/i.test(row.path.trim()));
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

/** The editor's state for a stored trigger. */
export function formFromTrigger(trigger: TriggerRow, fallbackTimezone = browserTimezone()): TriggerForm {
    const base = emptyTriggerForm(fallbackTimezone);
    const type: TriggerType = (TRIGGER_TYPES as readonly string[]).includes(trigger.type) ? trigger.type : 'manual';
    return {
        ...base,
        ...(trigger.type === 'webhook' ? webhookFormFields(trigger.webhook as StoredWebhook, base) : {}),
        name: trigger.name,
        description: trigger.description ?? '',
        enabled: trigger.enabled,
        type,
        ...(trigger.type === 'schedule' ? { cron: trigger.schedule.cron ?? base.cron, timezone: trigger.schedule.timezone ?? base.timezone } : {}),
        ...(trigger.type === 'once' && trigger.once.run_at ? { onceMode: 'at' as const, runAtLocal: toLocalInputValue(new Date(trigger.once.run_at)) } : {}),
        prompt: trigger.prompt ?? '',
        variables: { ...(trigger.variables ?? {}) },
        version: trigger.version ?? null,
        runClass: trigger.class === 'deferred' ? 'deferred' : 'default',
        metadataText: formatMetadataLines(trigger.metadata),
        callbackUrl: trigger.callback?.url ?? '',
        callbackSigned: Boolean(trigger.callback?.signed),
        responseFormatText: trigger.response_format ? JSON.stringify(trigger.response_format, null, 2) : '',
    };
}

export type TriggerFormProblem = { field: keyof TriggerForm; key: string };

/** The `type` and settings object of the request body, or why they cannot be sent. */
export function typeBodyFromForm(form: TriggerForm, now = new Date()): { ok: true; body: Record<string, unknown> } | { ok: false; problem: TriggerFormProblem } {
    switch (form.type) {
        case 'schedule':
            if (validateTriggerCron(form.cron)) return { ok: false, problem: { field: 'cron', key: 'previewInvalid' } };
            return { ok: true, body: { type: 'schedule', schedule: { cron: form.cron.trim(), timezone: form.timezone } } };
        case 'once': {
            if (form.onceMode === 'in') {
                if (!Number.isFinite(form.delayAmount) || form.delayAmount <= 0) return { ok: false, problem: { field: 'delayAmount', key: 'delayInvalid' } };
                const seconds = Math.round(form.delayAmount * (form.delayUnit === 'hours' ? 3600 : 60));
                return { ok: true, body: { type: 'once', once: { delay_seconds: seconds } } };
            }
            const at = new Date(form.runAtLocal);
            if (Number.isNaN(at.getTime())) return { ok: false, problem: { field: 'runAtLocal', key: 'runAtInvalid' } };
            if (at.getTime() < now.getTime()) return { ok: false, problem: { field: 'runAtLocal', key: 'oncePast' } };
            return { ok: true, body: { type: 'once', once: { run_at: at.toISOString() } } };
        }
        case 'webhook': {
            const filter = webhookFilterBody(form);
            if (!filter.ok) return { ok: false, problem: { field: 'webhookFilter', key: 'filterRowInvalid' } };
            const secret = form.webhookAuth === 'standard_webhooks' ? form.webhookSecret.trim() : '';
            return {
                ok: true,
                body: {
                    type: 'webhook',
                    webhook: {
                        preset: form.webhookPreset,
                        auth: form.webhookAuth,
                        ...(form.webhookAuth === 'header' ? { header_name: form.webhookHeaderName.trim() || DEFAULT_WEBHOOK_HEADER_NAME } : {}),
                        ...(secret ? { secret } : {}),
                        events: [...form.webhookEvents],
                        filter: filter.rules,
                        include_payload: form.webhookIncludePayload,
                    },
                },
            };
        }
        default:
            return { ok: true, body: { type: 'manual' } };
    }
}

/**
 * The create / PATCH body. `stored` (editing) leaves out the `type` and its
 * settings when they are unchanged — a once trigger that already fired keeps
 * its time — and the callback secret unless one was typed.
 */
export function triggerBodyFromForm(
    form: TriggerForm,
    declared: IAgentVariable[] | undefined,
    stored?: TriggerRow | null,
    now = new Date(),
): { ok: true; body: Record<string, unknown> } | { ok: false; problem: TriggerFormProblem } {
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
    const variables = Object.fromEntries(Object.entries(form.variables).filter(([name, value]) => declaredNames.has(name) && value !== undefined && value !== ''));
    // Standard Webhooks: the sender generates the secret, so a trigger that does not have one yet needs it pasted in.
    const storedStandard = stored?.type === 'webhook' && (stored.webhook as { auth?: string }).auth === 'standard_webhooks';
    if (form.type === 'webhook' && form.webhookAuth === 'standard_webhooks' && !storedStandard && !form.webhookSecret.trim()) {
        return { ok: false, problem: { field: 'webhookSecret', key: 'standardSecretRequired' } };
    }

    const body: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        enabled: form.enabled,
        prompt: form.prompt,
        variables: Object.keys(variables).length > 0 ? variables : null,
        version: form.version,
        class: form.runClass,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        response_format: responseFormat,
        callback: form.callbackUrl.trim()
            ? { url: form.callbackUrl.trim(), ...(form.callbackSecret ? { secret: form.callbackSecret } : {}) }
            : null,
    };

    const unchangedOnce = stored && stored.type === 'once' && form.type === 'once' && form.onceMode === 'at'
        && toLocalInputValue(new Date(String(stored.once.run_at))) === form.runAtLocal;
    if (!unchangedOnce) {
        const typeBody = typeBodyFromForm(form, now);
        if (!typeBody.ok) return typeBody;
        Object.assign(body, typeBody.body);
    }
    return { ok: true, body };
}
