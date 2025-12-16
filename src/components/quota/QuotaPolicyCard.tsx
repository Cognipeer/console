'use client';

import { Card, Group, Text, Badge, ActionIcon, Stack, Tooltip, Box, ThemeIcon } from '@mantine/core';
import { 
  IconEdit, 
  IconTrash, 
  IconUser, 
  IconKey, 
  IconBuildingBank, 
  IconServer, 
  IconPackage,
  IconWorld,
  IconMessageChatbot,
  IconVectorBezier2,
  IconDatabase,
  IconFiles,
  IconActivity,
} from '@tabler/icons-react';
import type { IQuotaPolicy } from '@/lib/database/provider.interface';
import type { QuotaDomain, QuotaScope } from '@/lib/quota/types';
import { useTranslations } from '@/lib/i18n';

interface QuotaPolicyCardProps {
  policy: IQuotaPolicy;
  onEdit?: (policy: IQuotaPolicy) => void;
  onDelete?: (policy: IQuotaPolicy) => void;
  showDomain?: boolean;
  compact?: boolean;
}

const SCOPE_ICONS: Record<QuotaScope, React.ReactNode> = {
  tenant: <IconBuildingBank size={14} />,
  user: <IconUser size={14} />,
  token: <IconKey size={14} />,
  resource: <IconPackage size={14} />,
  provider: <IconServer size={14} />,
};

const DOMAIN_ICONS: Record<QuotaDomain, React.FC<{ size?: number }>> = {
  global: IconWorld,
  llm: IconMessageChatbot,
  embedding: IconVectorBezier2,
  vector: IconDatabase,
  file: IconFiles,
  tracing: IconActivity,
};

export function QuotaPolicyCard({ policy, onEdit, onDelete, showDomain = true, compact = false }: QuotaPolicyCardProps) {
  const t = useTranslations('settings.quotaSection.card');
  const tScopes = useTranslations('settings.quotaSection.scopes');
  const tDomains = useTranslations('settings.quotaSection.domains');
  
  const { scope, domain, limits } = policy;
  // scopeId is in QuotaPolicy but not in IQuotaPolicy, handle both
  const scopeId = (policy as { scopeId?: string }).scopeId;
  
  const formatLimit = (value: number | undefined): string => {
    if (value === undefined || value === -1) return t('unlimited');
    return value.toLocaleString();
  };

  const renderLimitBadge = (label: string, value: number | undefined, color: string = 'blue') => {
    if (value === undefined) return null;
    return (
      <Badge variant="light" color={color} size="sm" key={label}>
        {label}: {formatLimit(value)}
      </Badge>
    );
  };

  const DomainIcon = DOMAIN_ICONS[domain];

  return (
    <Card withBorder padding={compact ? 'xs' : 'md'} radius="md">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          {showDomain && DomainIcon && (
            <ThemeIcon variant="light" size="md" color="grape">
              <DomainIcon size={16} />
            </ThemeIcon>
          )}
          <Stack gap={2}>
            <Group gap="xs">
              <Tooltip label={tScopes(scope)}>
                <Badge 
                  variant="filled" 
                  size="xs" 
                  leftSection={SCOPE_ICONS[scope]}
                  color={scope === 'tenant' ? 'blue' : scope === 'user' ? 'green' : scope === 'token' ? 'orange' : 'gray'}
                >
                  {tScopes(scope)}
                </Badge>
              </Tooltip>
              {showDomain && (
                <Badge variant="outline" size="xs" color="grape">
                  {tDomains(domain)}
                </Badge>
              )}
            </Group>
            {scopeId && (
              <Text size="xs" c="dimmed" lineClamp={1}>
                {scopeId}
              </Text>
            )}
          </Stack>
        </Group>

        <Group gap="xs">
          {onEdit && (
            <Tooltip label={t('edit')}>
              <ActionIcon variant="subtle" size="sm" onClick={() => onEdit(policy)}>
                <IconEdit size={16} />
              </ActionIcon>
            </Tooltip>
          )}
          {onDelete && (
            <Tooltip label={t('delete')}>
              <ActionIcon variant="subtle" size="sm" color="red" onClick={() => onDelete(policy)}>
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>

      {!compact && (
        <Box mt="sm">
          {/* Rate Limits */}
          {limits.rateLimit?.requests && (
            <Stack gap={4} mb="xs">
              <Text size="xs" fw={500} c="dimmed">{t('rateRequests')}</Text>
              <Group gap={4}>
                {renderLimitBadge(t('rpm'), limits.rateLimit.requests.perMinute, 'teal')}
                {renderLimitBadge(t('rph'), limits.rateLimit.requests.perHour, 'cyan')}
                {renderLimitBadge(t('rpd'), limits.rateLimit.requests.perDay, 'blue')}
              </Group>
            </Stack>
          )}

          {limits.rateLimit?.tokens && (
            <Stack gap={4} mb="xs">
              <Text size="xs" fw={500} c="dimmed">{t('rateTokens')}</Text>
              <Group gap={4}>
                {renderLimitBadge(t('tpm'), limits.rateLimit.tokens.perMinute, 'violet')}
                {renderLimitBadge(t('tpd'), limits.rateLimit.tokens.perDay, 'grape')}
              </Group>
            </Stack>
          )}

          {/* Quotas */}
          {limits.quotas && (
            <Stack gap={4} mb="xs">
              <Text size="xs" fw={500} c="dimmed">{t('quotas')}</Text>
              <Group gap={4} wrap="wrap">
                {renderLimitBadge(t('model'), limits.quotas.maxModels, 'violet')}
                {renderLimitBadge(t('vectorIndex'), limits.quotas.maxVectorIndexes, 'grape')}
                {renderLimitBadge(t('apiToken'), limits.quotas.maxApiTokens, 'pink')}
                {renderLimitBadge(t('user'), limits.quotas.maxUsers, 'indigo')}
                {renderLimitBadge(t('agent'), limits.quotas.maxAgents, 'blue')}
                {renderLimitBadge(t('fileBucket'), limits.quotas.maxFileBuckets, 'cyan')}
                {renderLimitBadge(t('tracingSession'), limits.quotas.maxTracingSessions, 'teal')}
                {renderLimitBadge(t('totalFiles'), limits.quotas.maxFilesTotal, 'green')}
              </Group>
            </Stack>
          )}

          {/* Per Request Limits */}
          {limits.perRequest && (
            <Stack gap={4} mb="xs">
              <Text size="xs" fw={500} c="dimmed">{t('perRequest')}</Text>
              <Group gap={4} wrap="wrap">
                {renderLimitBadge(t('maxInputToken'), limits.perRequest.maxInputTokens, 'orange')}
                {renderLimitBadge(t('maxOutputToken'), limits.perRequest.maxOutputTokens, 'yellow')}
                {renderLimitBadge(t('maxResults'), limits.perRequest.maxQueryResults, 'lime')}
                {limits.perRequest.maxFileSize !== undefined && (
                  <Badge variant="light" color="green" size="sm">
                    {t('maxFileSize')}: {Math.round(limits.perRequest.maxFileSize / 1024 / 1024)}MB
                  </Badge>
                )}
              </Group>
            </Stack>
          )}

          {/* Budget Limits */}
          {limits.budget && (
            <Stack gap={4}>
              <Text size="xs" fw={500} c="dimmed">{t('budget')}</Text>
              <Group gap={4}>
                {limits.budget.monthlySpendLimit !== undefined && (
                  <Badge variant="light" color="green" size="sm">
                    {t('monthly')}: ${limits.budget.monthlySpendLimit}
                  </Badge>
                )}
                {limits.budget.dailySpendLimit !== undefined && (
                  <Badge variant="light" color="lime" size="sm">
                    {t('daily')}: ${limits.budget.dailySpendLimit}
                  </Badge>
                )}
              </Group>
            </Stack>
          )}
        </Box>
      )}
    </Card>
  );
}
