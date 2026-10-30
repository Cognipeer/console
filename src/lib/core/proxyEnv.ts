/**
 * Reads the deployment's egress proxy from the HTTP(S)_PROXY / NO_PROXY
 * conventions every outbound path in this process shares: Chromium
 * (browserProxyConfig.ts), fetch() (outboundProxyBootstrap.ts), axios, and
 * the MCP subprocesses stdioRunner.ts forwards them to.
 *
 * Environment names are case-sensitive on Linux, and every client reads its
 * own subset: undici and axios read `HTTPS_PROXY` / `https_proxy`, curl
 * ignores an upper-case `HTTP_PROXY`, Python accepts any casing. A
 * `HTTPS_Proxy` that the Python tooling of a deployment honours is invisible
 * to every Node client here, so the request goes direct and dies at the
 * firewall as a timeout that names no proxy at all.
 */

const PROXY_VARIABLES = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'] as const;

export type ProxyVariable = (typeof PROXY_VARIABLES)[number];

/** `process.env`, or any map shaped like it. */
type ProcessEnvLike = Record<string, string | undefined>;

export interface ProxyEnvValue {
  value: string;
  /** The variable the value was read from, as it is spelled in the environment. */
  variable: string;
}

/**
 * `NAME`, then `name`, then any other casing of it (`Https_Proxy`). A blank
 * value counts as unset, as it always has for these variables.
 */
export function readProxyVariable(
  name: ProxyVariable,
  env: ProcessEnvLike = process.env,
): ProxyEnvValue | undefined {
  const lower = name.toLowerCase();
  for (const variable of [name, lower]) {
    const value = env[variable]?.trim();
    if (value) return { value, variable };
  }
  for (const [variable, raw] of Object.entries(env)) {
    const value = raw?.trim();
    if (value && variable.toLowerCase() === lower) return { value, variable };
  }
  return undefined;
}

export interface EgressProxyEnv {
  /** The proxy for every scheme: HTTPS_PROXY, else HTTP_PROXY. */
  proxy?: ProxyEnvValue;
  noProxy?: ProxyEnvValue;
}

export function readEgressProxyEnv(env: ProcessEnvLike = process.env): EgressProxyEnv {
  return {
    proxy: readProxyVariable('HTTPS_PROXY', env) ?? readProxyVariable('HTTP_PROXY', env),
    noProxy: readProxyVariable('NO_PROXY', env),
  };
}

/**
 * Copy a proxy variable set under a non-standard casing (`HTTPS_Proxy`) to
 * its standard names, so that undici, axios, Chromium and every child
 * process see it as well. A standard name that is already set is never
 * overridden. Returns what was adopted, for the boot log.
 */
export function normalizeProxyEnv(
  env: ProcessEnvLike = process.env,
): Array<{ variable: string; adoptedAs: ProxyVariable }> {
  const adopted: Array<{ variable: string; adoptedAs: ProxyVariable }> = [];
  for (const name of PROXY_VARIABLES) {
    const found = readProxyVariable(name, env);
    if (!found || found.variable === name || found.variable === name.toLowerCase()) continue;
    env[name] = found.value;
    env[name.toLowerCase()] = found.value;
    adopted.push({ variable: found.variable, adoptedAs: name });
  }
  return adopted;
}
