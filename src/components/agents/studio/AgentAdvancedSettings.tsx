'use client';

/**
 * The Advanced half of the settings split.
 *
 * Every control here is tri-state in spirit: leaving a field empty means "use
 * the console default", which is why the number inputs have no `defaultValue`
 * and write `undefined` when cleared. A blank field must not silently become 0 —
 * `maxToolCalls: 0` would be an agent that cannot call a tool.
 */

import { useMemo } from 'react';
import {
    Accordion,
    Alert,
    Badge,
    Group,
    MultiSelect,
    NumberInput,
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
    disabled?: boolean;
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

const REPLAN_OPTIONS: Array<{ value: AgentReplanPolicy; label: string }> = [
    { value: 'never', label: 'never' },
    { value: 'on_failure', label: 'on_failure' },
    { value: 'on_conflict', label: 'on_conflict' },
    { value: 'every_n_steps', label: 'every_n_steps' },
];

const CONTEXT_POLICY_OPTIONS: Array<{ value: AgentContextPolicy; label: string }> = [
    { value: 'raw', label: 'raw — keep the whole transcript' },
    { value: 'summary_only', label: 'summary_only — keep summaries only' },
    { value: 'hybrid', label: 'hybrid — recent turns plus summaries' },
];

const RETENTION_OPTIONS: Array<{ value: AgentToolResponsePolicy; label: string }> = [
    { value: 'keep_full', label: 'keep_full' },
    { value: 'keep_structured', label: 'keep_structured' },
    { value: 'summarize_archive', label: 'summarize_archive' },
    { value: 'drop', label: 'drop' },
];

/** `''` and `null` both mean "unset"; anything else is a number. */
function numberValue(input: string | number): number | undefined {
    if (input === '' || input === null || input === undefined) return undefined;
    const parsed = typeof input === 'number' ? input : Number(input);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export default function AgentAdvancedSettings({
    value,
    onChange,
    toolNames = [],
    disabled,
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
                disabled={disabled}
                allowDeselect={false}
            />

            <Accordion variant="separated" multiple defaultValue={['limits']}>
                <Accordion.Item value="planning">
                    <Accordion.Control>
                        <Group gap="xs">
                            <Text size="sm" fw={600}>Planning</Text>
                            {planning.mode && planning.mode !== 'off' ? (
                                <Badge size="xs" variant="light">{planning.mode}</Badge>
                            ) : null}
                        </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                        <Stack gap="sm">
                            <Select
                                label="Mode"
                                data={PLANNING_OPTIONS}
                                value={planning.mode ?? 'off'}
                                onChange={(next) =>
                                    patch({ planning: { ...planning, mode: (next as AgentPlanningMode) ?? 'off' } })
                                }
                                disabled={disabled}
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
                                disabled={disabled || (planning.mode ?? 'off') === 'off'}
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
                                    disabled={disabled}
                                />
                            ) : null}
                        </Stack>
                    </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="limits">
                    <Accordion.Control>
                        <Text size="sm" fw={600}>Limits &amp; budget</Text>
                    </Accordion.Control>
                    <Accordion.Panel>
                        <Stack gap="sm">
                            <Group grow>
                                <NumberInput
                                    label="Max tool calls"
                                    placeholder="12"
                                    min={1}
                                    value={limits.maxToolCalls ?? ''}
                                    onChange={(next) => patch({ limits: { ...limits, maxToolCalls: numberValue(next) } })}
                                    disabled={disabled}
                                />
                                <NumberInput
                                    label="Max parallel tools"
                                    placeholder="SDK default"
                                    min={1}
                                    value={limits.maxParallelTools ?? ''}
                                    onChange={(next) =>
                                        patch({ limits: { ...limits, maxParallelTools: numberValue(next) } })
                                    }
                                    disabled={disabled}
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
                                    disabled={disabled}
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
                                    disabled={disabled}
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
                                    disabled={disabled}
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
                                    disabled={disabled}
                                />
                            </Group>
                        </Stack>
                    </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="context">
                    <Accordion.Control>
                        <Text size="sm" fw={600}>Context &amp; summarization</Text>
                    </Accordion.Control>
                    <Accordion.Panel>
                        <Stack gap="sm">
                            <Select
                                label="Context policy"
                                data={CONTEXT_POLICY_OPTIONS}
                                value={context.policy ?? 'hybrid'}
                                onChange={(next) =>
                                    patch({ context: { ...context, policy: (next as AgentContextPolicy) ?? 'hybrid' } })
                                }
                                disabled={disabled}
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
                                    disabled={disabled}
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
                                    disabled={disabled}
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
                                disabled={disabled}
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
                                    disabled={disabled || summarization.enable === false}
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
                                    disabled={disabled || summarization.enable === false}
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
                                    disabled={disabled}
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
                                    disabled={disabled}
                                />
                            </Group>
                        </Stack>
                    </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="contextPilot">
                    <Accordion.Control>
                        <Group gap="xs">
                            <Text size="sm" fw={600}>ContextPilot</Text>
                            {contextPilot.enabled ? <Badge size="xs" color="teal" variant="light">on</Badge> : null}
                        </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                        <Stack gap="sm">
                            <Switch
                                label="Compress large tool outputs before they enter the transcript"
                                description="Deterministic — no extra model calls. Originals stay retrievable."
                                checked={contextPilot.enabled ?? false}
                                onChange={(event) =>
                                    patch({ contextPilot: { ...contextPilot, enabled: event.currentTarget.checked } })
                                }
                                disabled={disabled}
                            />
                            <MultiSelect
                                label="Never compress these tools"
                                placeholder="Pick tools whose raw output matters"
                                data={toolOptions}
                                value={contextPilot.excludeTools ?? []}
                                onChange={(next) => patch({ contextPilot: { ...contextPilot, excludeTools: next } })}
                                disabled={disabled || !contextPilot.enabled}
                                searchable
                                clearable
                            />
                        </Stack>
                    </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="reasoning">
                    <Accordion.Control>
                        <Group gap="xs">
                            <Text size="sm" fw={600}>Reasoning</Text>
                            {reasoning.enabled ? <Badge size="xs" color="teal" variant="light">on</Badge> : null}
                        </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                        <Stack gap="sm">
                            <Switch
                                label="Enable reasoning"
                                checked={reasoning.enabled ?? false}
                                onChange={(event) =>
                                    patch({ reasoning: { ...reasoning, enabled: event.currentTarget.checked } })
                                }
                                disabled={disabled}
                            />
                            <Group grow>
                                <Select
                                    label="Level"
                                    data={['minimal', 'low', 'medium', 'high']}
                                    value={reasoning.level ?? null}
                                    onChange={(next) =>
                                        patch({ reasoning: { ...reasoning, level: (next as AgentReasoningLevel) ?? undefined } })
                                    }
                                    disabled={disabled || !reasoning.enabled}
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
                                    disabled={disabled || !reasoning.enabled}
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
                                    disabled={disabled || !reasoning.enabled}
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
                                    disabled={disabled || !reasoning.enabled}
                                />
                            </Group>
                        </Stack>
                    </Accordion.Panel>
                </Accordion.Item>

                {/* Memory moved to its own tab — see AgentMemoryPanel. It needs a
                    real backing store picked from the Memory module, which does
                    not fit this accordion's "knob with a default" shape. */}

                <Accordion.Item value="hitl">
                    <Accordion.Control>
                        <Text size="sm" fw={600}>Human in the loop</Text>
                    </Accordion.Control>
                    <Accordion.Panel>
                        <Switch
                            label="Let the agent ask the user a question mid-run"
                            description="Adds the `ask_user_question` tool. The caller must be able to answer — useful in the playground, a dead end for an unattended scheduled run."
                            checked={value.askUser ?? false}
                            onChange={(event) => patch({ askUser: event.currentTarget.checked })}
                            disabled={disabled}
                        />
                    </Accordion.Panel>
                </Accordion.Item>
            </Accordion>
        </Stack>
    );
}

/** Kept exported so the settings header can show how far an agent strays from defaults. */
export function countAdvancedOverrides(runtime: IAgentRuntimeConfig | undefined): number {
    if (!runtime) return 0;
    let count = 0;
    if (runtime.profile && runtime.profile !== 'balanced') count += 1;
    if (runtime.planning?.mode && runtime.planning.mode !== 'off') count += 1;
    for (const key of Object.keys(runtime.limits ?? {})) {
        if ((runtime.limits as Record<string, unknown>)[key] !== undefined) count += 1;
    }
    if (runtime.contextPilot?.enabled) count += 1;
    if (runtime.reasoning?.enabled) count += 1;
    if (runtime.askUser) count += 1;
    return count;
}
