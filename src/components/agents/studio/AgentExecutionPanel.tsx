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
    Group,
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
import type { IAgentExecutionConfig } from '@/lib/database/provider/types.domain';
import { ConfigBlock } from './ConfigSection';

export const EXECUTION_SECRET_MASK = '••••••';

interface ExecutionLimits {
    syncTimeoutSeconds: number;
    backgroundMaxDurationMinutes: number;
    maxConcurrentRunsPerTenant: number;
    maxConcurrentRunsPerProject: number;
}

export interface AgentExecutionPanelProps {
    value: IAgentExecutionConfig | undefined;
    onChange: (next: IAgentExecutionConfig | undefined) => void;
    disabled?: boolean;
}

/** Drops keys left empty so an untouched agent saves no `execution` at all. */
function compact(next: IAgentExecutionConfig): IAgentExecutionConfig | undefined {
    const entries = Object.entries(next).filter(([, v]) => v !== undefined && v !== '');
    return entries.length > 0 ? (Object.fromEntries(entries) as IAgentExecutionConfig) : undefined;
}

export default function AgentExecutionPanel({ value, onChange, disabled }: AgentExecutionPanelProps) {
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
    const backgroundEnabled = current.backgroundEnabled !== false;
    const effectiveSync = Math.min(current.syncTimeoutSeconds ?? Infinity, limits?.syncTimeoutSeconds ?? Infinity);
    const effectiveBackground = Math.min(
        current.backgroundMaxDurationMinutes ?? Infinity,
        limits?.backgroundMaxDurationMinutes ?? Infinity,
    );

    return (
        <Stack gap="lg">
            <ConfigBlock title="Synchronous calls">
                <Stack gap="sm">
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
                        disabled={disabled}
                        maw={320}
                    />
                </Stack>
            </ConfigBlock>

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
                        disabled={disabled}
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
                                    disabled={disabled}
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
                                disabled={disabled}
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
                                disabled={disabled}
                            />
                            <PasswordInput
                                label="Signing secret"
                                description="16+ characters. Sent back as X-Cognipeer-Signature: t=…,v1=HMAC-SHA256."
                                placeholder={current.callbackSecret === EXECUTION_SECRET_MASK ? 'Stored — type to replace' : 'Optional'}
                                value={current.callbackSecret === EXECUTION_SECRET_MASK ? '' : current.callbackSecret ?? ''}
                                onChange={(event) => set({ callbackSecret: event.currentTarget.value || (value?.callbackSecret === EXECUTION_SECRET_MASK ? EXECUTION_SECRET_MASK : undefined) })}
                                disabled={disabled || !current.callbackUrl}
                            />
                        </SimpleGrid>
                    </Stack>
                </ConfigBlock>
            ) : null}

            <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} p="sm">
                <Group gap={6}>
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
                </Group>
            </Alert>
        </Stack>
    );
}
