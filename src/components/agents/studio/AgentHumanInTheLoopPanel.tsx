'use client';

/**
 * Approvals & questions — when the agent stops for a person.
 *
 * Two independent things: the model may ask the user a structured question, and
 * a tool call may wait for approval. Everything that decides how a request
 * behaves (how long it waits, what a timeout does, who may answer, what a new
 * message does meanwhile) is a stored setting here, not a constant.
 *
 * An agent with no `humanInTheLoop` at all has made no choice and asks like a new one (a tool that is not
 * read-only waits for approval); only switching approval off stores `enabled: false`. The per-tool table
 * lists each tool with where it comes from and what it does (reads / writes / destructive / no hints). A
 * tool that is not read-only asks by default; "Never ask" is the owner's explicit choice and goes through
 * a confirmation. The table sits inside the global switch on purpose: with the switch off nothing asks, so
 * there is nothing to set per tool. What it shows as "asks / does not ask" is computed by the same function
 * the runtime uses (`toolApprovalPolicy`).
 * A tool's exceptions (by argument) are edited in `AgentToolExceptionsModal`.
 */

import { useState } from 'react';
import {
    Alert,
    Badge,
    Button,
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
import { IconFilter, IconInfoCircle, IconPlus } from '@tabler/icons-react';
import type { IAgentClientToolConfig, IAgentHumanInTheLoopConfig } from '@/lib/database/provider/types.domain';
import { HITL_DEFAULTS, resolveHitlConfig } from '@/lib/services/agents/agentHumanInTheLoop';
import { useTranslations } from '@/lib/i18n';
import { ConfigBlock, describedSelectOption } from './ConfigSection';
import AgentToolExceptionsModal from './AgentToolExceptionsModal';
import ConfirmModal from '@/components/common/ui/ConfirmModal';
import { hitlToolRows, patchHitl, setToolChoice, setToolExceptions, type HitlToolKinds, type HitlToolRow } from './hitlSettings';
import type { AgentToolConfig } from '../session/sessionTools';

export interface AgentHumanInTheLoopPanelProps {
    value: IAgentHumanInTheLoopConfig | undefined;
    onChange: (next: IAgentHumanInTheLoopConfig | undefined) => void;
    /** The agent's tools as currently edited (unsaved bindings included) — the per-tool table lists these. */
    toolConfig: AgentToolConfig;
    /** The agent's client tools (Configure → Client tools): listed in the per-tool table too. */
    clientTools?: IAgentClientToolConfig[];
    /** What each bound tool does, by tool name (read from the tool records); a bound tool missing here counts as "no hints". */
    toolKinds?: HitlToolKinds;
}

export default function AgentHumanInTheLoopPanel({ value, onChange, toolConfig, clientTools, toolKinds }: AgentHumanInTheLoopPanelProps) {
    const t = useTranslations('agents.hitl');
    const resolved = resolveHitlConfig(value);
    const rows = hitlToolRows(toolConfig, value, clientTools, toolKinds);
    const set = (patch: Partial<IAgentHumanInTheLoopConfig>) => onChange(patchHitl(value, patch));
    const canPause = resolved.toolApprovalEnabled || resolved.askUserEnabled;
    // The row as it was when its exceptions editor opened (null = closed).
    const [editing, setEditing] = useState<HitlToolRow | null>(null);
    // The row whose "Never ask" is waiting for the owner's confirmation (null = none).
    const [confirmNever, setConfirmNever] = useState<HitlToolRow | null>(null);
    const kindLabel = {
        reads: t('kindReads'),
        writes: t('kindWrites'),
        destructive: t('kindDestructive'),
        nohints: t('kindNoHints'),
    } as const;
    const kindHint = {
        reads: t('kindReadsHint'),
        writes: t('kindWritesHint'),
        destructive: t('kindDestructiveHint'),
        nohints: t('kindNoHintsHint'),
    } as const;
    const kindColor = { reads: 'gray', writes: 'orange', destructive: 'red', nohints: 'yellow' } as const;
    const exceptionCount = (count: number) => (count === 1 ? t('exceptionsOne') : t('exceptionsMany', { count }));

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
                                                <Table.Th w={110}>{t('kindColumn')}</Table.Th>
                                                <Table.Th w={300}>{t('policyColumn')}</Table.Th>
                                                <Table.Th w={150}>{t('exceptionsColumn')}</Table.Th>
                                            </Table.Tr>
                                        </Table.Thead>
                                        <Table.Tbody>
                                            {rows.map((row) => (
                                                <Table.Tr key={row.name}>
                                                    <Table.Td>
                                                        <Group gap={6} wrap="wrap">
                                                            <Text size="sm" ff="monospace">{row.name}</Text>
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
                                                        <Tooltip label={kindHint[row.kind]} withArrow multiline w={260}>
                                                            <Badge size="xs" variant="light" color={kindColor[row.kind]}>{kindLabel[row.kind]}</Badge>
                                                        </Tooltip>
                                                    </Table.Td>
                                                    <Table.Td>
                                                        {row.readOnly || row.stale ? (
                                                            <Group gap="xs" wrap="wrap">
                                                                <Text size="xs" c="dimmed">{t(row.effective === 'always' ? 'willAsk' : 'willNotAsk')}</Text>
                                                                {row.choice !== 'default' ? (
                                                                    // A setting stored for a read-only tool, or for a tool the agent no longer has: visible, and removable.
                                                                    <Button
                                                                        size="compact-xs"
                                                                        variant="subtle"
                                                                        color="gray"
                                                                        onClick={() => onChange(setToolChoice(value, row.name, 'default'))}
                                                                    >
                                                                        {t('choiceReset', { choice: row.choice === 'always' ? t('policyAlways') : t('policyNever') })}
                                                                    </Button>
                                                                ) : null}
                                                            </Group>
                                                        ) : (
                                                            <SegmentedControl
                                                                size="xs"
                                                                value={row.effective === 'always' ? 'ask' : 'never'}
                                                                onChange={(choice) => {
                                                                    if (choice === 'never') {
                                                                        setConfirmNever(row);
                                                                        return;
                                                                    }
                                                                    // "Ask" is the default; where this tool's default is not to ask it has to be said out loud.
                                                                    onChange(setToolChoice(value, row.name, row.askChoice));
                                                                }}
                                                                data={[
                                                                    { value: 'ask', label: t('choiceAsk') },
                                                                    { value: 'never', label: t('policyNever') },
                                                                ]}
                                                                aria-label={row.name}
                                                            />
                                                        )}
                                                    </Table.Td>
                                                    <Table.Td>
                                                        <Button
                                                            size="compact-xs"
                                                            variant={row.exceptions.length > 0 ? 'light' : 'subtle'}
                                                            color={row.exceptions.length > 0 ? 'blue' : 'gray'}
                                                            leftSection={row.exceptions.length > 0 ? <IconFilter size={12} /> : <IconPlus size={12} />}
                                                            onClick={() => setEditing(row)}
                                                            aria-label={t('editExceptions', { tool: row.name })}
                                                        >
                                                            {row.exceptions.length > 0 ? exceptionCount(row.exceptions.length) : t('addException')}
                                                        </Button>
                                                    </Table.Td>
                                                </Table.Tr>
                                            ))}
                                        </Table.Tbody>
                                    </Table>
                                )}
                            </Stack>

                            <ConfirmModal
                                opened={confirmNever !== null}
                                onClose={() => setConfirmNever(null)}
                                title={t('neverConfirmTitle', { tool: confirmNever?.name ?? '' })}
                                message={t(confirmNever?.kind === 'destructive' ? 'neverConfirmDestructive' : 'neverConfirmBody', { tool: confirmNever?.name ?? '' })}
                                confirmLabel={t('policyNever')}
                                cancelLabel={t('neverConfirmCancel')}
                                confirmColor={confirmNever?.kind === 'destructive' ? 'red' : 'orange'}
                                onConfirm={() => {
                                    if (confirmNever) onChange(setToolChoice(value, confirmNever.name, 'never'));
                                    setConfirmNever(null);
                                }}
                            />

                            <AgentToolExceptionsModal
                                opened={editing !== null}
                                onClose={() => setEditing(null)}
                                row={editing}
                                hitl={value}
                                clientSchema={editing?.origin === 'client'
                                    ? clientTools?.find((tool) => tool.name.trim() === editing.name)?.inputSchema
                                    : undefined}
                                onApply={(exceptions) => {
                                    if (editing) onChange(setToolExceptions(value, editing.name, exceptions));
                                }}
                            />

                            {(toolConfig.subagents?.length ?? 0) > 0 ? (
                                <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />} p="sm">
                                    <Text size="xs">{t('subagentNote')}</Text>
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
                            description={t('approversHelp')}
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
