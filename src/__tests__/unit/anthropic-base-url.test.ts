import { describe, expect, it } from 'vitest';
import { normalizeAnthropicBaseUrl } from '@/lib/providers/contracts/anthropicBaseUrl';
import { SERVICE_CATALOG } from '@/lib/services/serviceCatalog';

describe('anthropic provider', () => {
  it('serves the Anthropic catalog card with the native driver, not openai-compatible', () => {
    expect(SERVICE_CATALOG.find((entry) => entry.id === 'anthropic')?.driver).toBe('anthropic');
  });

  it.each([
    ['https://cognipeer-prod-2.services.ai.azure.com/anthropic/v1/messages', 'https://cognipeer-prod-2.services.ai.azure.com/anthropic'],
    ['https://cognipeer-prod-2.services.ai.azure.com/anthropic/', 'https://cognipeer-prod-2.services.ai.azure.com/anthropic'],
    ['https://api.anthropic.com/v1', 'https://api.anthropic.com'],
    ['  https://proxy.example/claude/v1/messages/ ', 'https://proxy.example/claude'],
    ['', undefined],
    [undefined, undefined],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeAnthropicBaseUrl(input)).toBe(expected);
  });
});
