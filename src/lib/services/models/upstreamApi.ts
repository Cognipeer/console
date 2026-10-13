/**
 * The "Upstream API" of a Model Hub model: which OpenAI endpoint the console calls
 * for it. Pure on purpose (no server imports): the Model Hub form and the model page
 * import it too, so what the operator sees is what the gateway does.
 *
 *  - `chat` (default): Chat Completions.
 *  - `responses`: the Responses API.
 *
 * It is an explicit, per-model choice. Nothing picks it from the model id, and it
 * changes only the request the console sends upstream: the gateway endpoints keep
 * speaking the wire format their client asked for, whichever API serves the model.
 */

export const UPSTREAM_APIS = ['chat', 'responses'] as const;
export type UpstreamApi = (typeof UPSTREAM_APIS)[number];
export const DEFAULT_UPSTREAM_API: UpstreamApi = 'chat';

/** Drivers that speak the OpenAI schema, i.e. the only ones that can serve the Responses API. */
export const UPSTREAM_API_DRIVERS: ReadonlySet<string> = new Set(['openai', 'azure', 'openai-compatible', 'together']);

export function supportsUpstreamApiChoice(driver: string | undefined | null): boolean {
  return !!driver && UPSTREAM_API_DRIVERS.has(driver);
}

/** `chat` / `responses` (case-insensitive), or undefined for anything else. */
export function parseUpstreamApi(value: unknown): UpstreamApi | undefined {
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  return (UPSTREAM_APIS as readonly string[]).includes(lowered) ? (lowered as UpstreamApi) : undefined;
}

/** The API a model's settings select; anything unset or unknown is Chat Completions. */
export function resolveUpstreamApi(settings: unknown): UpstreamApi {
  if (!settings || typeof settings !== 'object') return DEFAULT_UPSTREAM_API;
  return parseUpstreamApi((settings as Record<string, unknown>).upstreamApi) ?? DEFAULT_UPSTREAM_API;
}

/** An error message when the settings' `upstreamApi` cannot be saved for this driver, else undefined. */
export function validateUpstreamApi(settings: unknown, driver: string | undefined | null): string | undefined {
  if (!settings || typeof settings !== 'object') return undefined;
  const raw = (settings as Record<string, unknown>).upstreamApi;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = parseUpstreamApi(raw);
  if (!parsed) return `upstreamApi must be one of: ${UPSTREAM_APIS.join(', ')}`;
  if (parsed === 'responses' && driver && !supportsUpstreamApiChoice(driver)) {
    return `upstreamApi "responses" is only available for the OpenAI-schema drivers (${[...UPSTREAM_API_DRIVERS].join(', ')}); "${driver}" does not support it`;
  }
  return undefined;
}
