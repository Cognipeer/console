'use client';

import { useMemo } from 'react';
import { Alert, Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { IconAlertCircle, IconAlertTriangle, IconNetwork, IconPlus } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { parseAllowlistText, type TokenPolicyView } from './tokenModel';

export interface IpAllowlistFieldProps {
  /** One range per line (commas, semicolons and spaces separate entries too). */
  text: string;
  onChange: (text: string) => void;
  policy: TokenPolicyView;
  disabled?: boolean;
}

/**
 * The IP allowlist of a token: a CIDR list typed or pasted one range per line.
 * Validated while typing with the very code the server enforces with. The
 * address the server sees for this browser is offered as a one-click addition,
 * which is also how a wrong proxy setup shows up (a load balancer address
 * instead of the office address).
 */
export default function IpAllowlistField({ text, onChange, policy, disabled }: IpAllowlistFieldProps) {
  const t = useTranslations('iamTokens');
  const parsed = useMemo(() => parseAllowlistText(text, policy.maxIpRanges), [text, policy.maxIpRanges]);
  const mine = policy.clientIp;
  const mineListed = mine ? parsed.ranges.some((range) => range === `${mine}/32` || range === `${mine}/128`) : false;

  const addMine = () => {
    if (!mine) return;
    const trimmed = text.replace(/\s+$/, '');
    onChange(trimmed ? `${trimmed}\n${mine}` : mine);
  };

  return (
    <Stack gap="xs">
      <Textarea
        value={text}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={t('network.placeholder')}
        autosize
        minRows={3}
        maxRows={10}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        error={parsed.issues.length > 0 || parsed.tooMany}
        aria-label={t('network.label')}
        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
      />

      {parsed.issues.length > 0 ? (
        <Alert color="red" variant="light" p="xs" icon={<IconAlertCircle size={14} />}>
          <Stack gap={2}>
            {parsed.issues.slice(0, 5).map((issue) => (
              <Text key={`${issue.position}:${issue.value}`} size="xs">
                {t('network.issueLine', {
                  position: issue.position,
                  value: issue.value,
                  reason: t(`network.issue.${issue.reason}`),
                })}
              </Text>
            ))}
            {parsed.issues.length > 5 ? (
              <Text size="xs">{t('network.moreIssues', { count: parsed.issues.length - 5 })}</Text>
            ) : null}
          </Stack>
        </Alert>
      ) : null}

      {parsed.tooMany ? (
        <Alert color="red" variant="light" p="xs" icon={<IconAlertCircle size={14} />}>
          <Text size="xs">{t('network.tooMany', { max: policy.maxIpRanges })}</Text>
        </Alert>
      ) : null}

      {policy.trustsForwardedHeaders && parsed.ranges.length > 0 ? (
        <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={14} />}>
          <Text size="xs">{t('network.openProxy')}</Text>
        </Alert>
      ) : null}

      <Group justify="space-between" gap="xs" wrap="wrap">
        <Group gap={6} wrap="nowrap">
          <IconNetwork size={14} style={{ opacity: 0.6 }} />
          <Text size="xs" c="dimmed">
            {parsed.ranges.length === 0
              ? t('network.unrestricted')
              : t(parsed.ranges.length === 1 ? 'network.countOne' : 'network.countMany', { count: parsed.ranges.length })}
          </Text>
        </Group>
        {mine && !mineListed && !disabled ? (
          <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={addMine}>
            {t('network.addMine', { ip: mine })}
          </Button>
        ) : null}
      </Group>

      {mine ? (
        <Text size="xs" c="dimmed">
          {t('network.seenAs', { ip: mine })}
        </Text>
      ) : null}
    </Stack>
  );
}
