'use client';

/**
 * Client tools — tools the agent's CALLER runs (a portal page, or an API client
 * or backend). The author declares name, description and arguments here; the
 * caller answers each call, and the run goes on with that answer.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActionIcon,
    Alert,
    Button,
    Group,
    NumberInput,
    Paper,
    Select,
    SegmentedControl,
    Stack,
    Switch,
    Text,
    Textarea,
    TextInput,
    Tooltip,
} from '@mantine/core';
import { IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import type { IAgentClientToolConfig } from '@/lib/database/provider/types.domain';
import { useTranslations } from '@/lib/i18n';
import { ConfigBlock } from './ConfigSection';
import {
    CLIENT_TOOL_TIMEOUT_DEFAULT,
    CLIENT_TOOL_TIMEOUT_MAX,
    CLIENT_TOOLS_MAX_COUNT,
    addTool,
    clientToolErrors,
    normalizeClientTools,
    parseSchemaText,
    removeTool,
    schemaToText,
    updateTool,
    type ClientToolFieldError,
} from './clientToolsSettings';
import {
    SCHEMA_FIELD_TYPES,
    SCHEMA_ITEMS_TYPES,
    addField,
    fieldErrors,
    fieldsToSchema,
    removeField,
    schemaToFields,
    updateField,
    type SchemaField,
    type SchemaFieldError,
    type SchemaFieldType,
    type SchemaItemsType,
    type SchemaMeta,
} from './schemaFields';

export interface AgentClientToolsPanelProps {
    value: IAgentClientToolConfig[] | undefined;
    onChange: (next: IAgentClientToolConfig[] | undefined) => void;
}

interface ToolCardProps {
    id: string;
    tool: IAgentClientToolConfig;
    /** The card's field errors, joined by a comma (a string, so an unchanged card compares equal and is not re-rendered). */
    errorsText: string;
    onPatch: (id: string, patch: Partial<IAgentClientToolConfig>) => void;
    onRemove: (id: string) => void;
}

const MONO = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

interface FieldRowProps {
    field: SchemaField;
    errorsText: string;
    onUpdate: (id: string, patch: Partial<Omit<SchemaField, 'id'>>) => void;
    onRemove: (id: string) => void;
}

const FieldRow = memo(function FieldRow({ field, errorsText, onUpdate, onRemove }: FieldRowProps) {
    const t = useTranslations('agents.clientTools');
    const errors = (errorsText ? errorsText.split(',') : []) as SchemaFieldError[];
    const [enumText, setEnumText] = useState(() => (field.enumValues ?? []).join(', '));
    const typeData = SCHEMA_FIELD_TYPES.map((value) => ({ value, label: t(`type_${value}`) }));
    const itemsData = SCHEMA_ITEMS_TYPES.map((value) => ({ value, label: t(`type_${value}`) }));

    return (
        <Paper withBorder p="xs" radius="sm">
            <Stack gap="xs">
                <Group gap="xs" align="flex-start" wrap="nowrap">
                    <TextInput
                        aria-label={t('argName')}
                        placeholder={t('argName')}
                        size="xs"
                        value={field.name}
                        onChange={(event) => onUpdate(field.id, { name: event.currentTarget.value })}
                        error={errors.includes('nameDuplicate') ? t('errorArgDuplicate') : errors.includes('name') ? t('errorArgName') : undefined}
                        styles={{ input: MONO }}
                        style={{ flex: 1 }}
                    />
                    <Select
                        aria-label={t('argType')}
                        size="xs"
                        w={120}
                        allowDeselect={false}
                        data={typeData}
                        value={field.type}
                        onChange={(next) => next && onUpdate(field.id, { type: next as SchemaFieldType })}
                    />
                    <Switch
                        size="xs"
                        mt={6}
                        label={t('argRequired')}
                        checked={field.required}
                        onChange={(event) => onUpdate(field.id, { required: event.currentTarget.checked })}
                    />
                    <ActionIcon variant="subtle" color="red" onClick={() => onRemove(field.id)} aria-label={t('argRemove')}>
                        <IconTrash size={14} />
                    </ActionIcon>
                </Group>
                <TextInput
                    aria-label={t('argDescription')}
                    placeholder={t('argDescription')}
                    size="xs"
                    value={field.description}
                    onChange={(event) => onUpdate(field.id, { description: event.currentTarget.value })}
                />
                {field.type === 'string' && (
                    <TextInput
                        aria-label={t('argEnum')}
                        placeholder={t('argEnum')}
                        description={t('argEnumHint')}
                        size="xs"
                        value={enumText}
                        onChange={(event) => {
                            const text = event.currentTarget.value;
                            setEnumText(text);
                            const values = text.split(',').map((part) => part.trim()).filter(Boolean);
                            onUpdate(field.id, { enumValues: values.length > 0 ? values : undefined });
                        }}
                        error={errors.includes('enum') ? t('errorArgEnum') : undefined}
                        styles={{ input: MONO }}
                    />
                )}
                {field.type === 'array' && (
                    <Select
                        aria-label={t('argItemsType')}
                        label={t('argItemsType')}
                        size="xs"
                        w={160}
                        clearable
                        data={itemsData}
                        value={field.itemsType ?? null}
                        onChange={(next) => onUpdate(field.id, { itemsType: (next as SchemaItemsType | null) ?? undefined })}
                    />
                )}
                {field.type === 'object' && <Text size="xs" c="dimmed">{t('argObjectNote')}</Text>}
            </Stack>
        </Paper>
    );
});

interface SchemaEditorProps {
    schema: Record<string, unknown> | undefined;
    onSchema: (schema: Record<string, unknown> | undefined) => void;
}

/** The input schema of one tool, edited as a list of arguments (Form) or as raw JSON. Both edit the same schema. */
function SchemaEditor({ schema, onSchema }: SchemaEditorProps) {
    const t = useTranslations('agents.clientTools');
    const [initial] = useState(() => schemaToFields(schema));
    const [mode, setMode] = useState<'form' | 'json'>(initial.ok ? 'form' : 'json');
    const [fields, setFields] = useState<SchemaField[]>(initial.ok ? initial.fields : []);
    const fieldsRef = useRef(fields);
    const metaRef = useRef<SchemaMeta>(initial.ok ? initial.meta : {});
    const [schemaText, setSchemaText] = useState(() => schemaToText(schema));
    const [schemaError, setSchemaError] = useState<string | null>(null);
    const [formNote, setFormNote] = useState<string | null>(initial.ok ? null : initial.reason);
    const onSchemaRef = useRef(onSchema);
    onSchemaRef.current = onSchema;

    const applyFields = useCallback((next: SchemaField[]) => {
        fieldsRef.current = next;
        setFields(next);
        if (Object.keys(fieldErrors(next)).length === 0) onSchemaRef.current(fieldsToSchema(next, metaRef.current));
    }, []);
    const handleUpdate = useCallback((id: string, patch: Partial<Omit<SchemaField, 'id'>>) => {
        applyFields(updateField(fieldsRef.current, id, patch));
    }, [applyFields]);
    const handleRemove = useCallback((id: string) => {
        applyFields(removeField(fieldsRef.current, id));
    }, [applyFields]);

    const handleSchema = (text: string) => {
        setSchemaText(text);
        const parsed = parseSchemaText(text);
        if (parsed.ok) {
            setSchemaError(null);
            onSchema(parsed.schema);
        } else {
            setSchemaError(parsed.message);
        }
    };

    const switchMode = (next: string) => {
        if (next === mode) return;
        if (next === 'json') {
            const current = Object.keys(fieldErrors(fieldsRef.current)).length === 0
                ? fieldsToSchema(fieldsRef.current, metaRef.current)
                : undefined;
            setSchemaText(schemaToText(current));
            setSchemaError(null);
            setMode('json');
            return;
        }
        const parsed = parseSchemaText(schemaText);
        if (!parsed.ok) {
            setSchemaError(parsed.message);
            return;
        }
        const derived = schemaToFields(parsed.schema);
        if (!derived.ok) {
            setFormNote(derived.reason);
            setSchemaError(null);
            return;
        }
        metaRef.current = derived.meta;
        fieldsRef.current = derived.fields;
        setFields(derived.fields);
        setFormNote(null);
        setSchemaError(null);
        setMode('form');
    };

    const errors = fieldErrors(fields);

    return (
        <Stack gap={6}>
            <Group justify="space-between" align="flex-end">
                <div>
                    <Text size="sm" fw={500}>{t('schema')}</Text>
                    <Text size="xs" c="dimmed">{t('schemaHint')}</Text>
                </div>
                <SegmentedControl
                    size="xs"
                    value={mode}
                    onChange={switchMode}
                    data={[{ value: 'form', label: t('tabForm') }, { value: 'json', label: t('tabJson') }]}
                />
            </Group>
            {mode === 'form' ? (
                <Stack gap="xs">
                    {fields.length === 0 && <Text size="xs" c="dimmed" fs="italic">{t('argsEmpty')}</Text>}
                    {fields.map((field) => (
                        <FieldRow
                            key={field.id}
                            field={field}
                            errorsText={(errors[field.id] ?? []).join(',')}
                            onUpdate={handleUpdate}
                            onRemove={handleRemove}
                        />
                    ))}
                    <Group>
                        <Button
                            variant="light"
                            size="xs"
                            leftSection={<IconPlus size={14} />}
                            onClick={() => applyFields(addField(fieldsRef.current))}
                        >
                            {t('argAdd')}
                        </Button>
                    </Group>
                </Stack>
            ) : (
                <>
                    {formNote && <Text size="xs" c="dimmed">{t('formUnavailable', { reason: formNote })}</Text>}
                    <Textarea
                        aria-label={t('schema')}
                        placeholder={'{\n  "type": "object",\n  "properties": {}\n}'}
                        autosize
                        minRows={4}
                        maxRows={14}
                        value={schemaText}
                        onChange={(event) => handleSchema(event.currentTarget.value)}
                        error={schemaError ? t('errorSchema', { message: schemaError }) : undefined}
                        spellCheck={false}
                        styles={{ input: { ...MONO, fontSize: 12 } }}
                    />
                </>
            )}
        </Stack>
    );
}

const ToolCard = memo(function ToolCard({ id, tool, errorsText, onPatch: patchById, onRemove: removeById }: ToolCardProps) {
    const t = useTranslations('agents.clientTools');
    const errors = (errorsText ? errorsText.split(',') : []) as ClientToolFieldError[];
    const onPatch = (patch: Partial<IAgentClientToolConfig>) => patchById(id, patch);
    const onRemove = () => removeById(id);

    const has = (e: ClientToolFieldError) => errors.includes(e);

    return (
        <Paper withBorder p="sm" radius="md">
            <Stack gap="sm">
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                    <TextInput
                        label={t('name')}
                        placeholder="get_selected_record"
                        value={tool.name}
                        onChange={(event) => onPatch({ name: event.currentTarget.value })}
                        error={has('nameDuplicate') ? t('errorNameDuplicate') : has('name') ? t('errorName') : undefined}
                        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                        style={{ flex: 1 }}
                    />
                    <Group gap="sm" mt={26} wrap="nowrap">
                        <Switch
                            label={t('enabled')}
                            checked={tool.enabled !== false}
                            onChange={(event) => onPatch({ enabled: event.currentTarget.checked ? undefined : false })}
                        />
                        <Tooltip label={t('remove')} withArrow>
                            <ActionIcon variant="subtle" color="red" onClick={onRemove} aria-label={t('remove')}>
                                <IconTrash size={16} />
                            </ActionIcon>
                        </Tooltip>
                    </Group>
                </Group>
                <Textarea
                    label={t('description')}
                    description={t('descriptionHint')}
                    autosize
                    minRows={2}
                    maxRows={6}
                    value={tool.description}
                    onChange={(event) => onPatch({ description: event.currentTarget.value })}
                    error={has('descriptionTooLong') ? t('errorDescriptionTooLong') : has('description') ? t('errorDescription') : undefined}
                />
                <Group align="flex-start" gap="md">
                    <NumberInput
                        label={t('timeout')}
                        description={t('timeoutHint')}
                        min={1}
                        max={CLIENT_TOOL_TIMEOUT_MAX}
                        allowDecimal={false}
                        placeholder={String(CLIENT_TOOL_TIMEOUT_DEFAULT)}
                        value={tool.timeoutSeconds ?? ''}
                        onChange={(next) => onPatch({ timeoutSeconds: typeof next === 'number' ? next : undefined })}
                        error={has('timeout') ? t('errorTimeout', { max: CLIENT_TOOL_TIMEOUT_MAX }) : undefined}
                        w={200}
                    />
                </Group>
                <SchemaEditor schema={tool.inputSchema} onSchema={(inputSchema) => onPatch({ inputSchema })} />
            </Stack>
        </Paper>
    );
});

let keyCounter = 0;
const newKey = () => `ct-${++keyCounter}`;

/** Typing is kept in local state and handed to the page after a short pause: the page behind this panel is large, and re-rendering it on every keystroke made typing lag. */
const COMMIT_DELAY_MS = 300;

export default function AgentClientToolsPanel({ value, onChange }: AgentClientToolsPanelProps) {
    const t = useTranslations('agents.clientTools');
    const [draft, setDraft] = useState<IAgentClientToolConfig[]>(value ?? []);
    const keys = useRef<string[]>((value ?? []).map(newKey));
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const lastEmitted = useRef(value);
    const pending = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    const flush = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = undefined;
        if (!pending.current) return;
        pending.current = false;
        const next = normalizeClientTools(draftRef.current);
        lastEmitted.current = next;
        onChangeRef.current(next);
    }, []);

    // A change that did not come from here (the agent was reloaded, a version restored) replaces the draft.
    useEffect(() => {
        if (value === lastEmitted.current) return;
        lastEmitted.current = value;
        pending.current = false;
        if (timer.current) clearTimeout(timer.current);
        keys.current = (value ?? []).map(newKey);
        setDraft(value ?? []);
    }, [value]);

    useEffect(() => flush, [flush]);

    const commit = useCallback((next: IAgentClientToolConfig[]) => {
        draftRef.current = next;
        setDraft(next);
        pending.current = true;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, COMMIT_DELAY_MS);
    }, [flush]);

    const patchById = useCallback((id: string, patch: Partial<IAgentClientToolConfig>) => {
        const index = keys.current.indexOf(id);
        if (index >= 0) commit(updateTool(draftRef.current, index, patch));
    }, [commit]);
    const removeById = useCallback((id: string) => {
        const index = keys.current.indexOf(id);
        if (index < 0) return;
        keys.current = keys.current.filter((key) => key !== id);
        commit(removeTool(draftRef.current, index));
        flush();
    }, [commit, flush]);

    const tools = draft;
    const errors = useMemo(() => clientToolErrors(draft), [draft]);

    return (
        <Stack gap="lg" onBlur={flush}>
            <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
                <Stack gap={2}>
                    <Text size="sm">{t('infoRuns')}</Text>
                    <Text size="sm">{t('infoChannels')}</Text>
                    <Text size="sm" fw={500}>{t('infoUntrusted')}</Text>
                </Stack>
            </Alert>

            <ConfigBlock title={t('listTitle')}>
                <Stack gap="sm">
                    {tools.length === 0 ? (
                        <Text size="xs" c="dimmed" fs="italic">{t('empty')}</Text>
                    ) : (
                        tools.map((tool, index) => (
                            <ToolCard
                                key={keys.current[index]}
                                id={keys.current[index]}
                                tool={tool}
                                errorsText={(errors[index] ?? []).join(',')}
                                onPatch={patchById}
                                onRemove={removeById}
                            />
                        ))
                    )}
                    <Group justify="space-between">
                        <Button
                            variant="light"
                            size="xs"
                            leftSection={<IconPlus size={14} />}
                            disabled={tools.length >= CLIENT_TOOLS_MAX_COUNT}
                            onClick={() => { keys.current = [...keys.current, newKey()]; commit(addTool(tools)); flush(); }}
                        >
                            {t('add')}
                        </Button>
                        <Text size="xs" c="dimmed">{t('count', { count: tools.length, max: CLIENT_TOOLS_MAX_COUNT })}</Text>
                    </Group>
                    <Text size="xs" c="dimmed">{t('callbackHint')}</Text>
                    <Text size="xs" c="dimmed">{t('approvalsNote')}</Text>
                </Stack>
            </ConfigBlock>
        </Stack>
    );
}
