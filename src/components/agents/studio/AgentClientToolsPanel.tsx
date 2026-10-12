'use client';

/**
 * Client tools — tools the agent's CALLER runs (a portal page, or an API client
 * or backend). The author declares name, description and arguments here; the
 * caller answers each call, and the run goes on with that answer.
 */

import { useState } from 'react';
import {
    ActionIcon,
    Alert,
    Button,
    Group,
    NumberInput,
    Paper,
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
import { ConfigBlock, describedSelectOption } from './ConfigSection';
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

export interface AgentClientToolsPanelProps {
    value: IAgentClientToolConfig[] | undefined;
    onChange: (next: IAgentClientToolConfig[] | undefined) => void;
}

interface ToolCardProps {
    tool: IAgentClientToolConfig;
    errors: ClientToolFieldError[];
    onPatch: (patch: Partial<IAgentClientToolConfig>) => void;
    onRemove: () => void;
}

function ToolCard({ tool, errors, onPatch, onRemove }: ToolCardProps) {
    const t = useTranslations('agents.clientTools');
    const [schemaText, setSchemaText] = useState(() => schemaToText(tool.inputSchema));
    const [schemaError, setSchemaError] = useState<string | null>(null);

    const has = (e: ClientToolFieldError) => errors.includes(e);

    const handleSchema = (text: string) => {
        setSchemaText(text);
        const parsed = parseSchemaText(text);
        if (parsed.ok) {
            setSchemaError(null);
            onPatch({ inputSchema: parsed.schema });
        } else {
            setSchemaError(parsed.message);
        }
    };

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
                <Textarea
                    label={t('schema')}
                    description={t('schemaHint')}
                    placeholder={'{\n  "type": "object",\n  "properties": {}\n}'}
                    autosize
                    minRows={4}
                    maxRows={14}
                    value={schemaText}
                    onChange={(event) => handleSchema(event.currentTarget.value)}
                    error={schemaError ? t('errorSchema', { message: schemaError }) : undefined}
                    spellCheck={false}
                    styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
                />
            </Stack>
        </Paper>
    );
}

export default function AgentClientToolsPanel({ value, onChange }: AgentClientToolsPanelProps) {
    const t = useTranslations('agents.clientTools');
    const tools = value ?? [];
    const errors = clientToolErrors(tools);
    const emit = (next: IAgentClientToolConfig[]) => onChange(normalizeClientTools(next));

    return (
        <Stack gap="lg">
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
                                key={index}
                                tool={tool}
                                errors={errors[index] ?? []}
                                onPatch={(patch) => emit(updateTool(tools, index, patch))}
                                onRemove={() => emit(removeTool(tools, index))}
                            />
                        ))
                    )}
                    <Group justify="space-between">
                        <Button
                            variant="light"
                            size="xs"
                            leftSection={<IconPlus size={14} />}
                            disabled={tools.length >= CLIENT_TOOLS_MAX_COUNT}
                            onClick={() => emit(addTool(tools))}
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
