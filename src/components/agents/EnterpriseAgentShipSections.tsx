'use client';

/**
 * Extra sections of an agent's Ship tab that belong to Enterprise modules (for example the Slack / Microsoft Teams
 * channels this agent answers in).
 *
 * The community build renders nothing. The Enterprise overlay replaces this file at the same path with the real
 * sections, so keep the props as they are.
 */
export interface EnterpriseAgentShipSectionsProps {
  agentKey: string;
  projectId: string;
  agentName: string;
}

export default function EnterpriseAgentShipSections(_props: EnterpriseAgentShipSectionsProps) {
  return null;
}
