/**
 * Channel tools seam — COMMUNITY (open-source) edition.
 *
 * Agent Channels (an enterprise feature) put one agent behind a Slack app or a Microsoft Teams bot. Besides
 * answering the people who write to it there, such an agent can be given tools to write on its own, as that same
 * bot: a direct message to a person, a post in a channel, an edit of a message it sent. The agent record keeps the
 * binding (`{ source: 'system', sourceKey: 'channel', toolNames }`); the tools themselves, the platform calls and
 * who may be written to belong to the Channels module, which registers its builder here.
 *
 * Contract:
 *   - Nothing is registered in the community edition: `getChannelToolsHost()` answers null and a `channel` binding
 *     is left out of the run (the agent runs without those tools).
 *   - The overlay calls `registerChannelToolsHost(...)` once at load, from its `registry.ts`. This is a separate
 *     community file (NOT replaced by the overlay), so the `registry.ts` seam shape and SEAM_CONTRACT_VERSION do not
 *     change because of it.
 *   - The host decides everything about access: which of the agent's channel deployments offer tools, to whom and
 *     where they may write. It builds no tool for an agent that has no deployment allowing it.
 *   - Licensing is the host's job.
 *
 * Leaf module on purpose: only types are imported, so the overlay registry can import it at load time without
 * creating a cycle. Never read the registered value at module scope: resolve it at call time.
 */
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';

/** The tools a `channel` binding can name (`toolNames`). The host prefixes them with the platform (`slack_…`). */
export const CHANNEL_TOOL_NAMES = ['list_channels', 'send_direct_message', 'send_channel_message', 'update_message'] as const;
export type ChannelToolName = (typeof CHANNEL_TOOL_NAMES)[number];

export function isChannelToolName(name: unknown): name is ChannelToolName {
  return typeof name === 'string' && (CHANNEL_TOOL_NAMES as readonly string[]).includes(name);
}

export interface ChannelToolsBuildInput {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  /** The agent the run is for. No agent, no tools: a deployment belongs to one agent. */
  agentKey?: string;
  /** The tools the binding names (already filtered to {@link CHANNEL_TOOL_NAMES}). */
  toolNames: readonly ChannelToolName[];
  /** The person the run is for (the accountable user of an unattended run), when there is one. */
  userId?: string;
  /** The session the run belongs to: a reply from that same person in the chat continues it. */
  conversationId?: string;
  /** Where the run came from; for a run started from a chat, its platform, channel and thread are in `metadata`. */
  runtimeContext?: AgentRuntimeContext;
  /** The SDK's `createTool`, so the tools are built by the same SDK instance as the rest. */
  createToolFn: (definition: {
    name: string;
    description: string;
    schema: unknown;
    func: (args: Record<string, unknown>) => Promise<unknown>;
  }) => unknown;
  /** zod, from the same module instance the agent runtime uses. */
  zod: typeof import('zod').z;
}

export interface ChannelToolsHost {
  /** The agent's channel tools for one run. Empty when none of its deployments allows writing on its own. */
  buildTools(input: ChannelToolsBuildInput): Promise<readonly unknown[]>;
}

let host: ChannelToolsHost | null = null;

/** Called once by the enterprise overlay at load. */
export function registerChannelToolsHost(next: ChannelToolsHost): void {
  host = next;
}

/** The registered host, or null in the community edition. */
export function getChannelToolsHost(): ChannelToolsHost | null {
  return host;
}

/** Tests only: forget the registered host. */
export function __resetChannelToolsHostForTests(): void {
  host = null;
}
