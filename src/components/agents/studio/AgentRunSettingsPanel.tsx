'use client';

/**
 * Callback & budget — the two per-agent run settings left after the Execution
 * settings went away (how long a call waits and how long a run may take are
 * deployment limits now, `resolveAgentRunLimits`):
 *
 *  - the default callback (`config.callback`), used for runs started without
 *    their own `callback_url`: queued runs and synchronous calls that ran past
 *    their wait window. The secret is write-only like sandbox secrets: the
 *    server returns a mask, and sending the mask back keeps the stored value.
 *  - the default session budget (`config.budget`).
 *
 * Settings take effect immediately — they are operational, not part of a
 * published version.
 */

import { useEffect, useState } from 'react';
import {
    Alert,
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
import type { IAgentCallbackConfig, IAgentConfig } from '@/lib/database/provider/types.domain';
import { ConfigBlock } from './ConfigSection';
import { SANDBOX_SECRET_MASK } from './AgentSandboxPanel';

type AgentBudgetConfig = NonNullable<IAgentConfig['budget']>;

interface RunLimits {
    syncWaitSeconds: number;
    maxDurationMinutes: number;
}

export interface AgentRunSettingsPanelProps {
    callback: IAgentCallbackConfig | undefined;
    onCallbackChange: (next: IAgentCallbackConfig | undefined) => void;
    budget: AgentBudgetConfig | undefined;
    onBudgetChange: (next: AgentBudgetConfig | undefined) => void;
}

/** Drops keys left empty so an untouched agent saves no `callback` at all. */
function compactCallback(next: IAgentCallbackConfig): IAgentCallbackConfig | undefined {
    const entries = Object.entries(next).filter(([, v]) => v !== undefined && v !== '');
    return entries.length > 0 ? (Object.fromEntries(entries) as IAgentCallbackConfig) : undefined;
}

function formatSeconds(seconds: number): string {
    return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
}

export default function AgentRunSettingsPanel({ callback, onCallbackChange, budget, onBudgetChange }: AgentRunSettingsPanelProps) {
    const t = useTranslations('agents.runSettings');
    const tb = useTranslations('agents.budget');
    const [limits, setLimits] = useState<RunLimits | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/agents/execution/limits', { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((data: RunLimits | null) => { if (!cancelled) setLimits(data); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, []);

    const currentCallback = callback ?? {};
    const setCallback = (patch: Partial<IAgentCallbackConfig>) => onCallbackChange(compactCallback({ ...currentCallback, ...patch }));
    const secretStored = callback?.secret === SANDBOX_SECRET_MASK;

    return (
        <Stack gap="lg">
            <ConfigBlock title={t('callbackTitle')}>
                <Stack gap="sm">
                    <Text size="xs" c="dimmed">{t('callbackDescription')}</Text>
                    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
                        <TextInput
                            label={t('callbackUrlLabel')}
                            placeholder="https://example.com/hooks/agent-runs"
                            value={currentCallback.url ?? ''}
                            onChange={(event) => setCallback({ url: event.currentTarget.value || undefined })}
                        />
                        <PasswordInput
                            label={t('callbackSecretLabel')}
                            description={t('callbackSecretDescription')}
                            placeholder={secretStored ? t('callbackSecretStored') : t('callbackSecretOptional')}
                            value={currentCallback.secret === SANDBOX_SECRET_MASK ? '' : currentCallback.secret ?? ''}
                            onChange={(event) => setCallback({
                                secret: event.currentTarget.value || (secretStored ? SANDBOX_SECRET_MASK : undefined),
                            })}
                            disabled={!currentCallback.url}
                        />
                    </SimpleGrid>
                </Stack>
            </ConfigBlock>

            <ConfigBlock title={tb('cfgTitle')}>
                <Stack gap="sm">
                    <NumberInput
                        label={tb('cfgAmountLabel')}
                        description={tb('cfgAmountDescription')}
                        placeholder={tb('cfgNoBudget')}
                        min={0}
                        decimalScale={4}
                        value={budget?.maxCostUsd ?? ''}
                        onChange={(v) => onBudgetChange(typeof v === 'number' && v > 0
                            ? { ...budget, maxCostUsd: v, onReach: budget?.onReach ?? 'pause' }
                            : undefined)}
                        maw={420}
                    />
                    {budget ? (
                        <Stack gap={4}>
                            <Text size="sm" fw={500}>{tb('onReachLabel')}</Text>
                            <SegmentedControl
                                w="fit-content"
                                value={budget.onReach}
                                onChange={(onReach) => onBudgetChange({ ...budget, onReach: onReach === 'stop' ? 'stop' : 'pause' })}
                                data={[
                                    { value: 'pause', label: tb('cfgPause') },
                                    { value: 'stop', label: tb('cfgStop') },
                                ]}
                            />
                            <Text size="xs" c="dimmed">
                                {budget.onReach === 'pause' ? tb('cfgPauseDescription') : tb('cfgStopDescription')}
                                {' '}{tb('cfgPerTurnNote')}
                            </Text>
                            <Switch
                                label={tb('cfgClientOverride')}
                                description={tb('cfgClientOverrideDescription')}
                                checked={budget.allowClientOverride === true}
                                onChange={(event) => onBudgetChange({ ...budget, allowClientOverride: event.currentTarget.checked })}
                            />
                        </Stack>
                    ) : null}
                </Stack>
            </ConfigBlock>

            {limits ? (
                <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} p="sm">
                    <Text size="xs">
                        {t('limitsNote', {
                            wait: formatSeconds(limits.syncWaitSeconds),
                            max: `${limits.maxDurationMinutes} min`,
                        })}
                    </Text>
                </Alert>
            ) : null}
        </Stack>
    );
}
