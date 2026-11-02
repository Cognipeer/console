'use client';

/**
 * The places where the agent screens reach the Flows module (FlowBase agents, flows as agent tools).
 *
 * Flows ship with the Enterprise overlay. The community build gets this file: no access, no extra options,
 * nothing rendered. The Enterprise overlay replaces it at the same path with the real parts, so keep every
 * export and its props as they are. The agent screens call these in the same order on every render, so the
 * community stubs can be plain functions.
 */
import type { ReactNode } from 'react';
import type { IAgentToolBinding } from '@/lib/database';

/** What the signed-in person may do with Flows in the active project. */
export interface FlowsAccess {
  read: boolean;
  write: boolean;
  admin: boolean;
}

const NO_ACCESS: FlowsAccess = { read: false, write: false, admin: false };

export function useFlowsAccess(): FlowsAccess {
  return NO_ACCESS;
}

// ── Agents list ──────────────────────────────────────────────────────────

/** Extra options of the list's kind filter (the FlowBase kind). */
export function useFlowKindFilterOptions(): Array<{ value: string; label: string }> {
  return [];
}

/** Badge next to the name of a FlowBase agent in the list. */
export function FlowKindBadge(): ReactNode {
  return null;
}

/** The "model" cell of a FlowBase agent in the list. */
export function FlowDrivenLabel(): ReactNode {
  return null;
}

/** Badge on the overview of a FlowBase agent. */
export function FlowOverviewBadge(): ReactNode {
  return null;
}

// ── Create agent ─────────────────────────────────────────────────────────

/** The FlowBase choice of the create-agent form. `null` while Flows are not available to the person. */
export interface FlowAgentCreate {
  /** The kind the person chose. */
  kind: 'smart' | 'flow';
  reset(): void;
  /** Subtitle of the form while FlowBase is chosen. */
  subtitle: string;
  /** Section 1: the Smart / FlowBase choice. */
  typeSection: ReactNode;
  /** Section 3 while FlowBase is chosen: how the flow starts. */
  startSection: ReactNode;
  /** Creates the agent with its flow (the person is told when the flow could not be linked). */
  create(values: { name: string; description?: string }): Promise<{ agentId: string; flowId?: string }>;
}

export function useFlowAgentCreate(): FlowAgentCreate | null {
  return null;
}

// ── Agent detail ─────────────────────────────────────────────────────────

/** Texts of the agent detail page that belong to Flows. */
export interface FlowDetailTexts {
  ownedEyebrow: string;
  flowEyebrow: string;
  flowBuildDescription: string;
  flowsTab: string;
  exposeFailed: string;
}

export function useFlowDetailTexts(): FlowDetailTexts {
  return {
    ownedEyebrow: 'Agent in a flow',
    flowEyebrow: 'Build · Flow agent',
    flowBuildDescription: '',
    flowsTab: 'Flows',
    exposeFailed: 'Flows are part of the Enterprise edition.',
  };
}

/** The Build card of a FlowBase agent. */
export function FlowAgentCard(props: {
  agentId: string;
  config: unknown;
  canWrite: boolean;
  onSaved: () => void;
}): ReactNode {
  void props;
  return <p className="ds-muted">FlowBase agents are part of the Enterprise edition.</p>;
}

/** The Flows tab of an agent. */
export function AgentFlowsPanel(props: {
  agentId: string;
  agentKey: string;
  config: unknown;
  access: FlowsAccess;
  onToolBindingsChange: (bindings: IAgentToolBinding[]) => Promise<void>;
  onAgentChanged: () => void;
}): ReactNode {
  void props;
  return null;
}

// ── Tool picker ──────────────────────────────────────────────────────────

/** One flow offered as a tool in the picker. */
export interface FlowToolGroup {
  source: 'flow';
  sourceKey: string;
  name: string;
  description?: string;
  typeLabel: string;
  tools: Array<{ name: string; description: string }>;
}

/** Flows as a source of the tool picker. `null` where Flows are not available. Keep the object stable between renders. */
export interface FlowToolSource {
  /** The flows that can run as a tool, as picker groups, and what `rebuildBinding` needs about them. */
  load(value: IAgentToolBinding[]): Promise<{ groups: FlowToolGroup[]; known: Record<string, unknown> }>;
  /** A picked flow binding: keeps what the Flows tab set, or is built the same way. */
  rebuildBinding(binding: IAgentToolBinding, value: IAgentToolBinding[], known: Record<string, unknown>): IAgentToolBinding;
}

export function useFlowToolSource(): FlowToolSource | null {
  return null;
}
