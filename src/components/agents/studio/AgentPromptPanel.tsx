'use client';

/**
 * Prompt — the agent's own tab for the thing every other tab quietly depends
 * on: what the model is told to be.
 *
 * This does NOT reintroduce a per-agent "default variable values" editor.
 * That was removed on purpose: the Prompts module is already where a
 * template's `{{placeholders}}` are authored, and a template's variables
 * resolve at run time from the caller's `runtimeContext.metadata` plus the
 * built-ins (`agent`, `now`, `user`) — see `promptVariables.ts`. Managing a
 * SEPARATE set of agent-level defaults here would just be a second place for
 * the same values to drift out of sync with the template that declares them.
 * What this tab manages instead is the PROMPT ITSELF, inline, so switching
 * to a managed prompt and then tuning its wording never means leaving the
 * agent.
 */

import { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Badge,
    Button,
    Group,
    Radio,
    Select,
    Stack,
    Text,
    Textarea,
    TextInput,
    Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowRight, IconCheck, IconInfoCircle } from '@tabler/icons-react';

/** Mirrors the server's own scan — see `promptVariables.ts#collectTemplateVariables`. */
function templateVariables(template: string): string[] {
    const names = new Set<string>();
    const pattern = /\{\{\s*[#^&]?\s*([A-Za-z0-9_][A-Za-z0-9_.]*)\s*\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(template)) !== null) {
        names.add(match[1].split('.')[0]);
    }
    return [...names];
}

const BUILT_IN_VARIABLES = ['agent', 'now', 'user'];

export interface PromptOption {
    _id: string;
    key: string;
    name: string;
    description?: string;
    template: string;
}

/** Writes a prompt and returns it in the shape this panel lists. */
async function writePrompt(
    url: string,
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
    failure: string,
    fallbackId?: string,
): Promise<PromptOption> {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || failure);
    }
    const data = await res.json();
    return {
        _id: data.prompt.id ?? data.prompt._id ?? fallbackId,
        key: data.prompt.key,
        name: data.prompt.name,
        description: data.prompt.description,
        template: data.prompt.template,
    };
}

const notifyFailure = (title: string, error: unknown) =>
    notifications.show({ title, message: error instanceof Error ? error.message : String(error), color: 'red' });

export interface AgentPromptPanelProps {
    mode: 'custom' | 'prompt';
    onModeChange: (mode: 'custom' | 'prompt') => void;
    /** Inline prompt text — only meaningful in `custom` mode. */
    systemPrompt: string;
    onSystemPromptChange: (value: string) => void;
    promptKey: string;
    onPromptKeyChange: (key: string) => void;
    prompts: PromptOption[];
    /** Called after a prompt is edited/created here, to refresh the caller's list. */
    onPromptsChanged: (prompts: PromptOption[]) => void;
    /** Saves the AGENT config (mode/key/inline text) — shared with every other tab. */
    onSaveAgentConfig: () => void | Promise<void>;
}

export default function AgentPromptPanel({
    mode,
    onModeChange,
    systemPrompt,
    onSystemPromptChange,
    promptKey,
    onPromptKeyChange,
    prompts,
    onPromptsChanged,
    onSaveAgentConfig,
}: AgentPromptPanelProps) {
    const selectedPrompt = useMemo(
        () => prompts.find((p) => p.key === promptKey) ?? null,
        [prompts, promptKey],
    );

    // Local draft for the managed prompt's own fields (name/description/
    // template) — separate from the agent's config form, because saving it
    // hits a different endpoint (`/api/prompts/:id`) with different semantics
    // (it creates a new prompt VERSION, not an agent-config replace).
    const [draftName, setDraftName] = useState('');
    const [draftDescription, setDraftDescription] = useState('');
    const [draftTemplate, setDraftTemplate] = useState('');
    const [savingPrompt, setSavingPrompt] = useState(false);
    const [promoting, setPromoting] = useState(false);

    useEffect(() => {
        if (selectedPrompt) {
            setDraftName(selectedPrompt.name);
            setDraftDescription(selectedPrompt.description ?? '');
            setDraftTemplate(selectedPrompt.template);
        }
    }, [selectedPrompt?._id]); // eslint-disable-line react-hooks/exhaustive-deps

    const promptDirty =
        selectedPrompt !== null &&
        (draftName !== selectedPrompt.name ||
            draftDescription !== (selectedPrompt.description ?? '') ||
            draftTemplate !== selectedPrompt.template);

    const activeTemplate = mode === 'prompt' ? (selectedPrompt?.template ?? '') : systemPrompt;
    const referenced = useMemo(() => templateVariables(activeTemplate), [activeTemplate]);
    const customVariables = referenced.filter((name) => !BUILT_IN_VARIABLES.includes(name));

    const savePrompt = async () => {
        if (!selectedPrompt) return;
        setSavingPrompt(true);
        try {
            const updated = await writePrompt(
                `/api/prompts/${selectedPrompt._id}`,
                'PATCH',
                {
                    name: draftName,
                    description: draftDescription || undefined,
                    template: draftTemplate,
                    versionComment: 'Edited from the agent Prompt tab',
                },
                'Failed to save prompt',
                selectedPrompt._id,
            );
            onPromptsChanged(prompts.map((p) => (p._id === updated._id ? updated : p)));
            notifications.show({ title: 'Prompt saved', message: `"${updated.name}" was updated`, color: 'teal' });
        } catch (error) {
            notifyFailure('Save failed', error);
        } finally {
            setSavingPrompt(false);
        }
    };

    const promoteToManagedPrompt = async () => {
        if (!systemPrompt.trim()) return;
        setPromoting(true);
        try {
            const created = await writePrompt(
                '/api/prompts',
                'POST',
                { name: 'Untitled prompt', template: systemPrompt },
                'Failed to create prompt',
            );
            onPromptsChanged([created, ...prompts]);
            onModeChange('prompt');
            onPromptKeyChange(created.key);
            await onSaveAgentConfig();
            notifications.show({
                title: 'Promoted to a managed prompt',
                message: `Rename "${created.name}" and continue editing it here — it's still this agent's prompt.`,
                color: 'teal',
            });
        } catch (error) {
            notifyFailure('Promote failed', error);
        } finally {
            setPromoting(false);
        }
    };

    return (
        <Stack gap="lg">
            <Radio.Group
                label="Source"
                value={mode}
                onChange={(value) => onModeChange(value as 'custom' | 'prompt')}
            >
                <Group mt="xs" gap="lg">
                    <Radio value="custom" label="Inline prompt" />
                    <Radio value="prompt" label="Managed prompt" />
                </Group>
            </Radio.Group>

            {mode === 'custom' ? (
                <Stack gap="sm">
                    <Textarea
                        label="System prompt"
                        placeholder="You are a helpful assistant that…"
                        minRows={10}
                        maxRows={24}
                        autosize
                        value={systemPrompt}
                        onChange={(event) => onSystemPromptChange(event.currentTarget.value)}
                        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
                    />
                    <Group justify="space-between">
                        <Button onClick={() => void onSaveAgentConfig()} size="sm">
                            Save
                        </Button>
                        <Tooltip
                            label="Moves this text into the Prompts module as its own record — reusable, versioned, editable right here afterward."
                            multiline
                            w={260}
                        >
                            <Button
                                variant="light"
                                size="sm"
                                rightSection={<IconArrowRight size={14} />}
                                loading={promoting}
                                disabled={!systemPrompt.trim()}
                                onClick={() => void promoteToManagedPrompt()}
                            >
                                Promote to managed prompt
                            </Button>
                        </Tooltip>
                    </Group>
                </Stack>
            ) : (
                <Stack gap="md">
                    <Select
                        label="Prompt"
                        placeholder={prompts.length ? 'Select a prompt…' : 'No prompts yet'}
                        data={prompts.map((p) => ({ value: p.key, label: p.name }))}
                        value={promptKey || null}
                        onChange={(next) => onPromptKeyChange(next ?? '')}
                        searchable
                    />

                    {!promptKey ? (
                        <Text size="sm" c="dimmed">
                            Pick a prompt above, or switch to &quot;Inline prompt&quot; to write one directly on
                            this agent.
                        </Text>
                    ) : !selectedPrompt ? (
                        <Alert variant="light" color="yellow">
                            <Text size="sm">The selected prompt key doesn&apos;t resolve to a prompt in this project.</Text>
                        </Alert>
                    ) : (
                        <>
                            <Group justify="flex-end">
                                <Button size="xs" onClick={() => void savePrompt()} loading={savingPrompt} disabled={!promptDirty}>
                                    Save prompt
                                </Button>
                            </Group>
                            <TextInput
                                label="Name"
                                value={draftName}
                                onChange={(event) => setDraftName(event.currentTarget.value)}
                            />
                            <Textarea
                                label="Description"
                                minRows={2}
                                autosize
                                value={draftDescription}
                                onChange={(event) => setDraftDescription(event.currentTarget.value)}
                            />
                            <Textarea
                                label="Template"
                                minRows={12}
                                maxRows={28}
                                autosize
                                value={draftTemplate}
                                onChange={(event) => setDraftTemplate(event.currentTarget.value)}
                                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
                            />
                            <Text size="xs" c="dimmed">
                                Saving here creates a new version of this prompt, same as editing it from the
                                Prompts module — every agent pointed at this key picks it up.
                            </Text>
                        </>
                    )}
                </Stack>
            )}

            {activeTemplate ? (
                <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
                    <Stack gap={6}>
                        <Text size="xs">
                            <strong>{'agent'}</strong>, <strong>{'now'}</strong> and <strong>{'user'}</strong> resolve
                            automatically. Anything else this template references is filled from the caller&apos;s
                            <code> runtimeContext.metadata</code> — a schedule&apos;s variables, an A2A caller, or an
                            API request — and renders empty when nobody supplies it.
                        </Text>
                        {customVariables.length > 0 ? (
                            <Group gap={6}>
                                <Text size="xs" c="dimmed">References:</Text>
                                {customVariables.map((name) => (
                                    <Badge key={name} size="xs" variant="light">{name}</Badge>
                                ))}
                            </Group>
                        ) : (
                            <Group gap={6}>
                                <IconCheck size={12} />
                                <Text size="xs" c="dimmed">No caller-supplied variables referenced.</Text>
                            </Group>
                        )}
                    </Stack>
                </Alert>
            ) : null}
        </Stack>
    );
}
