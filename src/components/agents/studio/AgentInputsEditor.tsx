'use client';

/**
 * Inputs: the typed arguments of an agent (`config.inputs`).
 *
 * Each row is one input: name, label, type, required, default, description and
 * (for text / number types) the allowed values. A caller sends them as `inputs`
 * on a run, a routine stores them with its prompt; the prompt reads them as
 * `{{input.<name>}}` and the model also gets them as an Inputs block. The same
 * rules the server applies on save (`validateInputDeclaration`) mark a row here
 * as the person types, so a save is not the first they hear of a bad name.
 */

import { Alert, Button, Group, NumberInput, Paper, Select, SimpleGrid, Stack, Switch, TagsInput, Text, TextInput, ActionIcon } from '@mantine/core';
import { IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { IAgentInputField } from '@/lib/database/provider/types.domain';
import { MAX_AGENT_INPUT_FIELDS, validateInputDeclaration } from '@/lib/services/agents/agentInputs';

export interface AgentInputsEditorProps {
    value: IAgentInputField[] | undefined;
    onChange: (next: IAgentInputField[] | undefined) => void;
}

type InputType = IAgentInputField['type'];
const INPUT_TYPES: InputType[] = ['string', 'number', 'integer', 'boolean', 'json'];
const TYPE_LABEL_KEY: Record<InputType, string> = {
    string: 'typeString',
    number: 'typeNumber',
    integer: 'typeInteger',
    boolean: 'typeBoolean',
    json: 'typeJson',
};

/** A new row: the first free `input_<n>` name, as optional text. */
export function newInputField(existing: ReadonlyArray<IAgentInputField>): IAgentInputField {
    const taken = new Set(existing.map((field) => field.name));
    let n = existing.length + 1;
    while (taken.has(`input_${n}`)) n += 1;
    return { name: `input_${n}`, type: 'string' };
}

/** Drops the keys a row left empty, so an untouched row saves only name and type. */
export function compactInputField(field: IAgentInputField): IAgentInputField {
    const out: IAgentInputField = { name: field.name, type: field.type };
    if (field.label) out.label = field.label;
    if (field.description) out.description = field.description;
    if (field.enum && field.enum.length > 0 && (field.type === 'string' || field.type === 'number' || field.type === 'integer')) out.enum = field.enum;
    if (field.required) out.required = true;
    if (field.default !== undefined && field.default !== null && field.default !== '') out.default = field.default;
    return out;
}

/** The rows as stored: compacted, and `undefined` when there are none (an untouched agent saves no `inputs`). */
export function inputsForSave(fields: ReadonlyArray<IAgentInputField>): IAgentInputField[] | undefined {
    return fields.length > 0 ? fields.map(compactInputField) : undefined;
}

/** Changing a row's type keeps what still makes sense: the default and the allowed values depend on it. */
export function retypeInputField(field: IAgentInputField, type: InputType): IAgentInputField {
    const next: IAgentInputField = { ...field, type };
    delete next.default;
    if (type !== 'string' && type !== 'number' && type !== 'integer') delete next.enum;
    else if (field.type !== type) delete next.enum;
    return next;
}

export default function AgentInputsEditor({ value, onChange }: AgentInputsEditorProps) {
    const t = useTranslations('agents.inputs');
    const fields = value ?? [];
    const issues = validateInputDeclaration(fields);
    const problem = (index: number, key: string) => issues.find((issue) => issue.field === `inputs[${index}].${key}`)?.message;

    const update = (index: number, patch: Partial<IAgentInputField>) =>
        onChange(inputsForSave(fields.map((field, i) => (i === index ? { ...field, ...patch } : field))));
    const replace = (index: number, next: IAgentInputField) =>
        onChange(inputsForSave(fields.map((field, i) => (i === index ? next : field))));

    return (
        <Stack gap="md">
            {fields.length === 0 ? (
                <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>{t('empty')}</Alert>
            ) : null}

            {fields.map((field, index) => (
                <Paper key={index} withBorder p="md" radius="md" data-testid="agent-input-row">
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
                                    data={INPUT_TYPES.map((type) => ({ value: type, label: t(TYPE_LABEL_KEY[type]) }))}
                                    onChange={(type) => type && replace(index, retypeInputField(field, type as InputType))}
                                />
                            </SimpleGrid>
                            <ActionIcon
                                variant="subtle"
                                color="red"
                                mt={24}
                                aria-label={t('remove')}
                                onClick={() => onChange(inputsForSave(fields.filter((_, i) => i !== index)))}
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

                        <Group justify="space-between">
                            <Switch
                                label={t('required')}
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
                    disabled={fields.length >= MAX_AGENT_INPUT_FIELDS}
                    onClick={() => onChange(inputsForSave([...fields, newInputField(fields)]))}
                >
                    {t('add')}
                </Button>
                {fields.length >= MAX_AGENT_INPUT_FIELDS ? (
                    <Text size="xs" c="dimmed">{t('limit', { max: MAX_AGENT_INPUT_FIELDS })}</Text>
                ) : null}
            </Group>
            {issues.some((issue) => issue.field === 'inputs') ? (
                <Alert color="red" variant="light">{issues.find((issue) => issue.field === 'inputs')?.message}</Alert>
            ) : null}
        </Stack>
    );
}
