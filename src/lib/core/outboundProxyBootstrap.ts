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
 * `EnvHttpProxyAgent` is undici's own env-driven dispatcher: it parses
 * NO_PROXY with the same bypass semantics curl and most HTTP tooling use,
 * so internal/allow-listed hosts still connect directly. A no-op when no
 * proxy variable is set, which is the overwhelming majority of deployments
 * -- `setGlobalDispatcher` is not called at all, so there is no behavior
 * change and no experimental-API warning for anyone not using a proxy.
 */
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import { createLogger } from './logger';

const logger = createLogger('startup');

export function configureOutboundProxy(): void {
  const hasProxy =
    process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!hasProxy) return;

  setGlobalDispatcher(new EnvHttpProxyAgent());
  logger.info('Outbound fetch() routed through the configured egress proxy', {
    bypassConfigured: Boolean(process.env.NO_PROXY || process.env.no_proxy),
  });
}
