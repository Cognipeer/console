/**
 * The managed "MCP protection" guardrail in the MCP guardrail pickers. It is
 * created for the workspace the first time a server is bound to it (see
 * `ensureMcpProtectionGuardrail` in guardrail/hooks/engine.ts, whose key this
 * mirrors), so the pickers offer it before it exists.
 */
export const MCP_PROTECTION_GUARDRAIL_KEY = 'mcp-protection';

const MCP_PROTECTION_LABEL = 'MCP protection · built-in (limits, secrets, prompt injection)';

/** `data` with the MCP protection option after the first entry (the default tool guardrail), unless already listed. */
export function withMcpProtectionOption(
  data: Array<{ value: string; label: string }>,
): Array<{ value: string; label: string }> {
  if (data.some((item) => item.value === MCP_PROTECTION_GUARDRAIL_KEY)) return data;
  return [...data.slice(0, 1), { value: MCP_PROTECTION_GUARDRAIL_KEY, label: MCP_PROTECTION_LABEL }, ...data.slice(1)];
}
