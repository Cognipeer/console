'use client';

/**
 * Approvals & questions → a tool's exceptions: "when <argument> matches
 * <pattern> → <action>", one line each.
 *
 * Opened from the per-tool table. Edits stay local until Apply, which hands the
 * list back for the agent draft; Cancel / Escape drops them. "Try a call" runs
 * the lines being edited through the runtime's own decision function
 * (`previewToolCall` → `decideToolCall`), so what it shows is what a run does.
 */

import { useEffect, useMemo, useState } from 'react';
import {
    ActionIcon,
    Alert,
    Autocomplete,
    Badge,
    Button,
    Group,
    Select,
    Stack,
    Text,
    Textarea,
    TextInput,
} from '@mantine/core';
import { IconFilter, IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import FormShell, { FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import type {
    AgentToolApprovalException,
    AgentToolApprovalExceptionAction,
    IAgentHumanInTheLoopConfig,
} from '@/lib/database/provider/types.domain';
import {
    exceptionActionsFor,
    HITL_EXCEPTION_LIMITS,
    type ExceptionIssue,
} from '@/lib/services/agents/agentHitlExceptions';
import { useTranslations } from '@/lib/i18n';
import { describedSelectOption } from './ConfigSection';
import { cleanException, exceptionIssues, previewToolCall, schemaFieldPaths, type HitlToolRow } from './hitlSettings';

export interface AgentToolExceptionsModalProps {
    opened: boolean;
    onClose: () => void;
    /** The tool whose exceptions are edited: a row of the per-tool table, taken when the editor opens. */
    row: HitlToolRow | null;
    /** The agent's approval settings as currently edited: the tool's own setting is read from here. */
    hitl: IAgentHumanInTheLoopConfig | undefined;
    /** A client tool's argument schema (Configure → Client tools); other tools' schemas are fetched. */
    clientSchema?: unknown;
    onApply: (exceptions: AgentToolApprovalException[]) => void;
}

interface DraftLine {
    id: number;
    field: string;
    pattern: string;
    action: AgentToolApprovalExceptionAction;
}

let nextLineId = 1;

function toDraft(exception: AgentToolApprovalException): DraftLine {
    return { id: nextLineId++, field: exception.field ?? '', pattern: exception.pattern, action: exception.action };
}

/** A line nobody has filled in yet: ignored rather than reported. */
function isBlank(line: DraftLine): boolean {
    return !line.field.trim() && !line.pattern.trim();
}

/**
 * The argument names of a tool, for the field suggestions: from its schema
 * where the dashboard can see one (a bound tool's action, a legacy MCP server's
 * tool, a client tool). Built-in tools have no schema here, so the field stays
 * free text for them.
 */
function useArgumentFields(row: HitlToolRow | null, clientSchema: unknown, opened: boolean): string[] {
    const [fetched, setFetched] = useState<string[]>([]);
    const origin = row?.origin;
    const sourceKey = row?.sourceKey;
    const name = row?.name;

    useEffect(() => {
        setFetched([]);
        if (!opened || !name || !sourceKey || (origin !== 'tool' && origin !== 'mcp')) return;
        let cancelled = false;
        void (async () => {
            try {
                if (origin === 'tool') {
                    const res = await fetch('/api/tools?status=active', { cache: 'no-store' });
                    if (!res.ok) return;
                    const data = (await res.json()) as { tools?: Array<{ key: string; actions?: Array<{ key: string; inputSchema?: unknown }> }> };
                    const action = data.tools?.find((tool) => tool.key === sourceKey)?.actions?.find((a) => a.key === name);
                    if (!cancelled) setFetched(schemaFieldPaths(action?.inputSchema));
                } else {
                    const res = await fetch('/api/mcp?status=active', { cache: 'no-store' });
                    if (!res.ok) return;
                    const data = (await res.json()) as { servers?: Array<{ key: string; tools?: Array<{ name: string; inputSchema?: unknown }> }> };
                    const tool = data.servers?.find((server) => server.key === sourceKey)?.tools?.find((t) => t.name === name);
                    if (!cancelled) setFetched(schemaFieldPaths(tool?.inputSchema));
                }
            } catch {
                // No suggestions: the field is free text anyway.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [opened, origin, sourceKey, name]);

    return origin === 'client' ? schemaFieldPaths(clientSchema) : fetched;
}

function parseSampleArgs(text: string): { value?: Record<string, unknown>; invalid: boolean } {
    if (!text.trim()) return { invalid: false };
    try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { invalid: true };
        return { value: parsed as Record<string, unknown>, invalid: false };
    } catch {
        return { invalid: true };
    }
}

export default function AgentToolExceptionsModal({ opened, onClose, row, hitl, clientSchema, onApply }: AgentToolExceptionsModalProps) {
    const t = useTranslations('agents.hitl');
    const [lines, setLines] = useState<DraftLine[]>([]);
    const [sample, setSample] = useState('');

    useEffect(() => {
        if (!opened) return;
        setLines((row?.exceptions ?? []).map(toDraft));
        setSample('');
    }, [opened, row]);

    const schemaFields = useArgumentFields(row, clientSchema, opened);
    const fieldOptions = useMemo(
        () => [...new Set([...schemaFields, ...lines.map((line) => line.field.trim()).filter(Boolean)])],
        [schemaFields, lines],
    );

    if (!row) return null;

    const policy = row.effective;
    const offered = exceptionActionsFor(policy);
    const actionLabel: Record<AgentToolApprovalExceptionAction, string> = {
        ask: t('actionAsk'),
        allow: t('actionAllow'),
        deny: t('actionDeny'),
    };
    const actionDescription: Record<AgentToolApprovalExceptionAction, string> = {
        ask: t('actionAskDescription'),
        allow: t('actionAllowDescription'),
        deny: t('actionDenyDescription'),
    };
    // A line keeps the action it was saved with even when the tool's setting has
    // since made it redundant, so opening the editor never changes it silently.
    const actionOptionsFor = (current: AgentToolApprovalExceptionAction) =>
        [...new Set([...offered, current])].map((action) => ({
            value: action,
            label: actionLabel[action],
            description: actionDescription[action],
        }));

    const filled = lines.filter((line) => !isBlank(line));
    const asExceptions = (list: DraftLine[]): AgentToolApprovalException[] =>
        list.map(({ field, pattern, action }) => ({ ...(field.trim() ? { field } : {}), pattern, action }));
    const issues = exceptionIssues(asExceptions(lines));
    const issueOf = (index: number) => (isBlank(lines[index]) ? null : issues[index]);
    const invalidCount = lines.filter((_, index) => issueOf(index)).length;
    const atLimit = lines.length >= HITL_EXCEPTION_LIMITS.perTool;

    const issueText = (issue: ExceptionIssue): string => {
        switch (issue) {
            case 'pattern_required': return t('issuePatternRequired');
            case 'pattern_too_long': return t('issuePatternTooLong', { count: HITL_EXCEPTION_LIMITS.patternLength });
            case 'too_many_wildcards': return t('issueTooManyWildcards', { count: HITL_EXCEPTION_LIMITS.wildcards });
            case 'field_invalid':
            case 'field_too_long':
            case 'field_not_text': return t('issueFieldInvalid');
            default: return t('issueInvalid');
        }
    };
    const ruleOf = (exception: Pick<AgentToolApprovalException, 'field' | 'pattern'>) =>
        t('ruleText', { field: exception.field?.trim() || t('anyArgumentRule'), pattern: exception.pattern.trim() });

    const patch = (id: number, next: Partial<DraftLine>) =>
        setLines((current) => current.map((line) => (line.id === id ? { ...line, ...next } : line)));
    const remove = (id: number) => setLines((current) => current.filter((line) => line.id !== id));
    const add = () => setLines((current) => [...current, { id: nextLineId++, field: '', pattern: '', action: offered[0] }]);

    const parsedSample = parseSampleArgs(sample);
    // Lines that cannot be saved are left out, as the runtime would.
    const preview = parsedSample.value ? previewToolCall(hitl, row.name, asExceptions(lines), parsedSample.value, row.boundKind) : null;
    const previewColor = preview?.decision.action === 'deny' ? 'red' : preview?.decision.action === 'ask' ? 'orange' : 'teal';
    const previewLabel = preview
        ? preview.decision.action === 'deny'
            ? t('tryResultDeny')
            : preview.decision.action === 'ask' ? t('tryResultAsk') : t('tryResultAllow')
        : null;

    const apply = () => {
        onApply(asExceptions(filled).map(cleanException));
        onClose();
    };

    const summary = (
        <>
            <SummaryGroup title={t('summaryTool')}>
                <SummaryKV label={t('toolColumn')} value={row.name} mono />
                <SummaryKV label={t('summarySetting')} value={policy === 'always' ? t('willAsk') : t('willNotAsk')} />
                <SummaryKV
                    label={t('summaryExceptions')}
                    value={filled.length === 1 ? t('exceptionsOne') : t('exceptionsMany', { count: filled.length })}
                />
            </SummaryGroup>
            {filled.length > 0 ? (
                <SummaryGroup title={t('exceptionsSectionTitle')}>
                    {lines.map((line, index) => (isBlank(line) ? null : (
                        <SummaryKV
                            key={line.id}
                            label={actionLabel[line.action]}
                            value={issueOf(index)
                                ? <span style={{ color: 'var(--mantine-color-red-6)' }}>{issueText(issueOf(index)!)}</span>
                                : ruleOf(line)}
                        />
                    )))}
                </SummaryGroup>
            ) : null}
        </>
    );

    return (
        <FormShell
            open={opened}
            onClose={onClose}
            icon={<IconFilter size={16} />}
            title={t('exceptionsTitle', { tool: row.name })}
            subtitle={policy === 'always' ? t('exceptionsSubtitleAlways') : t('exceptionsSubtitleNever')}
            summary={summary}
            footerStatus={invalidCount > 0
                ? (invalidCount === 1 ? t('exceptionsInvalidOne') : t('exceptionsInvalidMany', { count: invalidCount }))
                : t('appliedToDraft')}
            primaryAction={{ label: t('apply'), disabled: invalidCount > 0, onClick: apply }}
        >
            <FormSection number={1} title={t('exceptionsSectionTitle')} description={t('exceptionsSectionDescription')}>
                <Stack gap="sm">
                    {lines.length === 0 ? (
                        <Text size="sm" c="dimmed" fs="italic">{t('exceptionsEmpty')}</Text>
                    ) : null}
                    {lines.map((line, index) => {
                        const issue = issueOf(index);
                        const fieldIssue = issue === 'field_invalid' || issue === 'field_too_long' || issue === 'field_not_text';
                        return (
                            <Stack key={line.id} gap={4}>
                                <Group gap="xs" wrap="nowrap" align="center">
                                    <Text size="sm" c="dimmed" w={48} style={{ flexShrink: 0 }}>{t('exceptionWhen')}</Text>
                                    <Autocomplete
                                        aria-label={t('exceptionField')}
                                        placeholder={t('exceptionFieldPlaceholder')}
                                        data={fieldOptions}
                                        value={line.field}
                                        onChange={(field) => patch(line.id, { field })}
                                        error={fieldIssue}
                                        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                                        style={{ flex: 1, minWidth: 0 }}
                                    />
                                    <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>{t('exceptionMatches')}</Text>
                                    <TextInput
                                        aria-label={t('exceptionPattern')}
                                        placeholder={t('exceptionPatternPlaceholder')}
                                        value={line.pattern}
                                        onChange={(event) => patch(line.id, { pattern: event.currentTarget.value })}
                                        error={Boolean(issue) && !fieldIssue}
                                        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                                        style={{ flex: 1.3, minWidth: 0 }}
                                    />
                                    <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>→</Text>
                                    <Select
                                        aria-label={t('exceptionAction')}
                                        data={actionOptionsFor(line.action)}
                                        renderOption={describedSelectOption(actionOptionsFor(line.action))}
                                        value={line.action}
                                        onChange={(action) => {
                                            if (action === 'ask' || action === 'allow' || action === 'deny') patch(line.id, { action });
                                        }}
                                        allowDeselect={false}
                                        w={170}
                                        style={{ flexShrink: 0 }}
                                    />
                                    <ActionIcon
                                        variant="subtle"
                                        color="gray"
                                        onClick={() => remove(line.id)}
                                        aria-label={t('removeException')}
                                    >
                                        <IconTrash size={15} />
                                    </ActionIcon>
                                </Group>
                                {issue ? (
                                    <Text size="xs" c="red" pl={56}>{issueText(issue)}</Text>
                                ) : null}
                            </Stack>
                        );
                    })}
                    <Group gap="sm">
                        <Button
                            variant="light"
                            size="xs"
                            leftSection={<IconPlus size={14} />}
                            onClick={add}
                            disabled={atLimit}
                        >
                            {t('addExceptionButton')}
                        </Button>
                        {atLimit ? (
                            <Text size="xs" c="dimmed">{t('exceptionsLimit', { count: HITL_EXCEPTION_LIMITS.perTool })}</Text>
                        ) : null}
                    </Group>
                    <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} p="sm">
                        <Stack gap={4}>
                            <Text size="xs">{t('exceptionsStrictest')}</Text>
                            <Text size="xs">{t('exceptionsFieldHint')}</Text>
                        </Stack>
                    </Alert>
                </Stack>
            </FormSection>

            <FormSection number={2} title={t('tryTitle')} description={t('tryDescription')}>
                <Stack gap="xs">
                    <Textarea
                        aria-label={t('tryTitle')}
                        placeholder={t('tryPlaceholder')}
                        value={sample}
                        onChange={(event) => setSample(event.currentTarget.value)}
                        error={parsedSample.invalid ? t('tryInvalid') : undefined}
                        autosize
                        minRows={3}
                        maxRows={10}
                        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
                    />
                    {preview ? (
                        <Group gap="xs" wrap="wrap" data-testid="hitl-exception-preview">
                            <Badge color={previewColor} variant="light">{previewLabel}</Badge>
                            <Text size="xs" c="dimmed">
                                {preview.decision.exception && preview.index !== null
                                    ? t('tryByException', { index: preview.index + 1, rule: ruleOf(preview.decision.exception) })
                                    : t('tryByToolSetting')}
                            </Text>
                        </Group>
                    ) : null}
                </Stack>
            </FormSection>
        </FormShell>
    );
}
