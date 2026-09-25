'use client';

/**
 * Runtime settings.
 *
 * Every control here is tri-state in spirit: leaving a field empty means "use
 * the console default", which is why the number inputs have no `defaultValue`
 * and write `undefined` when cleared. A blank field must not silently become 0 —
 * `maxToolCalls: 0` would be an agent that cannot call a tool.
 */

import { useMemo, type ReactNode } from 'react';
import {
    Alert,
    Badge,
    Group,
    MultiSelect,
    NumberInput,
    Paper,
    Select,
    Stack,
    Switch,
    Text,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';

import type {
    AgentContextPolicy,
    AgentPlanningMode,
    AgentReasoningEffort,
    AgentReasoningLevel,
    AgentReplanPolicy,
    AgentRuntimeProfile,
    AgentToolResponsePolicy,
    IAgentRuntimeConfig,
} from '@/lib/database/provider/types.domain';

export interface AgentAdvancedSettingsProps {
    value: IAgentRuntimeConfig;
    onChange: (next: IAgentRuntimeConfig) => void;
    /** Tool names available to this agent, offered as ContextPilot exclusions. */
    toolNames?: string[];
}

const PROFILE_OPTIONS: Array<{ value: AgentRuntimeProfile; label: string }> = [
    { value: 'fast', label: 'fast — fewest tokens, shortest loop' },
    { value: 'balanced', label: 'balanced — console default' },
    { value: 'deep', label: 'deep — longer loop, more tool calls' },
    { value: 'research', label: 'research — widest context budget' },
];

const PLANNING_OPTIONS: Array<{ value: AgentPlanningMode; label: string }> = [
    { value: 'off', label: 'off — answer directly' },
    { value: 'todo', label: 'todo — keep a visible checklist' },
    { value: 'planner_executor', label: 'planner_executor — plan, then execute' },
    { value: 'reasoning_then_tools', label: 'reasoning_then_tools — think first' },
];

const REPLAN_OPTIONS: AgentReplanPolicy[] = ['never', 'on_failure', 'on_conflict', 'every_n_steps'];

const CONTEXT_POLICY_OPTIONS: Array<{ value: AgentContextPolicy; label: string }> = [
    { value: 'raw', label: 'raw — keep the whole transcript' },
    { value: 'summary_only', label: 'summary_only — keep summaries only' },
    { value: 'hybrid', label: 'hybrid — recent turns plus summaries' },
];

const RETENTION_OPTIONS: AgentToolResponsePolicy[] = ['keep_full', 'keep_structured', 'summarize_archive', 'drop'];

/** `''` means "unset"; anything else is a number. */
function numberValue(input: string | number): number | undefined {
    if (input === '') return undefined;
    const parsed = typeof input === 'number' ? input : Number(input);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** One always-open group of runtime knobs. */
function SettingsGroup({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
    return (
        <Paper withBorder radius="md" p="md">
            <Group gap="xs" mb="sm">
                <Text size="sm" fw={600}>{title}</Text>
                {badge}
            </Group>
            <Stack gap="sm">{children}</Stack>
        </Paper>
    );
}

export default function AgentAdvancedSettings({
    value,
    onChange,
    toolNames = [],
}: AgentAdvancedSettingsProps) {
    const patch = (next: Partial<IAgentRuntimeConfig>) => onChange({ ...value, ...next });

    const toolOptions = useMemo(
        () => Array.from(new Set(['knowledge_search', ...toolNames])).map((name) => ({ value: name, label: name })),
        [toolNames],
    );

    const planning = value.planning ?? {};
    const limits = value.limits ?? {};
    const summarization = value.summarization ?? {};
    const context = value.context ?? {};
    const toolResponses = value.toolResponses ?? {};
    const contextPilot = value.contextPilot ?? {};
    const reasoning = value.reasoning ?? {};

    return (
        <Stack gap="md">
            <Alert icon={<IconInfoCircle size={16} />} variant="light" color="blue">
                <Text size="sm">
                    Every field here is optional. Leave one blank and the agent keeps the console
                    default — these settings only widen what a single agent may do, they never
                    change agents that do not use them.
                </Text>
            </Alert>

            <Select
                label="Runtime profile"
                description="Baseline the other knobs are applied on top of."
                data={PROFILE_OPTIONS}
                value={value.profile ?? 'balanced'}
                onChange={(next) => patch({ profile: (next as AgentRuntimeProfile) ?? undefined })}
                allowDeselect={false}
            />

            <SettingsGroup
                title="Planning"
                badge={planning.mode && planning.mode !== 'off' ? (
                    <Badge size="xs" variant="light">{planning.mode}</Badge>
                ) : null}
            >
                <Select
                    label="Mode"
                    data={PLANNING_OPTIONS}
                    value={planning.mode ?? 'off'}
                    onChange={(next) =>
                        patch({ planning: { ...planning, mode: (next as AgentPlanningMode) ?? 'off' } })
                    }
                    allowDeselect={false}
                />
                <Select
                    label="Replan policy"
                    data={REPLAN_OPTIONS}
                    value={planning.replanPolicy ?? 'on_failure'}
                    onChange={(next) =>
                        patch({
                            planning: {
                                ...planning,
                                replanPolicy: (next as AgentReplanPolicy) ?? 'on_failure',
                            },
                        })
                    }
                    disabled={(planning.mode ?? 'off') === 'off'}
                    allowDeselect={false}
                />
                {planning.replanPolicy === 'every_n_steps' ? (
                    <NumberInput
                        label="Replan every N steps"
                        min={1}
                        value={planning.everyNSteps ?? ''}
                        onChange={(next) =>
                            patch({ planning: { ...planning, everyNSteps: numberValue(next) } })
                        }
                    />
                ) : null}
            </SettingsGroup>

            <SettingsGroup title="Limits & budget">
                <Group grow>
                    <NumberInput
                        label="Max tool calls"
                        placeholder="12"
                        min={1}
                        value={limits.maxToolCalls ?? ''}
                        onChange={(next) => patch({ limits: { ...limits, maxToolCalls: numberValue(next) } })}
                    />
                    <NumberInput
                        label="Max parallel tools"
                        placeholder="SDK default"
                        min={1}
                        value={limits.maxParallelTools ?? ''}
                        onChange={(next) =>
                            patch({ limits: { ...limits, maxParallelTools: numberValue(next) } })
                        }
                    />
                </Group>
                <Group grow>
                    <NumberInput
                        label="Max context tokens"
                        placeholder="48000"
                        min={1000}
                        step={1000}
                        value={limits.maxContextTokens ?? ''}
                        onChange={(next) =>
                            patch({ limits: { ...limits, maxContextTokens: numberValue(next) } })
                        }
                    />
                    <NumberInput
                        label="Max total output tokens"
                        placeholder="unlimited"
                        min={100}
                        step={500}
                        value={limits.maxTotalOutputTokens ?? ''}
                        onChange={(next) =>
                            patch({ limits: { ...limits, maxTotalOutputTokens: numberValue(next) } })
                        }
                    />
                </Group>
                <Group grow>
                    <NumberInput
                        label="Max wall clock (ms)"
                        placeholder="unlimited"
                        min={1000}
                        step={1000}
                        value={limits.maxWallClockMs ?? ''}
                        onChange={(next) =>
                            patch({ limits: { ...limits, maxWallClockMs: numberValue(next) } })
                        }
                    />
                    <NumberInput
                        label="Max cost (USD)"
                        description="Needs a cost estimator on the run; ignored otherwise."
                        placeholder="unlimited"
                        min={0}
                        step={0.5}
                        decimalScale={2}
                        value={limits.maxCostUsd ?? ''}
                        onChange={(next) => patch({ limits: { ...limits, maxCostUsd: numberValue(next) } })}
                    />
                </Group>
            </SettingsGroup>

            <SettingsGroup title="Context & summarization">
                <Select
                    label="Context policy"
                    data={CONTEXT_POLICY_OPTIONS}
                    value={context.policy ?? 'hybrid'}
                    onChange={(next) =>
                        patch({ context: { ...context, policy: (next as AgentContextPolicy) ?? 'hybrid' } })
                    }
                    allowDeselect={false}
                />
                <Group grow>
                    <NumberInput
                        label="Last turns to keep"
                        placeholder="10"
                        min={1}
                        value={context.lastTurnsToKeep ?? ''}
                        onChange={(next) =>
                            patch({ context: { ...context, lastTurnsToKeep: numberValue(next) } })
                        }
                    />
                    <Select
                        label="Tool response retention"
                        data={RETENTION_OPTIONS}
                        value={context.toolResponsePolicy ?? 'summarize_archive'}
                        onChange={(next) =>
                            patch({
                                context: {
                                    ...context,
                                    toolResponsePolicy: (next as AgentToolResponsePolicy) ?? undefined,
                                },
                            })
                        }
                        allowDeselect={false}
                    />
                </Group>
                <Switch
                    label="Summarize when the context fills up"
                    checked={summarization.enable ?? true}
                    onChange={(event) =>
                        patch({
                            summarization: { ...summarization, enable: event.currentTarget.checked },
                        })
                    }
                />
                <Group grow>
                    <NumberInput
                        label="Summary trigger (tokens)"
                        placeholder="32000"
                        min={1000}
                        step={1000}
                        value={summarization.summaryTriggerTokens ?? ''}
                        onChange={(next) =>
                            patch({
                                summarization: {
                                    ...summarization,
                                    summaryTriggerTokens: numberValue(next),
                                },
                            })
                        }
                        disabled={summarization.enable === false}
                    />
                    <NumberInput
                        label="Summary budget (tokens)"
                        placeholder="48000"
                        min={1000}
                        step={1000}
                        value={summarization.maxTokens ?? ''}
                        onChange={(next) =>
                            patch({ summarization: { ...summarization, maxTokens: numberValue(next) } })
                        }
                        disabled={summarization.enable === false}
                    />
                </Group>
                <Group grow>
                    <NumberInput
                        label="Max tool response chars"
                        placeholder="80000"
                        min={1000}
                        step={1000}
                        value={toolResponses.maxToolResponseChars ?? ''}
                        onChange={(next) =>
                            patch({
                                toolResponses: {
                                    ...toolResponses,
                                    maxToolResponseChars: numberValue(next),
                                },
                            })
                        }
                    />
                    <NumberInput
                        label="Max tool response tokens"
                        placeholder="20000"
                        min={500}
                        step={500}
                        value={toolResponses.maxToolResponseTokens ?? ''}
                        onChange={(next) =>
                            patch({
                                toolResponses: {
                                    ...toolResponses,
                                    maxToolResponseTokens: numberValue(next),
                                },
                            })
                        }
                    />
                </Group>
            </SettingsGroup>

            <SettingsGroup
                title="ContextPilot"
                badge={contextPilot.enabled ? <Badge size="xs" color="teal" variant="light">on</Badge> : null}
            >
                <Switch
                    label="Compress large tool outputs before they enter the transcript"
                    description="Deterministic — no extra model calls. Originals stay retrievable."
                    checked={contextPilot.enabled ?? false}
                    onChange={(event) =>
                        patch({ contextPilot: { ...contextPilot, enabled: event.currentTarget.checked } })
                    }
                />
                <MultiSelect
                    label="Never compress these tools"
                    placeholder="Pick tools whose raw output matters"
                    data={toolOptions}
                    value={contextPilot.excludeTools ?? []}
                    onChange={(next) => patch({ contextPilot: { ...contextPilot, excludeTools: next } })}
                    disabled={!contextPilot.enabled}
                    searchable
                    clearable
                />
            </SettingsGroup>

            <SettingsGroup
                title="Reasoning"
                badge={reasoning.enabled ? <Badge size="xs" color="teal" variant="light">on</Badge> : null}
            >
                <Switch
                    label="Enable reasoning"
                    checked={reasoning.enabled ?? false}
                    onChange={(event) =>
                        patch({ reasoning: { ...reasoning, enabled: event.currentTarget.checked } })
                    }
                />
                <Group grow>
                    <Select
                        label="Level"
                        data={['minimal', 'low', 'medium', 'high']}
                        value={reasoning.level ?? null}
                        onChange={(next) =>
                            patch({ reasoning: { ...reasoning, level: (next as AgentReasoningLevel) ?? undefined } })
                        }
                        disabled={!reasoning.enabled}
                        clearable
                    />
                    <Select
                        label="Provider effort"
                        description="`none` is a value that gets sent, not off."
                        data={['none', 'minimal', 'low', 'medium', 'high']}
                        value={reasoning.effort ?? null}
                        onChange={(next) =>
                            patch({
                                reasoning: { ...reasoning, effort: (next as AgentReasoningEffort) ?? undefined },
                            })
                        }
                        disabled={!reasoning.enabled}
                        clearable
                    />
                </Group>
                <Group grow>
                    <NumberInput
                        label="Thinking budget (tokens)"
                        placeholder="provider default"
                        min={128}
                        step={128}
                        value={reasoning.budgetTokens ?? ''}
                        onChange={(next) =>
                            patch({ reasoning: { ...reasoning, budgetTokens: numberValue(next) } })
                        }
                        disabled={!reasoning.enabled}
                    />
                    <Switch
                        mt="lg"
                        label="Include thoughts in the trace"
                        checked={reasoning.includeThoughts ?? false}
                        onChange={(event) =>
                            patch({
                                reasoning: { ...reasoning, includeThoughts: event.currentTarget.checked },
                            })
                        }
                        disabled={!reasoning.enabled}
                    />
                </Group>
            </SettingsGroup>
        </Stack>
    );
}
