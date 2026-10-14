'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Anchor, Group, Stack } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import PageContainer from '@/components/common/ui/PageContainer';
import { useTranslations } from '@/lib/i18n';
import { iamHref, principalHref } from '../links';
import type { PrincipalTarget } from './client';
import { isPrincipalType } from './client';
import { EDIT_KINDS, type EditKind } from './listState';
import NewTokenShell from './NewTokenShell';
import { PrincipalDetailContent, type DetailContext } from './PrincipalDetail';
import { usePeopleActions } from './usePeopleActions';
import { usePeopleCapabilities } from './usePeopleCapabilities';
import { replaceUrlParams } from './urlState';

const NS = 'iamPrincipals';

/** The list a principal of this kind lives in. */
export const listHref = (type: PrincipalTarget['type']): string => iamHref('principals', { principalType: type });

interface PrincipalDetailPageProps {
  type: string;
  id: string;
  canManage: boolean;
}

/**
 * One person, group or token on a page of its own (`/dashboard/iam/principals/<type>/<id>`).
 * What used to be a side drawer of the list: the same sections and actions, with
 * a stable address. The open form is mirrored into `?edit=`; a principal opened
 * from here (the owner of a token, a group of a person) is another page, so the
 * browser's back button walks the same path the person took.
 */
export default function PrincipalDetailPage({ type, id, canManage }: PrincipalDetailPageProps) {
  const t = useTranslations(NS);
  const router = useRouter();
  const searchParams = useSearchParams();
  const caps = usePeopleCapabilities();

  // The content reloads itself after every change; nothing else on this page depends on it.
  const onChanged = useCallback(() => undefined, []);
  const actions = usePeopleActions({ onChanged });

  const editParam = searchParams?.get('edit') ?? null;
  const [edit, setEditState] = useState<EditKind | null>(
    (EDIT_KINDS as readonly string[]).includes(editParam ?? '') ? (editParam as EditKind) : null,
  );
  const setEdit = useCallback((kind: EditKind | null) => {
    setEditState(kind);
    replaceUrlParams({ edit: kind });
  }, []);

  const [tokenOwner, setTokenOwner] = useState<{ id: string; label: string } | null>(null);

  const typed = isPrincipalType(type) ? type : null;
  const leave = useCallback(() => router.push(listHref(typed ?? 'user')), [router, typed]);

  const context = useMemo<DetailContext>(
    () => ({
      me: caps.me,
      assignableRoles: caps.assignableRoles,
      canMintForOthers: caps.tokensManageOthers,
      actions,
      edit,
      onEdit: setEdit,
      onChanged,
      onNewToken: setTokenOwner,
      onGone: leave,
    }),
    [caps.me, caps.assignableRoles, caps.tokensManageOthers, actions, edit, setEdit, onChanged, leave],
  );

  const open = useCallback((next: PrincipalTarget) => router.push(principalHref(next.type, next.id)), [router]);

  if (!typed) {
    return (
      <PageContainer>
        <Anchor component={Link} href={iamHref('principals')} size="sm">
          {t('page.backToList')}
        </Anchor>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Stack gap="md" maw={1100} data-testid="principal-detail-page">
        <Group>
          <Anchor component={Link} href={listHref(typed)} size="sm" data-testid="principal-back-to-list">
            <Group gap={4} wrap="nowrap">
              <IconArrowLeft size={14} />
              {t(`page.backTo.${typed}`)}
            </Group>
          </Anchor>
        </Group>
        <PrincipalDetailContent
          key={`${typed}:${id}`}
          target={{ type: typed, id }}
          canManage={canManage}
          context={context}
          onOpen={open}
        />
      </Stack>
      <NewTokenShell
        open={tokenOwner !== null}
        onClose={() => setTokenOwner(null)}
        onCreated={onChanged}
        owner={tokenOwner}
        me={caps.me ? { userId: caps.me.userId } : null}
        canMintForOthers={caps.tokensManageOthers}
      />
    </PageContainer>
  );
}
