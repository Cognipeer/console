'use client';

import { useEffect, useMemo, useState } from 'react';
import { Select, Text } from '@mantine/core';
import { FormField, FormSection } from '@/components/common/ui/FormShell';
import PrincipalSelect from '@/components/iam/pickers/PrincipalSelect';
import type { PrincipalRef } from '@/components/iam/policies/specModel';
import CreateTokenModal from '@/components/settings/CreateTokenModal';
import { useTranslations } from '@/lib/i18n';
import { isAbortError } from './client';
import { directoryApi, type ProjectChoice } from './directoryApi';

interface NewTokenShellProps {
  open: boolean;
  onClose: () => void;
  /** After a token was minted and the secret screen was closed (refresh the list). */
  onCreated: () => void;
  /** Mint for this person (preset). Null = the signed-in person. */
  owner: { id: string; label: string } | null;
  /** The signed-in person. */
  me: { userId: string } | null;
  /** May the signed-in person mint tokens for other people? Otherwise the owner is locked to them. */
  canMintForOthers: boolean;
}

/** The body fields the owner/project lead section adds to `POST /api/tokens`. */
export function tokenExtraBody(
  owner: { id: string } | null,
  me: { userId: string } | null,
  projectId: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (owner && owner.id !== me?.userId) body.userId = owner.id;
  if (projectId) body.projectId = projectId;
  return body;
}

/**
 * A new API token, full screen: who it is for and in which project, then the
 * label, expiry and IP allowlist of the shared token form. The secret is shown
 * once, by that form.
 */
export default function NewTokenShell({ open, onClose, onCreated, owner, me, canMintForOthers }: NewTokenShellProps) {
  const t = useTranslations('iamDirectory');
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [picked, setPicked] = useState<PrincipalRef | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked(owner ? { id: owner.id, label: owner.label } : null);
    const controller = new AbortController();
    directoryApi
      .listProjects(controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setProjects(res.projects);
        setProjectId((current) => current ?? res.activeProjectId ?? res.projects[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) setProjects([]);
      });
    return () => controller.abort();
  }, [open, owner]);

  // Without the right to mint for others the owner is the signed-in person, whatever was preset.
  const meId = me?.userId ?? null;
  const ownerId = (canMintForOthers ? picked?.id : null) ?? meId;
  const extraBody = useMemo(
    () => tokenExtraBody(ownerId ? { id: ownerId } : null, meId ? { userId: meId } : null, projectId),
    [ownerId, meId, projectId],
  );

  const lead = (
    <FormSection number={1} title={t('token.whoSection')} description={t('token.whoHint')} done={Boolean(projectId)}>
      {canMintForOthers ? (
        <PrincipalSelect
          type="user"
          label={t('token.owner')}
          description={t('token.ownerHint')}
          value={picked ?? (me ? { id: me.userId, label: t('token.me') } : null)}
          onChange={(next) => setPicked(next)}
        />
      ) : (
        <FormField label={t('token.owner')} hint={t('token.ownerLocked')}>
          <Text size="sm">{t('token.me')}</Text>
        </FormField>
      )}
      <FormField label={t('token.project')} required hint={t('token.projectHint')}>
        <Select
          value={projectId}
          onChange={setProjectId}
          data={projects.map((p) => ({ value: p.id, label: p.name }))}
          searchable
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
        />
      </FormField>
    </FormSection>
  );

  return (
    <CreateTokenModal
      opened={open}
      onClose={onClose}
      onSuccess={onCreated}
      createUrl="/api/tokens"
      extraBody={extraBody}
      leadSection={lead}
      extraValid={Boolean(projectId) && Boolean(ownerId)}
    />
  );
}
