'use client';

/**
 * CatalogPriceFill — "Fill from catalog" affordance for model pricing forms.
 *
 * Queries the model price catalog (`/api/model-price-catalog/suggest`) with
 * the model id the user has entered and hands the matched per-1M prices back
 * through `onApply` so the caller can populate its pricing fields. The match's
 * token limits (max input / max output, when the catalog has them) ride along
 * in `meta` so the caller can fill an EMPTY context window / maximum output
 * tokens field too. No match
 * (or an ambiguous one — the API never guesses) surfaces as an informational
 * notification instead of touching the form.
 */

import { useState } from 'react';
import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconSparkles } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

export interface CatalogPricingFill {
  inputTokenPer1M: number;
  outputTokenPer1M: number;
  cachedTokenPer1M: number;
  /** 0 = the catalog has no cache-write price (leave the field blank). */
  cacheWriteTokenPer1M: number;
}

export interface CatalogFillMeta {
  catalogKey: string;
  confidence: string;
  /** The catalog entry's `max_input_tokens` (the context window); absent when the feed has none. */
  maxInputTokens?: number;
  /** The catalog entry's `max_output_tokens` (the model maximum); absent when the feed has none. */
  maxOutputTokens?: number;
}

interface CatalogPriceFillProps {
  /** Model id (or key/name) to look up; matching is the server's concern. */
  modelId: string;
  onApply: (pricing: CatalogPricingFill, meta: CatalogFillMeta) => void;
  size?: string;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export default function CatalogPriceFill({ modelId, onApply, size = 'compact-xs' }: CatalogPriceFillProps) {
  const t = useTranslations('modelPriceCatalog');
  const [loading, setLoading] = useState(false);

  const fill = async () => {
    const name = modelId.trim();
    if (!name) {
      notifications.show({
        color: 'orange',
        title: t('fill.missingModelIdTitle'),
        message: t('fill.missingModelIdMessage'),
      });
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/model-price-catalog/suggest?names=${encodeURIComponent(name)}`,
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Request failed');
      const match = payload.suggestions?.[0]?.match;
      if (!match) {
        notifications.show({
          color: 'blue',
          title: t('fill.noMatchTitle'),
          message: t('fill.noMatchMessage', { name }),
        });
        return;
      }
      onApply(
        {
          inputTokenPer1M: Number(match.pricing?.inputTokenPer1M) || 0,
          outputTokenPer1M: Number(match.pricing?.outputTokenPer1M) || 0,
          cachedTokenPer1M: Number(match.pricing?.cachedTokenPer1M) || 0,
          cacheWriteTokenPer1M: Number(match.pricing?.cacheWriteTokenPer1M) || 0,
        },
        {
          catalogKey: match.catalogKey,
          confidence: match.confidence,
          ...(positiveInt(match.maxInputTokens) ? { maxInputTokens: positiveInt(match.maxInputTokens) } : {}),
          ...(positiveInt(match.maxOutputTokens) ? { maxOutputTokens: positiveInt(match.maxOutputTokens) } : {}),
        },
      );
      notifications.show({
        color: 'teal',
        title: t('fill.filledTitle'),
        message: t('fill.filledMessage', {
          key: match.catalogKey,
          confidence: t(`confidence.${match.confidence}`),
        }),
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: t('fill.errorTitle'),
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      size={size}
      variant="subtle"
      loading={loading}
      leftSection={<IconSparkles size={13} />}
      onClick={() => void fill()}
    >
      {t('fill.button')}
    </Button>
  );
}
