'use client';

/**
 * Execution — how API calls to this agent run: inline with a timeout, or in
 * the background from the queue with a callback or polling
 * (docs/guide/agent-background-execution.md).
 *
 * Every number here is an upper bound this agent opts into. The server
 * applies min(env ceiling, tenant quota, this), so the fields show the
 * current ceiling as their maximum. Settings take effect immediately — they
 * are operational, not part of a published version. The callback secret is
 * write-only like sandbox secrets: the server returns a mask, and sending
 * the mask back keeps the stored value.
 */

import { useEffect, useState } from 'react';
import {
    Alert,
    Code,
    NumberInput,
    PasswordInput,
    SegmentedControl,
    SimpleGrid,
    Stack,
    Switch,
    Text,
    TextInput,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { IAgentAttachmentsConfig, IAgentExecutionConfig } from '@/lib/database/provider/types.domain';
import { SESSION_FILES_DEFAULTS } from '@/lib/services/agents/sessionFilesConfig';
import { parseMimeTypes } from '../session/sessionAttachmentsUi';
import { ConfigBlock } from './ConfigSection';
import { SANDBOX_SECRET_MASK } from './AgentSandboxPanel';

interface ExecutionLimits {
    syncTimeoutSeconds: number;
    backgroundMaxDurationMinutes: number;
    maxConcurrentRunsPerTenant: number;
    maxConcurrentRunsPerProject: number;
}

export interface AgentExecutionPanelProps {
    value: IAgentExecutionConfig | undefined;
    onChange: (next: IAgentExecutionConfig | undefined) => void;
    /** `config.attachments` — shown (and editable) only when the page passes the pair. */
    attachments?: IAgentAttachmentsConfig;
    onAttachmentsChange?: (next: IAgentAttachmentsConfig | undefined) => void;
}

/** Drops keys left empty so an untouched agent saves no `attachments` at all. */
function compactAttachments(next: IAgentAttachmentsConfig): IAgentAttachmentsConfig | undefined {
    const entries = Object.entries(next).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0));
    return entries.length > 0 ? (Object.fromEntries(entries) as IAgentAttachmentsConfig) : undefined;
}

/** Drops keys left empty so an untouched agent saves no `execution` at all. */
function compact(next: IAgentExecutionConfig): IAgentExecutionConfig | undefined {
    const entries = Object.entries(next).filter(([, v]) => v !== undefined && v !== '');
    return entries.length > 0 ? (Object.fromEntries(entries) as IAgentExecutionConfig) : undefined;
}

/**
 * The "Allowed file types" field. It keeps the text as typed — a comma and a
 * space are part of typing the next type — and hands the parsed list up on every
 * change; the text is tidied when the field loses focus. Re-deriving the text
 * from the list on each keystroke would swallow the separator.
 */
function MimeTypesInput({
    value,
    onChange,
    label,
    description,
}: {
    value: string[];
    onChange: (next: string[]) => void;
    label: string;
    description: string;
}) {
    const [text, setText] = useState(() => value.join(', '));
    const stored = value.join('\n');
    // The agent was reloaded from outside: show what is stored, but never rewrite what is being typed.
    useEffect(() => {
        setText((current) => (parseMimeTypes(current).join('\n') === stored ? current : stored.split('\n').filter(Boolean).join(', ')));
    }, [stored]);

    return (
        <TextInput
            label={label}
            description={description}
            placeholder="application/pdf, image/*"
            value={text}
            onChange={(event) => {
                setText(event.currentTarget.value);
                onChange(parseMimeTypes(event.currentTarget.value));
            }}
            onBlur={() => setText(parseMimeTypes(text).join(', '))}
        />
    );
}

export default function AgentExecutionPanel({ value, onChange, attachments, onAttachmentsChange }: AgentExecutionPanelProps) {
    const tb = useTranslations('agents.budget');
    const ta = useTranslations('agents.attachments');
    const [limits, setLimits] = useState<ExecutionLimits | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/agents/execution/limits', { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((data: ExecutionLimits | null) => { if (!cancelled) setLimits(data); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, []);

    const current = value ?? {};
    const set = (patch: Partial<IAgentExecutionConfig>) => onChange(compact({ ...current, ...patch }));
    const currentAttachments = attachments ?? {};
    const setAttachments = (patch: Partial<IAgentAttachmentsConfig>) => onAttachmentsChange?.(compactAttachments({ ...currentAttachments, ...patch }));
    const attachmentsEnabled = currentAttachments.enabled !== false;
    const backgroundEnabled = current.backgroundEnabled !== false;
    const effectiveSync = Math.min(current.syncTimeoutSeconds ?? Infinity, limits?.syncTimeoutSeconds ?? Infinity);
    const effectiveBackground = Math.min(
        current.backgroundMaxDurationMinutes ?? Infinity,
        limits?.backgroundMaxDurationMinutes ?? Infinity,
    );

    return (
        <Stack gap="lg">
            <ConfigBlock title="Synchronous calls">
                <NumberInput
                    label="Timeout (seconds)"
                    description={
                        limits
                            ? `A call that runs longer returns 504; the turn is stopped. Ceiling here: ${limits.syncTimeoutSeconds}s.`
                            : 'A call that runs longer returns 504; the turn is stopped.'
                    }
                    placeholder={limits ? String(limits.syncTimeoutSeconds) : 'Default'}
                    min={5}
                    max={limits?.syncTimeoutSeconds}
                    allowDecimal={false}
                    value={current.syncTimeoutSeconds ?? ''}
                    onChange={(v) => set({ syncTimeoutSeconds: typeof v === 'number' ? v : undefined })}
                    maw={320}
                />
            </ConfigBlock>

            <ConfigBlock title={tb('cfgTitle')}>
                <Stack gap="sm">
                    <NumberInput
                        label={tb('cfgAmountLabel')}
                        description={tb('cfgAmountDescription')}
                        placeholder={tb('cfgNoBudget')}
                        min={0}
                        decimalScale={4}
                        value={current.sessionBudget?.maxCostUsd ?? ''}
                        onChange={(v) => set({
                            sessionBudget: typeof v === 'number' && v > 0
                                ? { ...current.sessionBudget, maxCostUsd: v, onReach: current.sessionBudget?.onReach ?? 'pause' }
                                : undefined,
                        })}
                        maw={420}
                    />
                    {current.sessionBudget ? (
                        <Stack gap={4}>
                            <Text size="sm" fw={500}>{tb('onReachLabel')}</Text>
                            <SegmentedControl
                                w="fit-content"
                                value={current.sessionBudget.onReach}
                                onChange={(onReach) => set({
                                    sessionBudget: { ...current.sessionBudget!, onReach: onReach === 'stop' ? 'stop' : 'pause' },
                                })}
                                data={[
                                    { value: 'pause', label: tb('cfgPause') },
                                    { value: 'stop', label: tb('cfgStop') },
                                ]}
                            />
                            <Text size="xs" c="dimmed">
                                {current.sessionBudget.onReach === 'pause' ? tb('cfgPauseDescription') : tb('cfgStopDescription')}
                                {' '}{tb('cfgPerTurnNote')}
                            </Text>
                            <Switch
                                label={tb('cfgClientOverride')}
                                description={tb('cfgClientOverrideDescription')}
                                checked={current.sessionBudget.allowClientOverride === true}
                                onChange={(event) => set({
                                    sessionBudget: { ...current.sessionBudget!, allowClientOverride: event.currentTarget.checked },
                                })}
                            />
                        </Stack>
                    ) : null}
                </Stack>
            </ConfigBlock>

            {onAttachmentsChange ? (
                <ConfigBlock title={ta('cfgTitle')}>
                    <Stack gap="sm">
                        <Switch
                            label={ta('cfgAccept')}
                            description={ta('cfgAcceptDescription')}
                            checked={attachmentsEnabled}
                            onChange={(event) => setAttachments({ enabled: event.currentTarget.checked ? undefined : false })}
                        />
                        {attachmentsEnabled ? (
                            <>
                                <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
                                    <NumberInput
                                        label={ta('cfgMaxFiles')}
                                        placeholder={String(SESSION_FILES_DEFAULTS.maxFiles)}
                                        min={1}
                                        max={100}
                                        allowDecimal={false}
                                        value={currentAttachments.maxFiles ?? ''}
                                        onChange={(v) => setAttachments({ maxFiles: typeof v === 'number' ? v : undefined })}
                                    />
                                    <NumberInput
                                        label={ta('cfgMaxFileSize')}
                                        placeholder={String(SESSION_FILES_DEFAULTS.maxFileSizeMb)}
                                        min={1}
                                        value={currentAttachments.maxFileSizeMb ?? ''}
                                        onChange={(v) => setAttachments({ maxFileSizeMb: typeof v === 'number' ? v : undefined })}
                                    />
                                    <NumberInput
                                        label={ta('cfgInlineTokens')}
                                        description={ta('cfgInlineTokensDescription')}
                                        placeholder={String(SESSION_FILES_DEFAULTS.inlineMaxTokens)}
                                        min={100}
                                        allowDecimal={false}
                                        value={currentAttachments.inlineMaxTokens ?? ''}
                                        onChange={(v) => setAttachments({ inlineMaxTokens: typeof v === 'number' ? v : undefined })}
                                    />
                                    <NumberInput
                                        label={ta('cfgReadPage')}
                                        placeholder={String(SESSION_FILES_DEFAULTS.readPageChars)}
                                        min={500}
                                        allowDecimal={false}
                                        value={currentAttachments.readPageChars ?? ''}
                                        onChange={(v) => setAttachments({ readPageChars: typeof v === 'number' ? v : undefined })}
                                    />
                                    <NumberInput
                                        label={ta('cfgRetention')}
                                        description={ta('cfgRetentionDescription')}
                                        placeholder={String(SESSION_FILES_DEFAULTS.retentionDays)}
                                        min={1}
                                        allowDecimal={false}
                                        value={currentAttachments.retentionDays ?? ''}
                                        onChange={(v) => setAttachments({ retentionDays: typeof v === 'number' ? v : undefined })}
                                    />
                                    <MimeTypesInput
                                        label={ta('cfgMimeTypes')}
                                        description={ta('cfgMimeTypesDescription')}
                                        value={currentAttachments.allowedMimeTypes ?? []}
                                        onChange={(allowedMimeTypes) => setAttachments({ allowedMimeTypes })}
                                    />
                                </SimpleGrid>
                                <TextInput
                                    label={ta('cfgBucket')}
                                    description={ta('cfgBucketDescription')}
                                    placeholder="conversation-files"
                                    value={currentAttachments.bucketKey ?? ''}
                                    onChange={(event) => setAttachments({ bucketKey: event.currentTarget.value.trim() || undefined })}
                                    maw={420}
                                />
                            </>
                        ) : null}
                    </Stack>
                </ConfigBlock>
            ) : null}

            <ConfigBlock title="Background runs">
                <Stack gap="sm">
                    <Switch
                        label="Allow background runs"
                        description="API callers can send background: true to queue the turn and get a run id back at once, then poll it or receive a callback."
                        checked={backgroundEnabled}
                        onChange={(event) => set({
                            backgroundEnabled: event.currentTarget.checked ? undefined : false,
                            ...(event.currentTarget.checked ? {} : { defaultMode: undefined }),
                        })}
                    />
                    {backgroundEnabled ? (
                        <>
                            <Stack gap={4}>
                                <Text size="sm" fw={500}>When a call doesn’t say</Text>
                                <SegmentedControl
                                    w="fit-content"
                                    value={current.defaultMode ?? 'sync'}
                                    onChange={(mode) => set({ defaultMode: mode === 'background' ? 'background' : undefined })}
                                    data={[
                                        { value: 'sync', label: 'Run synchronously' },
                                        { value: 'background', label: 'Run in background' },
                                    ]}
                                />
                                <Text size="xs" c="dimmed">
                                    An explicit <Code>background: true|false</Code> in the request always wins.
                                </Text>
                            </Stack>
                            <NumberInput
                                label="Maximum run time (minutes)"
                                description={
                                    limits
                                        ? `A run still going after this is stopped and marked failed. Ceiling here: ${limits.backgroundMaxDurationMinutes} min.`
                                        : 'A run still going after this is stopped and marked failed.'
                                }
                                placeholder={limits ? String(limits.backgroundMaxDurationMinutes) : 'Default'}
                                min={1}
                                max={limits?.backgroundMaxDurationMinutes}
                                allowDecimal={false}
                                value={current.backgroundMaxDurationMinutes ?? ''}
                                onChange={(v) => set({ backgroundMaxDurationMinutes: typeof v === 'number' ? v : undefined })}
                                maw={320}
                            />
                        </>
                    ) : null}
                </Stack>
            </ConfigBlock>

            {backgroundEnabled ? (
                <ConfigBlock title="Default callback">
                    <Stack gap="sm">
                        <Text size="xs" c="dimmed">
                            Used for background runs started without their own <Code>callback_url</Code>. The
                            result is POSTed there when the run finishes, fails or is canceled.
                        </Text>
                        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
                            <TextInput
                                label="Callback URL"
                                placeholder="https://example.com/hooks/agent-runs"
                                value={current.callbackUrl ?? ''}
                                onChange={(event) => set({ callbackUrl: event.currentTarget.value || undefined })}
                            />
                            <PasswordInput
                                label="Signing secret"
                                description="16+ characters. Sent back as X-Cognipeer-Signature: t=…,v1=HMAC-SHA256."
                                placeholder={current.callbackSecret === SANDBOX_SECRET_MASK ? 'Stored — type to replace' : 'Optional'}
                                value={current.callbackSecret === SANDBOX_SECRET_MASK ? '' : current.callbackSecret ?? ''}
                                onChange={(event) => set({ callbackSecret: event.currentTarget.value || (value?.callbackSecret === SANDBOX_SECRET_MASK ? SANDBOX_SECRET_MASK : undefined) })}
                                disabled={!current.callbackUrl}
                            />
                        </SimpleGrid>
                    </Stack>
                </ConfigBlock>
            ) : null}

            <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} p="sm">
                <Text size="xs">
                    Effective now: sync timeout{' '}
                    <b>{Number.isFinite(effectiveSync) ? `${effectiveSync}s` : '—'}</b>
                    {backgroundEnabled ? (
                        <>
                            {' '}· background max <b>{Number.isFinite(effectiveBackground) ? `${effectiveBackground} min` : '—'}</b>
                            {limits && limits.maxConcurrentRunsPerTenant > 0
                                ? <> · {limits.maxConcurrentRunsPerTenant} concurrent runs per tenant</>
                                : null}
                        </>
                    ) : <> · background runs off</>}
                    . Applies immediately — no publish needed.
                </Text>
            </Alert>
        </Stack>
    );
}
