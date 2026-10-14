'use client';

import { useEffect, useState } from 'react';
import { Alert, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInfoCircle, IconUsersGroup } from '@tabler/icons-react';
import FormShell, { FormField, FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { directoryApi } from './directoryApi';
import { describeError, FormError } from './errors';
import LocalGroupSelect, { type GroupChoice } from './LocalGroupSelect';

interface PersonMembershipProps {
  mode: 'person';
  person: { id: string; name: string; email: string; groupIds: string[] } | null;
  /** After the groups were added (refresh the drawer and the list). */
  onDone: () => void;
}

interface BulkMembershipProps {
  mode: 'bulk-add' | 'bulk-remove';
  /** How many people the action is for (the page's selection). */
  count: number;
  /** The chosen group; the bulk flow takes it from here (dry run, confirmation, run). */
  onPick: (group: GroupChoice) => void;
  onDone?: never;
  person?: never;
}

type MembershipShellProps = { open: boolean; onClose: () => void } & (PersonMembershipProps | BulkMembershipProps);

/**
 * Pick local groups. For one person: they join every group picked. For a page
 * selection (bulk): one group is picked and handed to the bulk flow, which
 * checks what would change before anything is written.
 */
export default function MembershipShell(props: MembershipShellProps) {
  const t = useTranslations('iamDirectory');
  const tCommon = useTranslations('common');
  const { open, onClose } = props;
  const [groups, setGroups] = useState<GroupChoice[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const personId = props.mode === 'person' ? props.person?.id : null;
  useEffect(() => {
    setGroups([]);
    setError(null);
    setSaving(false);
  }, [personId, props.mode, open]);

  const personProps = props.mode === 'person' ? props : null;
  const bulkProps = props.mode !== 'person' ? props : null;
  const person = personProps?.person ?? null;
  const bulk = bulkProps !== null;
  if (!bulk && !person) return null;

  const addToGroups = async () => {
    if (!personProps || !personProps.person || groups.length === 0 || saving) return;
    const target = personProps.person;
    setSaving(true);
    setError(null);
    const failed: Array<{ group: GroupChoice; error: unknown }> = [];
    for (const group of groups) {
      try {
        await directoryApi.addGroupMember(group.id, target.id);
      } catch (err) {
        failed.push({ group, error: err });
      }
    }
    setSaving(false);
    const added = groups.length - failed.length;
    if (added > 0) {
      notifications.show({
        title: tCommon('success'),
        message: t('membership.added', { name: target.name || target.email, count: added }),
        color: 'green',
      });
      personProps.onDone();
    }
    if (failed.length === 0) {
      onClose();
      return;
    }
    // Keep the form open on the groups that failed, so the person can retry or give up.
    setGroups(failed.map((f) => f.group));
    setError(failed[0]?.error);
    notifications.show({
      title: t('membership.failedTitle'),
      message: failed.map((f) => `${f.group.name}: ${describeError(f.error, t)}`).join(' · '),
      color: 'red',
    });
  };

  const title = bulkProps
    ? t(bulkProps.mode === 'bulk-add' ? 'membership.bulkAddTitle' : 'membership.bulkRemoveTitle', { count: bulkProps.count })
    : t('membership.title', { name: person?.name || person?.email || '' });

  const primary = bulkProps
    ? {
        label: t('membership.continue'),
        disabled: groups.length === 0,
        onClick: () => {
          if (groups[0]) bulkProps.onPick(groups[0]);
        },
      }
    : {
        label: t('membership.add'),
        loading: saving,
        disabled: groups.length === 0,
        onClick: () => void addToGroups(),
      };

  const summary = (
    <SummaryGroup title={t('membership.summary')}>
      {bulkProps ? (
        <SummaryKV label={t('membership.people')} value={bulkProps.count} />
      ) : (
        <SummaryKV label={t('membership.person')} value={person?.name || person?.email} />
      )}
      <SummaryKV
        label={t('membership.groups')}
        value={groups.length === 0 ? <span className="ds-faint">—</span> : groups.map((g) => g.name).join(', ')}
      />
    </SummaryGroup>
  );

  return (
    <FormShell
      open={open}
      onClose={onClose}
      icon={<IconUsersGroup size={16} />}
      title={title}
      subtitle={t(bulk ? 'membership.bulkSubtitle' : 'membership.subtitle')}
      summary={summary}
      disableEscape={saving}
      primaryAction={primary}
      secondaryAction={{ label: t('common.cancel'), onClick: onClose, disabled: saving }}
    >
      <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
        {t('membership.note')}
      </Alert>
      <FormSection number={1} title={t('membership.section')} description={t(bulk ? 'membership.sectionBulkHint' : 'membership.sectionHint')} done={groups.length > 0}>
        <FormField label={t(bulk ? 'membership.groupOne' : 'membership.groupMany')} required>
          <LocalGroupSelect
            multiple={!bulk}
            value={groups}
            onChange={setGroups}
            exclude={person?.groupIds ?? []}
            disabled={saving}
          />
        </FormField>
        <Text size="xs" c="dimmed" mt="xs">
          {t('membership.directoryNote')}
        </Text>
      </FormSection>
      {error ? <FormError error={error} t={t} /> : null}
    </FormShell>
  );
}
