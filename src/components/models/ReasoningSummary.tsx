'use client';

import { Badge, Group, Stack, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { detectUnsupportedParams } from '@/lib/providers/unsupportedParams';
import { describeEffectiveReasoning, reasoningBudget } from '@/lib/services/models/reasoning';

interface ReasoningSummaryProps {
  settings: Record<string, unknown> | undefined;
  driver?: string;
  modelId?: string;
}

/**
 * The model page's statement of what reasoning does for this model: the
 * effective default, whether the text reaches callers, and the GPT-5 + tools
 * rule that overrides both when a request carries function tools.
 */
export default function ReasoningSummary({ settings, driver, modelId }: ReasoningSummaryProps) {
  const t = useTranslations('modelReasoning');
  const forced = Boolean(detectUnsupportedParams(driver, modelId, true).forced?.reasoning_effort);
  const { reasoning, returned, forcedNoneWithTools } = describeEffectiveReasoning({
    settings,
    forcedNoneWithTools: forced,
  });
  const budget = reasoningBudget(reasoning);

  return (
    <div className="ds-card ds-card-pad-lg" data-testid="model-reasoning-summary">
      <div className="ds-h4" style={{ marginBottom: 12 }}>{t('detail.title')}</div>
      <Stack gap="xs">
        <div className="ds-row-between" style={{ fontSize: 12.5 }}>
          <span className="ds-muted">{t('detail.effective')}</span>
          <Group gap={6}>
            {reasoning?.effort ? <Badge variant="light" radius="sm">{reasoning.effort}</Badge> : null}
            {reasoning?.budgetTokens && budget ? (
              <Badge variant="light" color="gray" radius="sm">
                {t('detail.budget', { tokens: budget.toLocaleString() })}
              </Badge>
            ) : null}
            {!reasoning ? <span className="ds-faint">{t('detail.notSet')}</span> : null}
          </Group>
        </div>
        <Text size="xs" c="dimmed">{returned ? t('detail.returned') : t('detail.hidden')}</Text>
        {forcedNoneWithTools ? (
          <Text size="xs" c="orange">{t('forcedNoneWithTools')}</Text>
        ) : null}
      </Stack>
    </div>
  );
}
