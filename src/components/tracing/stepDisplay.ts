import type { HumanStepState } from '@/lib/shared/tracingSections';
import type { StepCategory, TraceNode } from './sessionModel';

/** Badge text and Mantine color per step category — one palette for list, timeline and breakdown. */
export const CATEGORY_DISPLAY: Record<StepCategory, { badge: string; color: string }> = {
  model: { badge: 'LLM', color: 'blue' },
  tool: { badge: 'Tool', color: 'violet' },
  retrieval: { badge: 'Retrieval', color: 'orange' },
  guardrail: { badge: 'Guardrail', color: 'grape' },
  human: { badge: 'Human', color: 'yellow' },
  span: { badge: 'Span', color: 'teal' },
  other: { badge: 'Step', color: 'gray' },
};

/** What a group header calls itself: the SDK's own vocabulary where it has one. */
export function groupBadge(node: TraceNode): string {
  if (node.inferred) return 'Step';
  const type = node.event?.type?.toLowerCase() ?? '';
  if (type === 'agent_iteration') return 'Iteration';
  if (node.category === 'tool') return 'Subagent';
  if (node.category === 'model') return 'LLM';
  return CATEGORY_DISPLAY[node.category].badge;
}

/** Badge for a step row: a person's step says which kind it is. */
export function stepBadge(node: TraceNode): string {
  if (node.human?.kind === 'approval') return 'Approval';
  if (node.human?.kind === 'question') return 'Question';
  if (node.human?.kind === 'client_tool') return 'Client tool';
  return CATEGORY_DISPLAY[node.category].badge;
}

/** Mantine color per approval / answer outcome. */
export const HUMAN_STATE_COLOR: Record<HumanStepState, string> = {
  pending: 'yellow',
  approved: 'green',
  rejected: 'red',
  answered: 'green',
  cancelled: 'gray',
  expired: 'orange',
  error: 'red',
};

export function nodeDurationMs(node: TraceNode): number | undefined {
  if (!node.timing?.hasDuration) return undefined;
  return node.timing.end - node.timing.start;
}
