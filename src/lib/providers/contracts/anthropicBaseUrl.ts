/**
 * The Anthropic client appends `/v1/messages` itself, so the Base URL is the service root
 * (`https://api.anthropic.com`, `https://<resource>.services.ai.azure.com/anthropic`). Operators
 * paste the full endpoint from the vendor's docs, which makes the request go to
 * `…/v1/messages/v1/messages` and the upstream answers 404; strip what the client adds.
 */
export function normalizeAnthropicBaseUrl(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  const root = trimmed.replace(/\/+$/, '').replace(/\/v1\/messages$/i, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
  return root || undefined;
}
