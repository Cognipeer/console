'use client';

/**
 * Variables: the typed values an agent takes next to the message (`config.variables`).
 *
 * Each row is one variable: name, label, type, required, default, description and
 * (for text / number types) the allowed values. A caller sends them as `variables`
 * on a run, a trigger stores them with its prompt; the instructions read them as
 * `{{variables.<name>}}` and the model also gets them as a Variables block. The same
 * rules the server applies on save (`validateVariableDeclaration`) mark a row here
 * as the person types, so a save is not the first they hear of a bad name.
 *
 * Above the rows, a short intro says what variables are, where they fit (runs a
 * program starts) and where they do not (chat: chat clients never send them, so over
 * the API a required variable without a default makes every chat message a 400; the
 * playground and portals have no place to type them). A required variable without a
 * default carries that warning on its own row.
 */

import { Alert, Button, Group, NumberInput, Paper, Select, SimpleGrid, Stack, Switch, TagsInput, Text, TextInput, ActionIcon } from '@mantine/core';
import { IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { IAgentVariable } from '@/lib/database/provider/types.domain';
import { MAX_AGENT_VARIABLES, validateVariableDeclaration, type VariableIssue } from '@/lib/services/agents/agentVariables';

export interface AgentVariablesEditorProps {
    value: IAgentVariable[] | undefined;
    onChange: (next: IAgentVariable[] | undefined) => void;
}

type VariableType = IAgentVariable['type'];
const VARIABLE_TYPES: VariableType[] = ['string', 'number', 'integer', 'boolean', 'json'];
const TYPE_LABEL_KEY: Record<VariableType, string> = {
    string: 'typeString',
    number: 'typeNumber',
    integer: 'typeInteger',
    boolean: 'typeBoolean',
    json: 'typeJson',
};

/** A new row: the first free `variable_<n>` name, as optional text. */
export function newVariable(existing: ReadonlyArray<IAgentVariable>): IAgentVariable {
    const taken = new Set(existing.map((field) => field.name));
    let n = existing.length + 1;
    while (taken.has(`variable_${n}`)) n += 1;
    return { name: `variable_${n}`, type: 'string' };
}

/** Drops the keys a row left empty, so an untouched row saves only name and type. */
export function compactVariable(field: IAgentVariable): IAgentVariable {
    const out: IAgentVariable = { name: field.name, type: field.type };
    if (field.label) out.label = field.label;
    if (field.description) out.description = field.description;
    if (field.enum && field.enum.length > 0 && (field.type === 'string' || field.type === 'number' || field.type === 'integer')) out.enum = field.enum;
    if (field.required) out.required = true;
    if (field.default !== undefined && field.default !== null && field.default !== '') out.default = field.default;
    return out;
}

/** The rows as stored: compacted, and `undefined` when there are none (an untouched agent saves no `variables`). */
export function variablesForSave(fields: ReadonlyArray<IAgentVariable>): IAgentVariable[] | undefined {
    return fields.length > 0 ? fields.map(compactVariable) : undefined;
}

/** Changing a row's type keeps what still makes sense: the default and the allowed values depend on it. */
export function retypeVariable(field: IAgentVariable, type: VariableType): IAgentVariable {
    const next: IAgentVariable = { ...field, type };
    delete next.default;
    if (type !== 'string' && type !== 'number' && type !== 'integer') delete next.enum;
    else if (field.type !== type) delete next.enum;
    return next;
}

/**
 * A required variable with no default: a chat client cannot send it, so every chat
 * message that reaches this agent through the API is refused (400 `invalid_variables`).
 * The server counts a `null` default as none, like an absent one.
 */
export function isRequiredWithoutDefault(field: IAgentVariable): boolean {
    return field.required === true && (field.default === undefined || field.default === null);
}

const VARIABLE_TYPE_LABEL_KEY: Record<string, string> = {
    string: 'typeString', number: 'typeNumber', integer: 'typeInteger', boolean: 'typeBoolean', json: 'typeJson',
};

export default function AgentVariablesEditor({ value, onChange }: AgentVariablesEditorProps) {
    const t = useTranslations('agents.variables');
    const fields = value ?? [];
    const issues = validateVariableDeclaration(fields);
    const wording = (issue: VariableIssue): string | undefined => {
        if (!issue.code) return issue.message;
        const params: Record<string, string | number> = { ...issue.params };
        let key = `issue_${issue.code}`;
        if (issue.code === 'enum_invalid') key = `issue_enum_invalid_${String(params.kind)}`;
        if ((issue.code === 'default_type' || issue.code === 'enum_unsupported') && typeof params.type === 'string') {
            params.type = t(VARIABLE_TYPE_LABEL_KEY[params.type] ?? 'typeString');
        }
        if (issue.code === 'text_expected') params.key = t(params.key === 'label' ? 'label' : 'description');
        return t(key, params);
    };
    const problem = (index: number, key: string) => {
        const issue = issues.find((entry) => entry.field === `variables[${index}].${key}`);
        return issue ? wording(issue) : undefined;
    };

    const update = (index: number, patch: Partial<IAgentVariable>) =>
        onChange(variablesForSave(fields.map((field, i) => (i === index ? { ...field, ...patch } : field))));
    const replace = (index: number, next: IAgentVariable) =>
        onChange(variablesForSave(fields.map((field, i) => (i === index ? next : field))));

    return (
        <Stack gap="md">
            <Stack gap={6} data-testid="agent-variables-intro">
                <Text size="sm">{t('intro')}</Text>
                <Text size="sm" c="dimmed">{t('introWhen')}</Text>
                <Text size="sm" c="dimmed">{t('introChat')}</Text>
            </Stack>

            {fields.length === 0 ? (
                <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>{t('empty')}</Alert>
            ) : null}

            {fields.map((field, index) => (
                <Paper key={index} withBorder p="md" radius="md" data-testid="agent-variable-row">
                    <Stack gap="sm">
                        <Group justify="space-between" align="flex-start" wrap="nowrap">
                            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm" style={{ flex: 1 }}>
                                <TextInput
                                    label={t('name')}
                                    placeholder={t('namePlaceholder')}
                                    value={field.name}
                                    error={problem(index, 'name')}
                                    onChange={(event) => update(index, { name: event.currentTarget.value })}
                                />
                                <TextInput
                                    label={t('label')}
                                    value={field.label ?? ''}
                                    onChange={(event) => update(index, { label: event.currentTarget.value || undefined })}
                                />
                                <Select
                                    label={t('type')}
                                    allowDeselect={false}
                                    value={field.type}
                                    data={VARIABLE_TYPES.map((type) => ({ value: type, label: t(TYPE_LABEL_KEY[type]) }))}
                                    onChange={(type) => type && replace(index, retypeVariable(field, type as VariableType))}
                                />
                            </SimpleGrid>
                            <ActionIcon
                                variant="subtle"
                                color="red"
                                mt={24}
                                aria-label={t('remove')}
                                onClick={() => onChange(variablesForSave(fields.filter((_, i) => i !== index)))}
                            >
                                <IconTrash size={16} />
                            </ActionIcon>
                        </Group>

                        <TextInput
                            label={t('description')}
                            value={field.description ?? ''}
                            onChange={(event) => update(index, { description: event.currentTarget.value || undefined })}
                        />

                        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                            {field.type === 'string' || field.type === 'number' || field.type === 'integer' ? (
                                <TagsInput
                                    label={t('enum')}
                                    placeholder={t('enumPlaceholder')}
                                    value={(field.enum ?? []).map(String)}
                                    error={problem(index, 'enum')}
                                    onChange={(tags) => {
                                        const list = field.type === 'string' ? tags : tags.map(Number).filter((n) => Number.isFinite(n));
                                        update(index, { enum: list.length > 0 ? list : undefined });
                                    }}
                                />
                            ) : null}
                            {field.type === 'string' ? (
                                <TextInput
                                    label={t('default')}
                                    value={typeof field.default === 'string' ? field.default : ''}
                                    error={problem(index, 'default')}
                                    onChange={(event) => update(index, { default: event.currentTarget.value || undefined })}
                                />
                            ) : null}
                            {field.type === 'number' || field.type === 'integer' ? (
                                <NumberInput
                                    label={t('default')}
                                    allowDecimal={field.type === 'number'}
                                    value={typeof field.default === 'number' ? field.default : ''}
                                    error={problem(index, 'default')}
                                    onChange={(n) => update(index, { default: typeof n === 'number' ? n : undefined })}
                                />
                            ) : null}
                            {field.type === 'boolean' ? (
                                <Select
                                    label={t('defaultBoolean')}
                                    value={field.default === true ? 'true' : field.default === false ? 'false' : ''}
                                    data={[
                                        { value: '', label: t('defaultNone') },
                                        { value: 'true', label: t('defaultTrue') },
                                        { value: 'false', label: t('defaultFalse') },
                                    ]}
                                    allowDeselect={false}
                                    onChange={(v) => replace(index, (() => {
                                        const next = { ...field };
                                        if (v === 'true') next.default = true;
                                        else if (v === 'false') next.default = false;
                                        else delete next.default;
                                        return next;
                                    })())}
                                />
                            ) : null}
                        </SimpleGrid>

                        <Group justify="space-between" align="flex-start">
                            <Switch
                                label={t('required')}
                                description={isRequiredWithoutDefault(field)
                                    ? <Text span size="xs" c="orange" data-testid="agent-variable-chat-hint">{t('requiredNoDefaultHint')}</Text>
                                    : undefined}
                                checked={field.required === true}
                                onChange={(event) => update(index, { required: event.currentTarget.checked || undefined })}
                            />
                            {field.name ? <Text size="xs" c="dimmed" ff="monospace">{t('usage', { name: field.name })}</Text> : null}
                        </Group>
                    </Stack>
                </Paper>
            ))}

            <Group>
                <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconPlus size={14} />}
                    disabled={fields.length >= MAX_AGENT_VARIABLES}
                    onClick={() => onChange(variablesForSave([...fields, newVariable(fields)]))}
                >
                    {t('add')}
                </Button>
                {fields.length >= MAX_AGENT_VARIABLES ? (
                    <Text size="xs" c="dimmed">{t('limit', { max: MAX_AGENT_VARIABLES })}</Text>
                ) : null}
            </Group>
            {issues.some((issue) => issue.field === 'variables') ? (
                <Alert color="red" variant="light">{wording(issues.find((issue) => issue.field === 'variables')!)}</Alert>
            ) : null}
        </Stack>
    );
}
