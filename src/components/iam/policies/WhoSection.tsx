'use client';

import { Stack, Switch, Text } from '@mantine/core';
import { IconUser, IconUsers } from '@tabler/icons-react';
import { SourceCard, SourceToggle } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import PrincipalMultiSelect from '../pickers/PrincipalMultiSelect';
import type { PolicyDraft } from './specModel';

interface WhoSectionProps {
  draft: PolicyDraft;
  patch: (change: Partial<PolicyDraft>) => void;
  /** Show the "pick at least one" error. */
  showError?: boolean;
}

/** "Who does it apply to": everyone, or any mix of all users, all tokens, groups, users and tokens. */
export default function WhoSection({ draft, patch, showError }: WhoSectionProps) {
  const t = useTranslations('iamCenter');

  return (
    <Stack gap="md">
      <SourceToggle>
        <SourceCard
          selected={draft.whoAny}
          onClick={() => patch({ whoAny: true })}
          icon={<IconUsers size={16} />}
          title={t('who.everyone')}
          description={t('who.everyoneHelp')}
        />
        <SourceCard
          selected={!draft.whoAny}
          onClick={() => patch({ whoAny: false })}
          icon={<IconUser size={16} />}
          title={t('who.selected')}
          description={t('who.selectedHelp')}
        />
      </SourceToggle>

      {!draft.whoAny ? (
        <Stack gap="sm">
          <Switch
            label={t('who.anyUser')}
            description={t('who.anyUserHelp')}
            checked={draft.anyUser}
            onChange={(e) => patch({ anyUser: e.currentTarget.checked })}
          />
          <Switch
            label={t('who.anyToken')}
            description={t('who.anyTokenHelp')}
            checked={draft.anyToken}
            onChange={(e) => patch({ anyToken: e.currentTarget.checked })}
          />
          <PrincipalMultiSelect
            type="group"
            label={t('who.groups')}
            placeholder={t('who.groupsPlaceholder')}
            value={draft.groups}
            onChange={(groups) => patch({ groups })}
          />
          <PrincipalMultiSelect
            type="user"
            label={t('who.users')}
            placeholder={t('who.usersPlaceholder')}
            value={draft.users}
            onChange={(users) => patch({ users })}
          />
          <PrincipalMultiSelect
            type="token"
            label={t('who.tokens')}
            placeholder={t('who.tokensPlaceholder')}
            value={draft.tokens}
            onChange={(tokens) => patch({ tokens })}
          />
          <Text size="xs" c="dimmed">
            {t('who.tokenNote')}
          </Text>
          {showError ? (
            <Text size="xs" c="red">
              {t('validation.who')}
            </Text>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
