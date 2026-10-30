/**
 * Routes every outbound `fetch()` call (built on undici under Node 18+)
 * through the configured corporate egress proxy, using the same
 * HTTP(S)_PROXY / NO_PROXY environment variables already forwarded to
 * Chromium (browserProxyConfig.ts) and MCP subprocesses (stdioRunner.ts).
 *
 * Model/document-processing provider calls (OpenAI, Azure, Google,
 * Mistral), the support/CRM handoff, and any other plain `fetch()` call in
 * this codebase never read those variables on their own -- on a network
 * that requires an egress proxy for internet access, every one of those
 * calls would fail or hang exactly the way Chromium did before the
 * equivalent fix there, and Node's own DNS/connect errors rarely name a
 * proxy as the cause.
 *
 * `EnvHttpProxyAgent` is undici's own env-driven dispatcher: hosts named in
 * NO_PROXY still connect directly. Its matching is narrower than curl's: a
 * plain entry matches that exact host, `.domain` / `*.domain` its
 * subdomains, and CIDR ranges are not understood at all. A no-op when no
 * proxy variable is set, which is the overwhelming majority of deployments
 * -- `setGlobalDispatcher` is not called at all, so there is no behavior
 * change and no experimental-API warning for anyone not using a proxy.
 */
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import { createLogger } from './logger';
import { normalizeProxyEnv, readEgressProxyEnv } from './proxyEnv';

const logger = createLogger('startup');

export function configureOutboundProxy(): void {
  // Before anything reads the variables: undici, axios, Chromium and child
  // processes only know the standard spellings.
  for (const { variable, adoptedAs } of normalizeProxyEnv()) {
    logger.warn('Proxy variable read under a non-standard name; rename it, most tools ignore it', {
      variable,
      adoptedAs,
    });
  }

  const { proxy, noProxy } = readEgressProxyEnv();
  if (!proxy) return;

  setGlobalDispatcher(new EnvHttpProxyAgent());
  logger.info('Outbound fetch() routed through the configured egress proxy', {
    proxyVariable: proxy.variable,
    bypassConfigured: Boolean(noProxy),
  });
}
