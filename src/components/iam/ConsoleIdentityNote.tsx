'use client';

/**
 * What an upstream set up for Console identity needs to know (lib/iam/consoleIdentity.ts): one
 * sentence on the token, the issuer and key set URLs to hand to the team that runs it, and the
 * docs. Shown under the "Console identity" auth option of MCP servers and connected agents.
 */

import { ActionIcon, Anchor, CopyButton, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy, IconExternalLink } from '@tabler/icons-react';
import { useDocLink } from '@/components/docs/DocsDrawerContext';
import { useTranslations } from '@/lib/i18n';

export interface ConsoleIdentityIssuerInfo {
  issuer: string;
  jwksUri: string;
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const t = useTranslations('consoleIdentity');
  return (
    <Group gap="xs" wrap="nowrap" align="center">
      <Text size="xs" c="dimmed" w={110} style={{ flexShrink: 0 }}>{label}</Text>
      <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all', flex: 1 }}>{value}</Text>
      <CopyButton value={value} timeout={1500}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? t('copied') : t('copy')} withArrow>
            <ActionIcon
              variant="subtle"
              size="sm"
              color={copied ? 'teal' : 'gray'}
              onClick={copy}
              aria-label={copied ? t('copied') : t('copy')}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

export default function ConsoleIdentityNote({ info }: { info?: ConsoleIdentityIssuerInfo | null }) {
  const t = useTranslations('consoleIdentity');
  // A new tab: the note sits in the create/connect modals, where the docs panel would open behind the overlay.
  const docsLink = useDocLink('iam-console-identity', { newTab: true });
  return (
    <Stack gap={6}>
      <Text size="sm" c="dimmed">{t('summary')}</Text>
      {info ? (
        <>
          <Text size="xs" c="dimmed">{t('verifyHint')}</Text>
          <CopyLine label={t('issuer')} value={info.issuer} />
          <CopyLine label={t('jwks')} value={info.jwksUri} />
        </>
      ) : null}
      <Anchor {...docsLink} size="sm">
        <Group gap={4} wrap="nowrap" component="span">
          {t('learnMore')}
          <IconExternalLink size={14} />
        </Group>
      </Anchor>
    </Stack>
  );
}
