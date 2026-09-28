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
import { describedSelectOption, type DescribedSelectOption } from './ConfigSection';

export interface AgentAdvancedSettingsProps {
    value: IAgentRuntimeConfig;
    onChange: (next: IAgentRuntimeConfig) => void;
    /** Tool names available to this agent, offered as ContextPilot exclusions. */
    toolNames?: string[];
}

const PROFILE_OPTIONS: DescribedSelectOption[] = [
    {
        value: 'fast',
        label: 'fast',
        description: 'Up to 3 tool calls run at once — the leanest starting point. Lower the numbers in Limits below too for the cheapest, quickest runs.',
    },
    {
        value: 'balanced',
        label: 'balanced — console default',
        description: 'Up to 5 tool calls run at once. The default starting point, matching this console\u2019s own Limits/Context defaults below.',
    },
    {
        value: 'deep',
        label: 'deep',
        description: 'Up to 8 tool calls run at once. For a longer, deeper run, also raise Max tool calls / Max context tokens below — the profile alone does not.',
    },
    {
        value: 'research',
        label: 'research',
        description: 'Up to 10 tool calls run at once — the highest concurrency. For the widest context budget, also raise Max context tokens below — the profile alone does not.',
    },
];

const PLANNING_OPTIONS: DescribedSelectOption[] = [
    { value: 'off', label: 'off', description: 'The agent answers directly — no planning tool is added.' },
    {
        value: 'todo',
        label: 'todo',
        description: 'Adds a manage_plan checklist tool and has the agent draft and keep a plan updated for multi-step work — more reliable on longer tasks, at the cost of an extra tool call and tokens.',
    },
    {
        value: 'planner_executor',
        label: 'planner_executor',
        description: 'Currently behaves the same as todo in this runtime version — reserved for a future plan/execute split.',
    },
    {
        value: 'reasoning_then_tools',
        label: 'reasoning_then_tools',
        description: 'Currently behaves the same as todo in this runtime version — reserved for a future think-first strategy.',
    },
];

const REPLAN_OPTIONS: AgentReplanPolicy[] = ['never', 'on_failure', 'on_conflict', 'every_n_steps'];

const CONTEXT_POLICY_OPTIONS: DescribedSelectOption[] = [
    {
        value: 'raw',
        label: 'raw',
        description: 'Sends the full raw transcript, clamped only to Max context tokens — no compaction, most tokens, exact history.',
    },
    {
        value: 'summary_only',
        label: 'summary_only',
        description: 'Sends the running summary plus a handful of the most recent turns — the smallest context; older detail is only recoverable via get_tool_response.',
    },
    {
        value: 'hybrid',
        label: 'hybrid',
        description: 'Sends the running summary plus the last N turns (Last turns to keep) — the default balance of recall and token cost.',
    },
];

const RETENTION_OPTIONS: DescribedSelectOption[] = [
    {
        value: 'keep_full',
        label: 'keep_full',
        description: 'The tool\u2019s raw output stays in the transcript verbatim — most tokens, nothing to fetch back later.',
    },
    {
        value: 'keep_structured',
        label: 'keep_structured',
        description: 'A short structured preview stays in the transcript; the agent can pull the full payload with get_tool_response if it needs a specific field.',
    },
    {
        value: 'summarize_archive',
        label: 'summarize_archive',
        description: 'A summary stays in the transcript and the original is archived, still fully recoverable via get_tool_response.',
    },
    {
        value: 'drop',
        label: 'drop',
        description: 'Only a placeholder stays in the transcript; the original is still recoverable via get_tool_response if the agent asks for it.',
    },
];

const renderProfileOption = describedSelectOption(PROFILE_OPTIONS);
const renderPlanningOption = describedSelectOption(PLANNING_OPTIONS);
const renderContextPolicyOption = describedSelectOption(CONTEXT_POLICY_OPTIONS);
const renderRetentionOption = describedSelectOption(RETENTION_OPTIONS);

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
                description="A starting point for the run's shape — concretely, how many tool calls can run at once. Set explicit ceilings on tool calls, context size, spend and duration in Limits below; those always take priority over the profile."
                data={PROFILE_OPTIONS}
                renderOption={renderProfileOption}
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
                    description="Off answers directly. Any other mode adds a manage_plan checklist tool and has the agent keep a plan for multi-step work — more reliable on longer tasks, at the cost of an extra tool call and tokens."
                    data={PLANNING_OPTIONS}
                    renderOption={renderPlanningOption}
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
                        description="Hard ceiling on tool calls for the whole run; the agent stops using tools once it hits this. Not changed by the Runtime profile above."
                        placeholder="12"
                        min={1}
                        value={limits.maxToolCalls ?? ''}
                        onChange={(next) => patch({ limits: { ...limits, maxToolCalls: numberValue(next) } })}
                    />
                    <NumberInput
                        label="Max parallel tools"
                        description="How many tool calls can run at once in a single turn. The one limit that does vary with the Runtime profile above when left blank."
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
                        description="Token budget the assembled context (system prompt, summary, kept turns) is clamped to before each model call. Not changed by the Runtime profile above."
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
                        description="Hard stop once the run's cumulative output tokens, across every model call, exceed this — independent of Max context tokens."
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
                        description="Hard stop once the run has been going this long in real time, regardless of tool calls or tokens used."
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
                    description="How much of the conversation is sent to the model on each turn."
                    data={CONTEXT_POLICY_OPTIONS}
                    renderOption={renderContextPolicyOption}
                    value={context.policy ?? 'hybrid'}
                    onChange={(next) =>
                        patch({ context: { ...context, policy: (next as AgentContextPolicy) ?? 'hybrid' } })
                    }
                    allowDeselect={false}
                />
                <Group grow>
                    <NumberInput
                        label="Last turns to keep"
                        description="How many of the most recent turns stay verbatim in context under hybrid/summary_only. Higher keeps more detail; lower saves tokens."
                        placeholder="10"
                        min={1}
                        value={context.lastTurnsToKeep ?? ''}
                        onChange={(next) =>
                            patch({ context: { ...context, lastTurnsToKeep: numberValue(next) } })
                        }
                    />
                    <Select
                        label="Tool response retention"
                        description="What happens to a tool's output once it leaves the live context window."
                        data={RETENTION_OPTIONS}
                        renderOption={renderRetentionOption}
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
                    description="Compacts older messages and tool history into a running summary instead of truncating blindly. Turn off only for short runs or when you need the exact raw transcript."
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
                        description="Context size that triggers a compaction pass."
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
                        description="Token budget the resulting summary, plus recent turns, must fit inside."
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
                        description="A tool output above this size gets retained per the policy above (structured preview / archived / dropped) instead of kept in full."
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
                        description="Same ceiling, counted in tokens instead of characters — whichever limit a tool response hits first applies."
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
                    description="Turns on the model's native extended-thinking mode, on providers that support it. Uses more tokens — and, on some providers, more time — per response."
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
                        description="Anthropic/Gemini-style token budget for the model's internal reasoning before it answers. Ignored by providers that use Provider effort instead (e.g. OpenAI)."
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
                        description="Exposes the model's raw reasoning text in the trace instead of hiding it — useful for debugging, but adds tokens and shows the chain of thought to anyone who can view traces."
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
