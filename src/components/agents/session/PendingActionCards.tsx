'use client';

/**
 * Approval and question cards for a turn that stopped for a person.
 *
 * Rendered by the transcript on the paused assistant message — the same
 * components serve the live session and a reopened one, because a request that
 * was raised yesterday is answered exactly like one raised a second ago. A
 * settled action shrinks to one line saying how it ended.
 *
 * The cards only collect and validate input (`pendingActions.ts` decides what
 * is sent); the transcript owns the resolve call and the continuation.
 */

import { useState } from 'react';
import {
    Alert,
    Badge,
    Box,
    Button,
    Checkbox,
    Code,
    Group,
    Paper,
    Radio,
    Stack,
    Text,
    TextInput,
    Textarea,
} from '@mantine/core';
import { IconCheck, IconHandStop, IconHelp, IconInfoCircle, IconX } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import {
    answerText,
    argsDiffer,
    buildAnswers,
    buildApprovalBody,
    emptyDraft,
    formatArgs,
    isRequired,
    optionValue,
    parseEditedArgs,
    pickOption,
    resolvedKind,
    typeAnswer,
    type AnswerBlockedReason,
    type ApprovalResolveBody,
    type PendingActionView,
    type QuestionResolveBody,
    type ResolveBody,
} from './pendingActions';
import classes from './PendingActionCards.module.css';

interface CardProps {
    action: PendingActionView;
    /** Some resolve call is in flight — nothing else can be sent until it returns. */
    busy: boolean;
    /** This very action is the one being sent. */
    resolving: boolean;
}

export function ToolApprovalCard({
    action,
    busy,
    resolving,
    onResolve,
}: CardProps & { onResolve: (body: ApprovalResolveBody) => void }) {
    const t = useTranslations('agents.hitl');
    const [editing, setEditing] = useState(false);
    const [argsText, setArgsText] = useState(() => formatArgs(action.args));
    const [comment, setComment] = useState('');
    const [remember, setRemember] = useState(false);

    const parsed = editing ? parseEditedArgs(argsText) : null;
    const argsError = parsed && !parsed.ok
        ? (parsed.error === 'invalid_json' ? t('argsInvalidJson') : t('argsNotObject'))
        : null;
    const edited = parsed?.ok ? parsed.value : undefined;
    const changed = Boolean(edited && argsDiffer(action.args, edited));

    const send = (decision: 'allow' | 'deny') => {
        if (decision === 'allow' && argsError) return;
        onResolve(buildApprovalBody({
            decision,
            comment,
            edited,
            original: action.args,
            remember,
        }));
    };

    return (
        <Paper withBorder radius="md" p="sm" className={classes.card}>
            <Stack gap="xs">
                <Group gap={6} wrap="wrap">
                    <Badge size="xs" variant="light" color="orange" leftSection={<IconHandStop size={10} />}>
                        {t('approvalNeeded')}
                    </Badge>
                    <Text size="sm" fw={600} ff="monospace">{action.toolName ?? '—'}</Text>
                    {changed ? <Badge size="xs" variant="outline" color="orange">{t('argsEdited')}</Badge> : null}
                </Group>

                <Box>
                    <Group justify="space-between" mb={2}>
                        <Text size="10px" c="dimmed" tt="uppercase" fw={600}>{t('arguments')}</Text>
                        <Button
                            size="compact-xs"
                            variant="subtle"
                            color="gray"
                            disabled={busy}
                            onClick={() => {
                                if (editing) setArgsText(formatArgs(action.args));
                                setEditing((value) => !value);
                            }}
                        >
                            {editing ? t('resetArguments') : t('editArguments')}
                        </Button>
                    </Group>
                    {editing ? (
                        <Textarea
                            className={classes.argsEditor}
                            value={argsText}
                            onChange={(event) => setArgsText(event.currentTarget.value)}
                            autosize
                            minRows={3}
                            maxRows={14}
                            error={argsError}
                            disabled={busy}
                            aria-label={t('arguments')}
                        />
                    ) : (
                        <Code block className={classes.args}>{formatArgs(action.args)}</Code>
                    )}
                </Box>

                <Textarea
                    size="xs"
                    label={t('denyReason')}
                    placeholder={t('denyReasonPlaceholder')}
                    value={comment}
                    onChange={(event) => setComment(event.currentTarget.value)}
                    autosize
                    minRows={1}
                    maxRows={4}
                    disabled={busy}
                />
                <Checkbox
                    size="xs"
                    label={t('remember')}
                    checked={remember}
                    onChange={(event) => setRemember(event.currentTarget.checked)}
                    disabled={busy}
                />

                <Group justify="flex-end" gap="xs">
                    <Button
                        size="xs"
                        variant="default"
                        color="red"
                        leftSection={<IconX size={13} />}
                        disabled={busy}
                        loading={resolving && busy}
                        onClick={() => send('deny')}
                    >
                        {t('deny')}
                    </Button>
                    <Button
                        size="xs"
                        leftSection={<IconCheck size={13} />}
                        disabled={busy || Boolean(argsError)}
                        loading={resolving && busy}
                        onClick={() => send('allow')}
                    >
                        {t('approve')}
                    </Button>
                </Group>
            </Stack>
        </Paper>
    );
}

export function QuestionCard({
    action,
    busy,
    resolving,
    onResolve,
}: CardProps & { onResolve: (body: QuestionResolveBody) => void }) {
    const t = useTranslations('agents.hitl');
    const questions = action.questions ?? [];
    const [draft, setDraft] = useState(() => emptyDraft(questions));
    const built = buildAnswers(questions, draft);
    // The SDK allows typed answers unless the agent turned them off.
    const freeText = action.allowFreeText !== false;

    return (
        <Paper withBorder radius="md" p="sm" className={classes.card}>
            <Stack gap="sm">
                <Group gap={6}>
                    <Badge size="xs" variant="light" color="orange" leftSection={<IconHelp size={10} />}>
                        {t('questionNeeded')}
                    </Badge>
                </Group>

                {questions.map((question, index) => {
                    const options = question.options ?? [];
                    const picked = draft.picked[index] ?? [];
                    const canType = freeText || options.length === 0;
                    return (
                        <Stack key={`${index}-${question.question}`} gap={6}>
                            <Group gap={6} wrap="wrap" align="center">
                                {question.header ? (
                                    <Badge size="xs" variant="outline" color="gray">{question.header}</Badge>
                                ) : null}
                                <Text size="sm" fw={500}>
                                    {question.question}
                                    {isRequired(question) ? (
                                        <Text component="span" c="red" aria-label={t('required')}> *</Text>
                                    ) : null}
                                </Text>
                            </Group>

                            {options.length > 0 ? (
                                question.multiSelect ? (
                                    <Checkbox.Group
                                        value={picked}
                                        onChange={(values) => setDraft((current) => ({
                                            ...current,
                                            picked: current.picked.map((entry, i) => (i === index ? values : entry)),
                                        }))}
                                        description={t('pickMany')}
                                    >
                                        <Stack gap={6} mt={6}>
                                            {options.map((option) => (
                                                <Checkbox
                                                    key={optionValue(option)}
                                                    value={optionValue(option)}
                                                    label={option.label}
                                                    description={option.description}
                                                    size="xs"
                                                    disabled={busy}
                                                    classNames={{ description: classes.optionDescription }}
                                                />
                                            ))}
                                        </Stack>
                                    </Checkbox.Group>
                                ) : (
                                    <Radio.Group
                                        value={picked[0] ?? ''}
                                        onChange={(value) => setDraft((current) => pickOption(current, index, question, value))}
                                        description={t('pickOne')}
                                    >
                                        <Stack gap={6} mt={6}>
                                            {options.map((option) => (
                                                <Radio
                                                    key={optionValue(option)}
                                                    value={optionValue(option)}
                                                    label={option.label}
                                                    description={option.description}
                                                    size="xs"
                                                    disabled={busy}
                                                    classNames={{ description: classes.optionDescription }}
                                                />
                                            ))}
                                        </Stack>
                                    </Radio.Group>
                                )
                            ) : null}

                            {canType ? (
                                <TextInput
                                    size="xs"
                                    placeholder={options.length > 0
                                        ? t('otherAnswer')
                                        : (question.placeholder ?? t('answerPlaceholder'))}
                                    value={draft.typed[index] ?? ''}
                                    onChange={(event) => {
                                        const text = event.currentTarget.value;
                                        setDraft((current) => typeAnswer(current, index, question, text));
                                    }}
                                    disabled={busy}
                                    aria-label={question.question}
                                />
                            ) : null}
                        </Stack>
                    );
                })}

                {!built.ok ? <Text size="xs" c="dimmed">{t('answerRequired')}</Text> : null}

                <Group justify="flex-end" gap="xs">
                    <Button
                        size="xs"
                        variant="default"
                        disabled={busy}
                        loading={resolving && busy}
                        onClick={() => onResolve({ answers: {}, cancelled: true })}
                    >
                        {t('skip')}
                    </Button>
                    <Button
                        size="xs"
                        leftSection={<IconCheck size={13} />}
                        disabled={busy || !built.ok}
                        loading={resolving && busy}
                        onClick={() => { if (built.ok) onResolve({ answers: built.answers }); }}
                    >
                        {t('send')}
                    </Button>
                </Group>
            </Stack>
        </Paper>
    );
}

/** One line for an action that is no longer open. */
function SettledAction({ action }: { action: PendingActionView }) {
    const t = useTranslations('agents.hitl');
    const kind = resolvedKind(action);
    if (!kind) return null;

    const label = {
        approved: t('approved'),
        approved_edited: t('approvedEdited'),
        denied: action.resolution?.comment
            ? t('deniedWithReason', { reason: action.resolution.comment })
            : t('denied'),
        answered: t('answered'),
        skipped: t('skipped'),
        expired: t('expired'),
        cancelled: t('cancelled'),
    }[kind];
    const tone = kind === 'approved' || kind === 'approved_edited' || kind === 'answered'
        ? classes.settledApproved
        : kind === 'denied' ? classes.settledDenied : '';
    const answers = kind === 'answered' ? action.resolution?.answers : undefined;

    return (
        <Paper withBorder radius="md" px="sm" py={6} className={`${classes.card} ${classes.settled} ${tone}`}>
            <Stack gap={2}>
                <Group gap={6} wrap="wrap">
                    {kind === 'denied' || kind === 'expired' || kind === 'cancelled'
                        ? <IconX size={13} />
                        : <IconCheck size={13} />}
                    <Text size="xs" fw={600}>{label}</Text>
                    {action.toolName ? <Text size="xs" ff="monospace" c="dimmed">{action.toolName}</Text> : null}
                    {action.resolution?.rememberForSession ? (
                        <Badge size="xs" variant="outline" color="gray">{t('rememberedNote')}</Badge>
                    ) : null}
                </Group>
                {answers ? (
                    <Stack gap={0}>
                        {Object.entries(answers).map(([question, value]) => (
                            <Text key={question} size="xs" c="dimmed">
                                {question} — <Text component="span" c="inherit" fw={500}>{answerText(value)}</Text>
                            </Text>
                        ))}
                    </Stack>
                ) : null}
            </Stack>
        </Paper>
    );
}

/** The sentence (`agents.hitl.*`) for each reason the server gives why the viewer cannot answer. */
const BLOCKED_TEXT: Record<AnswerBlockedReason, string> = {
    approvers_owner: 'blockedApproversOwner',
    approvers_admin: 'blockedApproversAdmin',
    approvers_member: 'blockedApproversMember',
    session_owner: 'blockedSessionOwner',
    policy: 'blockedPolicy',
    unavailable: 'blockedUnavailable',
};

export interface PendingActionListProps {
    actions: PendingActionView[];
    /** A resolve call is in flight. */
    busy: boolean;
    /** The action being sent, if any. */
    resolvingId?: string | null;
    onResolve: (actionId: string, body: ResolveBody) => void;
    /**
     * Why the server says the viewer cannot answer an open request, when it does - a notice above the open
     * requests. The cards stay usable: the server decides again when the answer is sent.
     */
    blocked?: AnswerBlockedReason | null;
}

/** The approvals and questions a paused turn is waiting on, open ones as cards and the rest as one-liners. */
export default function PendingActionList({ actions, busy, resolvingId, onResolve, blocked }: PendingActionListProps) {
    const t = useTranslations('agents.hitl');
    if (actions.length === 0) return null;
    const open = actions.some((action) => action.status === 'pending');
    return (
        <Stack gap="xs" mt="xs">
            {open && blocked ? (
                <Alert variant="light" color={blocked === 'unavailable' ? 'orange' : 'gray'} icon={<IconInfoCircle size={14} />} p="xs" data-testid="answer-blocked">
                    <Text size="xs">{t(BLOCKED_TEXT[blocked])}</Text>
                </Alert>
            ) : null}
            {actions.map((action) => {
                if (action.status !== 'pending') return <SettledAction key={action.id} action={action} />;
                return action.kind === 'user_question' ? (
                    <QuestionCard
                        key={action.id}
                        action={action}
                        busy={busy}
                        resolving={resolvingId === action.id}
                        onResolve={(body) => onResolve(action.id, body)}
                    />
                ) : (
                    <ToolApprovalCard
                        key={action.id}
                        action={action}
                        busy={busy}
                        resolving={resolvingId === action.id}
                        onResolve={(body) => onResolve(action.id, body)}
                    />
                );
            })}
        </Stack>
    );
}
