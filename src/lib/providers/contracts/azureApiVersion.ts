/**
 * The Azure OpenAI api-version a model is called with. One pure function shared by the gateway's Azure runtime
 * (`modelContracts`) and the evaluation SDK path (`sdkInvoker`), so an evaluation runs on the same Azure API as
 * production.
 */
import { resolveUpstreamApi } from '@/lib/services/models/upstreamApi';

/** The api-version a Responses model is called with when nothing newer is configured (adds reasoning summaries). */
export const AZURE_RESPONSES_API_VERSION = '2025-04-01-preview';
/** The first dated api-version that serves the Responses API (`2025-03-01-preview`). */
export const AZURE_RESPONSES_FIRST_DATE = '2025-03-01';

/**
 * Whether a dated api-version (`2024-10-21`, `2024-12-01-preview`) is older than the Responses API. An undated value
 * (`preview`, `latest`, `v1`) is left to the operator: nothing says which side of it it falls on.
 */
export function predatesAzureResponses(apiVersion: string): boolean {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(apiVersion)?.[0];
  return date !== undefined && date < AZURE_RESPONSES_FIRST_DATE;
}

/**
 * The api-version of ONE model on an Azure provider whose own version is `providerApiVersion`. It is per DEPLOYMENT,
 * not per resource: a model may override the provider's with `settings.azureApiVersion`. Otherwise a Responses model
 * (Upstream API = Responses) gets the version that has the Responses route (and reasoning summaries) unless the
 * provider's own already does; everything else keeps the provider's.
 */
export function azureApiVersion(providerApiVersion: string, modelSettings: unknown): string {
  const override = (modelSettings as Record<string, unknown> | undefined)?.azureApiVersion;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return resolveUpstreamApi(modelSettings) === 'responses' && predatesAzureResponses(providerApiVersion)
    ? AZURE_RESPONSES_API_VERSION
    : providerApiVersion;
}
