'use client';

/**
 * The one-step actions on people, groups and tokens that need a confirmation
 * and no form of their own: disable and enable, delete, copy an invitation link,
 * remove a membership, revoke a token, delete a group. The list's row menu and
 * the detail drawer share them, so both ask the same question, say the same
 * thing afterwards and report a failure the same way.
 *
 * Every action resolves `true` when it changed something (the caller then
 * refreshes) and `false` when it was cancelled or failed (a failure has already
 * been shown).
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useConfirm } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { directoryApi } from './directoryApi';
import { describeError, isKnownErrorCode, notifyError } from './errors';

export interface PersonRef {
  id: string;
  name: string;
  email?: string | null;
}

export interface GroupRefLite {
  id: string;
  name: string;
  /** Custom policies that name the group (shown in the delete confirmation). */
  policyCount?: number;
}

export interface TokenRefLite {
  id: string;
  label: string;
}

export interface PeopleActions {
  disable(person: PersonRef): Promise<boolean>;
  enable(person: PersonRef): Promise<boolean>;
  remove(person: PersonRef): Promise<boolean>;
  copyInvitationLink(person: PersonRef): Promise<boolean>;
  removeFromGroup(person: PersonRef, group: GroupRefLite): Promise<boolean>;
  /** Takes an orphan membership (a user that no longer exists) out of a group. */
  removeMembershipOf(userId: string, label: string, group: GroupRefLite): Promise<boolean>;
  revokeToken(token: TokenRefLite): Promise<boolean>;
  deleteGroup(group: GroupRefLite): Promise<boolean>;
  removeProjectMember(person: PersonRef, project: { id: string; name: string }): Promise<boolean>;
  removeGroupProject(group: GroupRefLite, project: { id: string; name: string }): Promise<boolean>;
}

interface Options {
  /** Called after something changed (refresh the list and the open drawer). */
  onChanged: () => void;
  /** Wraps an interaction that opens a dialog, so the drawer can ignore Escape meanwhile. */
  guard?: <T>(run: () => Promise<T>) => Promise<T>;
}

/** The "reason" box of the disable confirmation (the text lives outside the dialog's own state). */
export function ReasonField({ label, placeholder, onChange }: { label: string; placeholder: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <TextInput
      label={label}
      placeholder={placeholder}
      maxLength={500}
      value={value}
      onChange={(event) => {
        setValue(event.currentTarget.value);
        onChange(event.currentTarget.value);
      }}
    />
  );
}

const identity = <T,>(run: () => Promise<T>) => run();

export function usePeopleActions({ onChanged, guard = identity }: Options): PeopleActions {
  const t = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const tNotifications = useTranslations('notifications');
  const { confirmAction } = useConfirm();
  // Always the latest callbacks without re-creating every action on each render.
  const latest = useRef({ onChanged, guard });
  latest.current = { onChanged, guard };

  const ok = useCallback(
    (message: string) => notifications.show({ title: tCommon('success'), message, color: 'green' }),
    [tCommon],
  );
  const fail = useCallback(
    (error: unknown) => notifyError(error, t, tNotifications('errorTitle')),
    [t, tNotifications],
  );

  return useMemo<PeopleActions>(() => {
    /**
     * Confirm, then run; true when it ran. A failure inside the dialog stays in the dialog (confirmAction),
     * worded in the user's language.
     */
    const confirmThenRun = async (options: Parameters<typeof confirmAction>[0], done?: string): Promise<boolean> => {
      const run = options.action;
      const confirmed = await latest.current.guard(() =>
        confirmAction({
          ...options,
          action: async () => {
            try {
              await run();
            } catch (error) {
              throw new Error(describeError(error, t));
            }
          },
        }),
      );
      if (!confirmed) return false;
      if (done) ok(done);
      latest.current.onChanged();
      return true;
    };

    const who = (p: PersonRef) => p.name || p.email || p.id;

    return {
      async disable(person) {
        const reason = { current: '' };
        return confirmThenRun(
          {
            title: t('confirm.disable.title'),
            message: t('confirm.disable.body', { name: who(person) }),
            details: (
              <ReasonField
                label={t('confirm.disable.reasonLabel')}
                placeholder={t('confirm.disable.reasonPlaceholder')}
                onChange={(v) => {
                  reason.current = v;
                }}
              />
            ),
            tone: 'warning',
            confirmLabel: t('confirm.disable.confirm'),
            action: () => directoryApi.disableUser(person.id, reason.current.trim() || undefined),
          },
          t('toast.disabled', { name: who(person) }),
        );
      },

      async enable(person) {
        return confirmThenRun(
          {
            title: t('confirm.enable.title'),
            message: t('confirm.enable.body', { name: who(person) }),
            confirmLabel: t('confirm.enable.confirm'),
            action: () => directoryApi.enableUser(person.id),
          },
          t('toast.enabled', { name: who(person) }),
        );
      },

      async remove(person) {
        return confirmThenRun(
          {
            title: t('confirm.delete.title'),
            message: t('confirm.delete.body', { name: who(person) }),
            details: t('confirm.delete.cascade'),
            tone: 'danger',
            confirmLabel: t('confirm.delete.confirm'),
            // The address is the thing that is unmistakable; a service account may have none, then its name.
            requireTypedText: person.email || person.name || person.id,
            action: async () => {
              await directoryApi.deleteUser(person.id);
            },
          },
          t('toast.deleted', { name: who(person) }),
        );
      },

      async copyInvitationLink(person) {
        try {
          const url = await directoryApi.invitationLink(person.id);
          await navigator.clipboard.writeText(url);
          ok(t('toast.invitationLinkCopied'));
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },

      async removeFromGroup(person, group) {
        return confirmThenRun(
          {
            title: t('confirm.removeFromGroup.title'),
            message: t('confirm.removeFromGroup.body', { name: who(person), group: group.name }),
            tone: 'warning',
            confirmLabel: t('confirm.removeFromGroup.confirm'),
            action: async () => {
              await directoryApi.removeGroupMember(group.id, person.id);
            },
          },
          t('toast.removedFromGroup', { name: who(person), group: group.name }),
        );
      },

      async removeMembershipOf(userId, label, group) {
        return confirmThenRun(
          {
            title: t('confirm.removeFromGroup.title'),
            message: t('confirm.removeFromGroup.body', { name: label, group: group.name }),
            tone: 'warning',
            confirmLabel: t('confirm.removeFromGroup.confirm'),
            action: async () => {
              await directoryApi.removeGroupMember(group.id, userId);
            },
          },
          t('toast.removedFromGroup', { name: label, group: group.name }),
        );
      },

      async revokeToken(token) {
        return confirmThenRun(
          {
            title: t('confirm.revokeToken.title'),
            message: t('confirm.revokeToken.body', { label: token.label }),
            tone: 'danger',
            confirmLabel: t('confirm.revokeToken.confirm'),
            action: async () => {
              const result = await directoryApi.revokeTokens([token.id]);
              // A refusal inside a 200 (never upward, gone already) must not read as success.
              if (result.revoked === 0) {
                const code = result.results[0]?.code;
                throw new Error(code && isKnownErrorCode(code) ? t(`errors.${code}`) : t('errors.generic'));
              }
            },
          },
          t('toast.tokenRevoked', { label: token.label }),
        );
      },

      async deleteGroup(group) {
        return confirmThenRun(
          {
            title: t('confirm.deleteGroup.title'),
            message: t('confirm.deleteGroup.body', { name: group.name }),
            details:
              group.policyCount && group.policyCount > 0
                ? t('confirm.deleteGroup.policies', { count: group.policyCount })
                : undefined,
            tone: 'danger',
            confirmLabel: t('confirm.deleteGroup.confirm'),
            action: () => directoryApi.deleteGroup(group.id),
          },
          t('toast.groupDeleted', { name: group.name }),
        );
      },

      async removeProjectMember(person, project) {
        return confirmThenRun(
          {
            title: t('confirm.removeProject.title'),
            message: t('confirm.removeProject.body', { name: who(person), project: project.name }),
            tone: 'warning',
            confirmLabel: t('confirm.removeProject.confirm'),
            action: () => directoryApi.removeProjectMember(project.id, person.id),
          },
          t('toast.removedFromProject', { name: who(person), project: project.name }),
        );
      },

      async removeGroupProject(group, project) {
        return confirmThenRun(
          {
            title: t('confirm.removeGroupProject.title'),
            message: t('confirm.removeGroupProject.body', { group: group.name, project: project.name }),
            tone: 'warning',
            confirmLabel: t('confirm.removeGroupProject.confirm'),
            action: () => directoryApi.removeGroupProject(group.id, project.id),
          },
          t('toast.groupProjectRemoved', { group: group.name, project: project.name }),
        );
      },
    };
  }, [confirmAction, fail, ok, t]);
}
