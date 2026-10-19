/**
 * The environment an agent's sandbox gets from Config (`sandbox.envRefs`, `sandbox.secretRefs`,
 * `sandbox.groupRefs`), read once per run.
 *
 * Two destinations, like the typed fields they sit beside:
 *  - `machineEnv`: set on the sandbox machine when it is created (`env` + `envRefs` + non-secret group items);
 *  - `secrets`: passed to each command and scrubbed from output (`secrets` + `secretRefs` + secret group items).
 *
 * A secret value never reaches `machineEnv`: an `envRefs` item that has become secret in Config since the agent
 * was saved is treated as a secret. A name set explicitly (typed, or a single-item reference) beats a bound group.
 * Values are returned to the caller's memory only; nothing here persists or logs them.
 */

import type { DatabaseProvider, IAgentSandboxConfig, IConfigValueRef } from '@/lib/database';
import { resolveConfigRefs, type ConfigRefProblem } from '@/lib/services/config/configRefs';

/**
 * What a sandbox machine's env may hold. These are the sandbox module's own limits (EE `envSeal.ts`:
 * `ENV_MAX_VARS`, `ENV_MAX_VALUE_BYTES`), which core does not export; a machine created with more fails to
 * start, so Config values beyond them are left out here instead. Keep in step with envSeal.
 */
const SANDBOX_ENV_MAX_VARS = 100;
const SANDBOX_ENV_MAX_VALUE_BYTES = 32 * 1024;

export interface AgentSandboxConfigVarsInput {
  sandbox: IAgentSandboxConfig | undefined;
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  /** The agent's typed secrets, already opened (`openAgentSandboxSecrets`). */
  secrets?: Record<string, string>;
  /** An already switched tenant database; otherwise one is opened for `tenantDbName`. */
  db?: DatabaseProvider;
}

export interface AgentSandboxConfigVars {
  /** Variables for the machine: typed `env` + Config values that are not secret. Empty when there are none. */
  machineEnv: Record<string, string>;
  /** Variables for each command: typed secrets + Config secrets. */
  secrets: Record<string, string>;
  /** References that could not be used (those are left out) and name collisions between bound groups. */
  problems: ConfigRefProblem[];
}

export async function resolveAgentSandboxConfigVars(input: AgentSandboxConfigVarsInput): Promise<AgentSandboxConfigVars> {
  const sandbox = input.sandbox;
  const typedEnv = sandbox?.env ?? {};
  const typedSecrets = input.secrets ?? {};
  const envRefs = sandbox?.envRefs ?? {};
  const secretRefs = sandbox?.secretRefs ?? {};
  const groupRefs = sandbox?.groupRefs ?? [];

  if (Object.keys(envRefs).length === 0 && Object.keys(secretRefs).length === 0 && groupRefs.length === 0) {
    return { machineEnv: { ...typedEnv }, secrets: { ...typedSecrets }, problems: [] };
  }

  // One read for every reference, so a secret item is audited once however it is reached. A name in both maps
  // (a write refuses it) is taken as a secret: the safer of the two.
  const refs: Record<string, IConfigValueRef> = { ...envRefs, ...secretRefs };
  const { vars, problems } = await resolveConfigRefs({
    tenantDbName: input.tenantDbName,
    tenantId: input.tenantId,
    projectId: input.projectId,
    refs,
    groupRefs,
    reservedNames: [
      ...Object.keys(typedEnv),
      ...Object.keys(envRefs),
      ...Object.keys(typedSecrets),
      ...Object.keys(secretRefs),
    ],
    performedBy: `agent:${input.agentKey}`,
    ...(input.db ? { db: input.db } : {}),
  });

  const asSecret = new Set(Object.keys(secretRefs));
  const configEnv: Record<string, string> = {};
  const configSecrets: Record<string, string> = {};
  for (const [name, resolved] of Object.entries(vars)) {
    // `secretRefs` entries stay secret even if the item was made plain since; a secret item is never plain.
    (resolved.isSecret || asSecret.has(name) ? configSecrets : configEnv)[name] = resolved.value;
  }

  // The machine env is typed `env` + Config values and must stay within the sandbox's limits, or the machine
  // would not start. The typed ones are the agent's own and stay; Config values are admitted single-item
  // references first, then group items, until the variable count is used up. The rest becomes a problem.
  const budget = Math.max(0, SANDBOX_ENV_MAX_VARS - Object.keys(typedEnv).length);
  const explicit = new Set(Object.keys(envRefs));
  const ordered = Object.entries(configEnv).sort(([a], [b]) => Number(explicit.has(b)) - Number(explicit.has(a)));
  const admitted: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of ordered) {
    const source = vars[name]?.source ?? name;
    if (Buffer.byteLength(value, 'utf8') > SANDBOX_ENV_MAX_VALUE_BYTES) {
      problems.push({ reason: 'limit', name, source, message: `${name} (config item "${source}") is larger than ${SANDBOX_ENV_MAX_VALUE_BYTES / 1024} KiB and is left out of the sandbox environment.` });
    } else if (count >= budget) {
      problems.push({ reason: 'limit', name, source, message: `${name} (config item "${source}") is left out: a sandbox environment holds at most ${SANDBOX_ENV_MAX_VARS} variables.` });
    } else {
      admitted[name] = value;
      count += 1;
    }
  }

  return {
    machineEnv: { ...admitted, ...typedEnv },
    secrets: { ...configSecrets, ...typedSecrets },
    problems,
  };
}
