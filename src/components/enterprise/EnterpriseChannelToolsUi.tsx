'use client';

/**
 * Where the agent tool picker reaches Agent Channels (tools that write to Slack / Teams as the agent's own bot).
 *
 * Channels ship with the Enterprise overlay. The community build gets this file: no channel tools are offered.
 * The Enterprise overlay replaces it at the same path, so keep every export and its shape as they are.
 */

/** A tool group as the picker lists it (structurally the picker's own `ToolSourceGroup`). */
export interface ChannelToolGroup {
  source: 'system';
  sourceKey: 'channel';
  name: string;
  description?: string;
  typeLabel: string;
  tools: { name: string; description: string }[];
}

/** The "Channels" group of the tool picker, or null where Channels are not available. */
export function useChannelToolGroup(): ChannelToolGroup | null {
  return null;
}
