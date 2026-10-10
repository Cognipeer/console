'use client';

/**
 * Approvals & questions — when the agent stops for a person.
 *
 * Two independent things: the model may ask the user a structured question, and
 * a tool call may wait for approval. Everything that decides how a request
 * behaves (how long it waits, what a timeout does, who may answer, what a new
 * message does meanwhile) is a stored setting here, not a constant.
 *
 * An agent with no `humanInTheLoop` at all never pauses; the first switch turned
 * on creates the object. What the per-tool table shows as "asks / does not ask"
 * is computed by the same function the runtime uses (`toolApprovalPolicy`).
 */

import {
    Alert,
    Badge,
    Group,
    NumberInput,
    SegmentedControl,
    Select,
    Stack,
    Switch,
    Table,
    Text,
    Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import type { IAgentHumanInTheLoopConfig } from '@/lib/database/provider/types.domain';
import { HITL_DEFAULTS, resolveHitlConfig } from '@/lib/services/agents/agentHumanInTheLoop';
import { useTranslations } from '@/lib/i18n';
import { ConfigBlock, describedSelectOption } from './ConfigSection';
import { hitlToolRows, patchHitl, setToolChoice, type ToolPolicyChoice } from './hitlSettings';
import type { AgentToolConfig } from '../session/sessionTools';

export interface AgentHumanInTheLoopPanelProps {
    value: IAgentHumanInTheLoopConfig | undefined;
    onChange: (next: IAgentHumanInTheLoopConfig | undefined) => void;
    /** The agent's tools as currently edited (unsaved bindings included) — the per-tool table lists these. */
    toolConfig: AgentToolConfig;
}

export default function AgentHumanInTheLoopPanel({ value, onChange, toolConfig }: AgentHumanInTheLoopPanelProps) {
    const t = useTranslations('agents.hitl');
    const resolved = resolveHitlConfig(value);
    const rows = hitlToolRows(toolConfig, value);
    const set = (patch: Partial<IAgentHumanInTheLoopConfig>) => onChange(patchHitl(value, patch));
    const canPause = resolved.toolApprovalEnabled || resolved.askUserEnabled;

    const timeoutOptions = [
        { value: 'deny', label: t('onTimeoutDeny'), description: t('onTimeoutDenyDescription') },
        { value: 'cancel', label: t('onTimeoutCancel'), description: t('onTimeoutCancelDescription') },
    ];
    const unattendedOptions = [
        { value: 'deny', label: t('unattendedDeny'), description: t('unattendedDenyDescription') },
        { value: 'pause', label: t('unattendedPause'), description: t('unattendedPauseDescription') },
        { value: 'allow', label: t('unattendedAllow'), description: t('unattendedAllowDescription') },
    ];
    const pendingMessageOptions = [
        { value: 'reject', label: t('onUserMessageReject'), description: t('onUserMessageRejectDescription') },
        { value: 'cancel_pending', label: t('onUserMessageCancel'), description: t('onUserMessageCancelDescription') },
    ];

    return (
        <Stack gap="lg">
            <ConfigBlock title={t('askUserTitle')}>
                <Stack gap="sm">
                    <Switch
                        label={t('askUserSwitch')}
                        description={t('askUserSwitchDescription')}
                        checked={resolved.askUserEnabled}
                        onChange={(event) => set({
                            askUser: { ...(value?.askUser ?? {}), enabled: event.currentTarget.checked },
                        })}
                    />
                    {resolved.askUserEnabled ? (
                        <Switch
                            label={t('allowFreeText')}
                            description={t('allowFreeTextDescription')}
                            checked={resolved.allowFreeText}
                            onChange={(event) => set({
                                askUser: { enabled: true, allowFreeText: event.currentTarget.checked },
                            })}
                        />
                    ) : null}
                </Stack>
            </ConfigBlock>

            <ConfigBlock title={t('approvalTitle')}>
                <Stack gap="sm">
                    <Switch
                        label={t('approvalSwitch')}
                        description={t('approvalSwitchDescription')}
                        checked={resolved.toolApprovalEnabled}
                        onChange={(event) => set({
                            toolApproval: { ...(value?.toolApproval ?? {}), enabled: event.currentTarget.checked },
                        })}
                    />
                    {resolved.toolApprovalEnabled ? (
                        <>
                            <Stack gap={4}>
                                <Text size="sm" fw={500}>{t('defaultPolicy')}</Text>
                                <SegmentedControl
                                    w="fit-content"
                                    value={resolved.defaultPolicy}
                                    onChange={(policy) => set({
                                        toolApproval: {
                                            ...(value?.toolApproval ?? { enabled: true }),
                                            enabled: true,
                                            defaultPolicy: policy === 'never' ? 'never' : 'always',
                                        },
                                    })}
                                    data={[
                                        { value: 'always', label: t('policyAlways') },
                                        { value: 'never', label: t('policyNever') },
                                    ]}
                                />
                                <Text size="xs" c="dimmed">{t('defaultPolicyDescription')}</Text>
                            </Stack>

                            <Stack gap={6}>
                                <Text size="sm" fw={500}>{t('toolsTitle')}</Text>
                                <Text size="xs" c="dimmed">{t('toolsDescription')}</Text>
                                {rows.length === 0 ? (
                                    <Text size="xs" c="dimmed" fs="italic">{t('toolsEmpty')}</Text>
                                ) : (
                                    <Table verticalSpacing={6} withTableBorder>
                                        <Table.Thead>
                                            <Table.Tr>
                                                <Table.Th>{t('toolColumn')}</Table.Th>
                                                <Table.Th w={150}>{t('sourceColumn')}</Table.Th>
                                                <Table.Th w={380}>{t('policyColumn')}</Table.Th>
                                            </Table.Tr>
                                        </Table.Thead>
                                        <Table.Tbody>
                                            {rows.map((row) => (
                                                <Table.Tr key={row.name}>
                                                    <Table.Td>
                                                        <Group gap={6} wrap="wrap">
                                                            <Text size="sm" ff="monospace">{row.name}</Text>
                                                            {row.readOnly ? (
                                                                <Tooltip label={t('readOnlyHint')} withArrow>
                                                                    <Badge size="xs" variant="outline" color="gray">
                                                                        {t('readOnlyHint')}
                                                                    </Badge>
                                                                </Tooltip>
                                                            ) : null}
                                                            {row.stale ? (
                                                                <Badge size="xs" variant="light" color="yellow">{t('staleHint')}</Badge>
                                                            ) : null}
                                                        </Group>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <Text size="xs" c="dimmed">
                                                            {row.origin === 'unknown' ? '—' : row.origin}
                                                            {row.sourceKey ? ` · ${row.sourceKey}` : ''}
                                                        </Text>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <Group gap="xs" wrap="wrap">
                                                            <SegmentedControl
                                                                size="xs"
                                                                value={row.choice}
                                                                onChange={(choice) => onChange(setToolChoice(value, row.name, choice as ToolPolicyChoice))}
                                                                data={[
                                                                    { value: 'default', label: t('policyDefault') },
                                                                    { value: 'always', label: t('policyAlways') },
                                                                    { value: 'never', label: t('policyNever') },
                                                                ]}
                                                                aria-label={row.name}
                                                            />
                                                            <Badge
                                                                size="xs"
                                                                variant="light"
                                                                color={row.effective === 'always' ? 'orange' : 'gray'}
                                                            >
                                                                {row.effective === 'always' ? t('willAsk') : t('willNotAsk')}
                                                            </Badge>
                                                        </Group>
                                                    </Table.Td>
                                                </Table.Tr>
                                            ))}
                                        </Table.Tbody>
                                    </Table>
                                )}
                            </Stack>

                            {(toolConfig.subagents?.length ?? 0) > 0 ? (
                                <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />} p="sm">
                                    <Text size="xs">{t('subagentWarning')}</Text>
                                </Alert>
                            ) : null}
                        </>
                    ) : null}
                </Stack>
            </ConfigBlock>

            {canPause ? (
                <ConfigBlock title={t('requestsTitle')}>
                    <Stack gap="sm">
                        <NumberInput
                            label={t('timeoutMinutes')}
                            description={t('timeoutDescription')}
                            placeholder={String(HITL_DEFAULTS.timeoutMinutes)}
                            min={0}
                            max={60 * 24 * 365}
                            allowDecimal={false}
                            allowNegative={false}
                            value={value?.timeoutMinutes ?? ''}
                            onChange={(next) => set({ timeoutMinutes: typeof next === 'number' ? next : undefined })}
                            maw={320}
                        />
                        <Select
                            label={t('onTimeout')}
                            data={timeoutOptions}
                            renderOption={describedSelectOption(timeoutOptions)}
                            value={resolved.onTimeout}
                            onChange={(next) => set({ onTimeout: next === 'cancel' ? 'cancel' : 'deny' })}
                            allowDeselect={false}
                            maw={360}
                        />
                        <Select
                            label={t('approvers')}
                            data={[
                                { value: 'owner', label: t('approversOwner') },
                                { value: 'owner_or_admin', label: t('approversOwnerOrAdmin') },
                                { value: 'project_members', label: t('approversProjectMembers') },
                            ]}
                            value={resolved.approvers}
                            onChange={(next) => set({
                                approvers: next === 'owner' || next === 'project_members' ? next : 'owner_or_admin',
                            })}
                            allowDeselect={false}
                            maw={360}
                        />
                        <Select
                            label={t('onUserMessage')}
                            data={pendingMessageOptions}
                            renderOption={describedSelectOption(pendingMessageOptions)}
                            value={resolved.onUserMessageWhilePending}
                            onChange={(next) => set({ onUserMessageWhilePending: next === 'cancel_pending' ? 'cancel_pending' : 'reject' })}
                            allowDeselect={false}
                            maw={360}
                        />
                        <Select
                            label={t('unattended')}
                            data={unattendedOptions}
                            renderOption={describedSelectOption(unattendedOptions)}
                            value={resolved.unattended}
                            onChange={(next) => set({ unattended: next === 'pause' || next === 'allow' ? next : 'deny' })}
                            allowDeselect={false}
                            maw={420}
                        />
                    </Stack>
                </ConfigBlock>
            ) : null}

            <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} p="sm">
                <Text size="xs">{t('effectiveNow')}</Text>
            </Alert>
        </Stack>
    );
}
