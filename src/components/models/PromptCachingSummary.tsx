'use client';

import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { resolvePromptCaching } from '@/lib/services/models/promptCaching';

interface PromptCachingSummaryProps {
  settings: Record<string, unknown> | undefined;
  driver?: string;
  modelId?: string;
  /** Opens the model's edit overlay at its Prompt caching section. Omitted when the model has no such editor. */
  onEdit?: () => void;
}

/** The model page's statement of whether this model's prompts are cached, and what is cached. */
export default function PromptCachingSummary({ settings, driver, modelId, onEdit }: PromptCachingSummaryProps) {
  const t = useTranslations('modelPromptCaching');
  const raw = settings?.promptCaching;
  const resolved = resolvePromptCaching(
    driver,
    modelId,
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { enabled?: boolean; strategy?: 'auto' | 'static' }) : undefined,
  );
  const nova = resolved.family === 'nova';

  return (
    <div className="ds-card ds-card-pad-lg" data-testid="model-prompt-caching-summary">
      <div className="ds-row-between" style={{ marginBottom: 12 }}>
        <div className="ds-h4">{t('title')}</div>
        {onEdit && resolved.support === 'explicit' ? (
          <Button
            variant="subtle"
            size="xs"
            leftSection={<IconPencil size={12} stroke={1.7} />}
            onClick={onEdit}
            data-testid="model-prompt-caching-edit"
          >
            {t('detail.edit')}
          </Button>
        ) : null}
      </div>
      <Stack gap="xs">
        {resolved.support === 'explicit' ? (
          <>
            <div className="ds-row-between" style={{ fontSize: 12.5 }}>
              <span className="ds-muted">{t('detail.effective')}</span>
              <Group gap={6}>
                <Badge variant="light" radius="sm" color={resolved.enabled ? 'teal' : 'gray'}>
                  {resolved.enabled ? t('detail.on') : t('detail.off')}
                </Badge>
                {resolved.enabled ? (
                  <Badge variant="light" color="gray" radius="sm">
                    {resolved.strategy === 'static' ? (nova ? t('what.staticNova') : t('what.static')) : t('what.auto')}
                  </Badge>
                ) : null}
              </Group>
            </div>
            <Text size="xs" c="dimmed">{t('detail.fiveMinutes')}</Text>
          </>
        ) : (
          <Text size="xs" c="dimmed">
            {resolved.support === 'automatic'
              ? t('automatic.text')
              : driver === 'bedrock' ? t('none.bedrock') : t('none.other')}
          </Text>
        )}
      </Stack>
    </div>
  );
}
