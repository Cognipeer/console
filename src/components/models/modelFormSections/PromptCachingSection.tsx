import { Alert, Button, Select, Text } from '@mantine/core';
import { FormField, FormSection, ToggleList, ToggleRow } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { CLAUDE_CACHE_WRITE_MULTIPLIER } from '@/lib/services/models/pricingRates';
import { resolvePromptCaching, type PromptCachingSettings } from '@/lib/services/models/promptCaching';
import { normalizePromptCaching, type CatalogCachePrices } from '@/components/models/promptCachingForm';

import { PRICING_SECTION_ID } from './promptCachingIds';

interface PromptCachingSectionProps {
  number: number;
  driver?: string;
  /** Provider-side model id (decides the Bedrock / Vertex family). */
  modelId?: string;
  /** `settings.promptCaching` as the form holds it; undefined = the default. */
  value?: PromptCachingSettings;
  /** The next value; undefined = back to the default. */
  onChange: (next: PromptCachingSettings | undefined) => void;
  pricing: { currency?: string; cached: number | ''; cacheWrite: number | '' };
  /** The catalog's cache prices for this model id; null / absent hides "Fill from catalog". */
  catalogPrices?: CatalogCachePrices | null;
  onFillCatalog?: (prices: CatalogCachePrices) => void;
  /** Opened from the model page's "Edit": scroll here. */
  focusOnMount?: boolean;
}

/** Scroll to the Pricing section and focus its cache read price. */
function goToPricing() {
  const section = document.getElementById(PRICING_SECTION_ID);
  section?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  const fields = section?.querySelectorAll<HTMLElement>('input');
  // Currency, input, output, cache read, cache write.
  fields?.[3]?.focus({ preventScroll: true });
}

const empty = (value: number | '') => value === '' || !(Number(value) > 0);

/**
 * Section "Prompt caching": the per-model "Cache prompts" switch and what to cache. Only providers that cache
 * where the request marks breakpoints (Anthropic, Bedrock Claude / Nova, Claude on Vertex) get a switch; the
 * others get a note. Requests that bring their own cache_control markers keep them either way.
 */
export default function PromptCachingSection({
  number,
  driver,
  modelId,
  value,
  onChange,
  pricing,
  catalogPrices,
  onFillCatalog,
  focusOnMount,
}: PromptCachingSectionProps) {
  const t = useTranslations('modelPromptCaching');
  const resolved = resolvePromptCaching(driver, modelId, value);
  const nova = resolved.family === 'nova';
  const claude = resolved.family === 'claude';
  const readEmpty = empty(pricing.cached);
  const writeEmpty = empty(pricing.cacheWrite);
  const priceWarning = resolved.enabled && (readEmpty || writeEmpty);
  const catalogUseful = Boolean(
    catalogPrices && ((readEmpty && catalogPrices.cachedTokenPer1M > 0) || (writeEmpty && catalogPrices.cacheWriteTokenPer1M > 0)),
  );
  const money = (price: number | '') => (pricing.currency ? `${pricing.currency} ${price}` : String(price));

  const patch = (next: PromptCachingSettings) => onChange(normalizePromptCaching({ ...value, ...next }, driver, modelId));

  const caption = !resolved.enabled
    ? t('caption.off')
    : claude
      ? t('caption.claude')
      : nova
        ? t('caption.nova')
        : t('caption.other');

  return (
    <FormSection focusOnMount={focusOnMount} number={number} title={t('title')} badge={t('badge')} description={t('description')} done={resolved.enabled}>
      {resolved.support === 'automatic' ? (
        <div data-testid="prompt-caching-automatic">
          <Text size="sm">{t('automatic.text')}</Text>
          <Text size="sm" c="dimmed">{t('automatic.usage')}</Text>
        </div>
      ) : (
        <>
          <ToggleList>
            <ToggleRow
              label={t('switch')}
              description={resolved.support === 'none' ? driver === 'bedrock' ? t('none.bedrock') : t('none.other') : caption}
              checked={resolved.enabled}
              disabled={resolved.support === 'none'}
              onChange={(checked) => patch({ enabled: checked })}
            />
          </ToggleList>

          {resolved.support === 'explicit' ? (
            <>
              <FormField
                label={t('what.label')}
                hint={nova ? t('what.novaHint') : resolved.enabled && resolved.strategy === 'static' ? t('what.staticHint') : t('what.autoHint')}
              >
                <Select
                  data={[
                    { value: 'auto', label: t('what.auto') },
                    { value: 'static', label: nova ? t('what.staticNova') : t('what.static') },
                  ]}
                  value={resolved.strategy}
                  allowDeselect={false}
                  disabled={!resolved.enabled}
                  onChange={(next) => patch({ strategy: next === 'static' ? 'static' : 'auto' })}
                />
              </FormField>

              <Text size="sm" c="dimmed" data-testid="prompt-caching-billing">
                {t('billing.line', {
                  read: readEmpty ? t('billing.inputPrice') : money(pricing.cached),
                  write: writeEmpty
                    ? claude
                      ? t('billing.assumedWrite', { multiplier: CLAUDE_CACHE_WRITE_MULTIPLIER })
                      : t('billing.inputPrice')
                    : money(pricing.cacheWrite),
                })}{' '}
                <Button variant="subtle" size="compact-xs" onClick={goToPricing} data-testid="prompt-caching-edit-pricing">
                  {t('billing.edit')}
                </Button>
              </Text>

              {priceWarning ? (
                <Alert color="orange" variant="light" data-testid="prompt-caching-price-warning">
                  <Text size="sm">{t('priceWarning.text')}</Text>
                  {writeEmpty && claude ? (
                    <Text size="sm" mt={4}>{t('priceWarning.assumedWrite', { multiplier: CLAUDE_CACHE_WRITE_MULTIPLIER })}</Text>
                  ) : null}
                  <Text size="sm" mt={4} component="div">
                    {catalogUseful && catalogPrices && onFillCatalog ? (
                      <>
                        <Button
                          variant="light"
                          color="orange"
                          size="compact-xs"
                          onClick={() => onFillCatalog(catalogPrices)}
                          data-testid="prompt-caching-fill-catalog"
                        >
                          {t('priceWarning.fill')}
                        </Button>{' '}
                        {t('priceWarning.orSet')}
                      </>
                    ) : (
                      t('priceWarning.setInPricing')
                    )}
                  </Text>
                </Alert>
              ) : null}
            </>
          ) : null}

          {resolved.support === 'explicit' ? (
            <Text size="xs" c="dimmed" data-testid="prompt-caching-markers">
              {t('markers.before')} <code>cache_control</code> {resolved.enabled ? t('markers.on') : t('markers.off')}
            </Text>
          ) : null}
        </>
      )}
    </FormSection>
  );
}
