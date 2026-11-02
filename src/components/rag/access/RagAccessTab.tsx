'use client';

/**
 * The Access tab of a knowledge base (Knowledge Engine admins only), top to bottom:
 *
 *  1. the two switches: enforce document permissions, and the admin exception;
 *  2. the default access (the root's list, which everything without permissions of its own follows);
 *  3. how many folders and documents have permissions of their own, come from a connector, or are readable by nobody;
 *  4. "Check access": why can (not) this person read this document;
 *  5. the connectors that bring permissions in, and how many of their people match console people.
 *
 * Each card loads on its own and shows its own loading, empty and failed states; all of them load again when the
 * page bumps `refreshKey` (permissions were saved in the editor, which the page owns).
 */

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button, Group, Paper, SimpleGrid, Stack, Switch, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconExternalLink, IconFile, IconFolder, IconPlugConnected, IconShieldLock, IconUsers } from '@tabler/icons-react';
import { useConfirm } from '@/components/common/confirm';
import { EVERYONE_PRINCIPAL } from '@/lib/services/rag/access/principals';
import { AccessCard, CardError, CardSkeleton } from './AccessCard';
import { PrincipalIcon } from './PrincipalIcon';
import { RagCheckAccess } from './RagCheckAccess';
import type { RagPermissionTarget } from './RagPermissionEditor';
import { entryPhrase, folderPathText, formatCount, kindOf, keepsPermissionsText } from './principalDisplay';
import { ACCESS_TEXT } from './ragAccessText';
import {
  ragAccessApi,
  ragErrorMessage,
  type RagAccessClosedItem,
  type RagAccessDirectoryUse,
  type RagAccessSummaryView,
  type RagAclEntryView,
} from './ragAccessApi';
import { errorStatus, useAccessLoad, useRagAudience, useRagFolderIndex } from './useRagAccessData';

export interface RagAccessTabProps {
  moduleKey: string;
  moduleName: string;
  /** `module.access` as loaded (absent/null = off). */
  access: { enabled: boolean; adminBypass?: boolean } | null | undefined;
  /** Bumped by the page after permissions changed elsewhere: the tab reloads its views. */
  refreshKey: number;
  /** After the switches changed the module: the page reloads it. */
  onModuleChanged: () => void;
  /** Opens the permission editor (the page owns it). */
  onEditPermissions: (target: RagPermissionTarget) => void;
  /** Opens the Documents tab at a folder (null = top level). */
  onShowFolder: (folderId: string | null) => void;
}

/** Default-access entries named before "and N more". */
const DEFAULT_ENTRIES_SHOWN = 6;

type AccessSetting = { enabled: boolean; adminBypass?: boolean };

export function RagAccessTab({
  moduleKey,
  moduleName,
  access,
  refreshKey,
  onModuleChanged,
  onEditPermissions,
  onShowFolder,
}: RagAccessTabProps) {
  const { confirm } = useConfirm();
  const dataKey = `${moduleKey}:${refreshKey}`;
  const summary = useAccessLoad((signal) => ragAccessApi.summary(moduleKey, signal), dataKey);
  const rootAcl = useAccessLoad((signal) => ragAccessApi.getAcl(moduleKey, 'module', signal), dataKey);

  // What the switches were last saved to, until the page's module has reloaded and says the same.
  const [saved, setSaved] = useState<AccessSetting | null>(null);
  const [saving, setSaving] = useState<'enforce' | 'bypass' | null>(null);
  useEffect(() => {
    setSaved(null);
  }, [access?.enabled, access?.adminBypass]);

  const setting: AccessSetting = saved ?? {
    enabled: access?.enabled === true,
    ...(access?.adminBypass === undefined ? {} : { adminBypass: access.adminBypass }),
  };
  const bypassOn = setting.adminBypass !== false;

  async function apply(next: AccessSetting, which: 'enforce' | 'bypass') {
    setSaving(which);
    try {
      await ragAccessApi.setAccess(moduleKey, next);
      setSaved(next);
      onModuleChanged();
    } catch (error) {
      notifications.show({ color: 'red', title: ACCESS_TEXT.changeFailed, message: ragErrorMessage(error) });
    } finally {
      setSaving(null);
    }
  }

  async function changeEnforcement(next: boolean) {
    const confirmed = await confirm({
      title: next ? ACCESS_TEXT.enforceOnTitle : ACCESS_TEXT.enforceOffTitle,
      message: next ? ACCESS_TEXT.enforceOnMessage : ACCESS_TEXT.enforceOffMessage,
      confirmLabel: next ? ACCESS_TEXT.enforceOnConfirm : ACCESS_TEXT.enforceOffConfirm,
      tone: 'warning',
    });
    if (!confirmed) return;
    // The admin exception is kept as stored: saving the setting whole must not put it back to its default.
    await apply({ ...setting, enabled: next }, 'enforce');
  }

  async function changeBypass(next: boolean) {
    if (!next) {
      const confirmed = await confirm({
        title: ACCESS_TEXT.bypassOffTitle,
        message: ACCESS_TEXT.bypassOffMessage,
        confirmLabel: ACCESS_TEXT.bypassOffConfirm,
        tone: 'warning',
      });
      if (!confirmed) return;
    }
    await apply({ enabled: setting.enabled, adminBypass: next }, 'bypass');
  }

  return (
    <Stack gap="md">
      <AccessCard icon={<IconShieldLock size={18} />} title="Document permissions">
        <Stack gap="lg">
          <Switch
            checked={setting.enabled}
            disabled={saving !== null}
            onChange={(event) => void changeEnforcement(event.currentTarget.checked)}
            label={ACCESS_TEXT.enforceLabel}
            description={ACCESS_TEXT.enforceDescription}
          />
          <Switch
            checked={bypassOn}
            disabled={saving !== null}
            onChange={(event) => void changeBypass(event.currentTarget.checked)}
            label={ACCESS_TEXT.bypassLabel}
            description={ACCESS_TEXT.bypassDescription}
          />
        </Stack>
      </AccessCard>

      <DefaultAccessCard
        moduleKey={moduleKey}
        entries={rootAcl.data?.entries ?? null}
        loading={rootAcl.loading && !rootAcl.data}
        error={rootAcl.data ? null : rootAcl.error}
        onRetry={rootAcl.reload}
        onEdit={() => onEditPermissions({ node: 'module', name: moduleName })}
      />

      <SummaryTiles
        moduleKey={moduleKey}
        refreshKey={refreshKey}
        summary={summary.data}
        loading={summary.loading && !summary.data}
        error={summary.data ? null : summary.error}
        onRetry={summary.reload}
        bypassOn={bypassOn}
        onShowFolder={onShowFolder}
      />

      <RagCheckAccess moduleKey={moduleKey} refreshKey={refreshKey} />

      <ConnectorsCard
        directories={summary.data?.directories ?? null}
        loading={summary.loading && !summary.data}
        error={summary.data ? null : summary.error}
        onRetry={summary.reload}
        refreshKey={refreshKey}
      />
    </Stack>
  );
}

/* ── 2. Default access ───────────────────────────────────────────────────── */

function DefaultAccessCard({
  moduleKey,
  entries,
  loading,
  error,
  onRetry,
  onEdit,
}: {
  moduleKey: string;
  entries: RagAclEntryView[] | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const shown = (entries ?? []).slice(0, DEFAULT_ENTRIES_SHOWN);
  const { audience } = useRagAudience(moduleKey, shown.map((entry) => entry.principal));
  const more = (entries?.length ?? 0) - shown.length;

  return (
    <AccessCard
      icon={<IconUsers size={18} />}
      title="Default access"
      actions={<Button size="xs" variant="light" onClick={onEdit}>Edit…</Button>}
    >
      <Text size="sm" c="dimmed" mb="xs">{ACCESS_TEXT.defaultAccessIntro}</Text>
      {loading ? (
        <CardSkeleton lines={1} />
      ) : error ? (
        <CardError message={ACCESS_TEXT.defaultAccessLoadFailed} detail={error.message} onRetry={onRetry} />
      ) : !entries || entries.length === 0 ? (
        <Group gap="sm" wrap="nowrap">
          <PrincipalIcon kind="everyone" />
          <Text size="sm" fw={500}>{ACCESS_TEXT.everyoneDefault}</Text>
        </Group>
      ) : (
        <Stack gap={6}>
          <div role="list" aria-label="Default access">
            {shown.map((entry) => (
              <Group key={entry.principal} role="listitem" gap="sm" wrap="nowrap" py={3}>
                <PrincipalIcon kind={kindOf(entry.principal)} size={24} />
                <Text size="sm" fw={500}>
                  {entry.principal === EVERYONE_PRINCIPAL
                    ? ACCESS_TEXT.everyoneDefault
                    : entryPhrase(entry.principal, entry.label, audience[entry.principal])}
                </Text>
              </Group>
            ))}
          </div>
          {more > 0 ? <Text size="xs" c="dimmed">and {formatCount(more)} more</Text> : null}
        </Stack>
      )}
    </AccessCard>
  );
}

/* ── 3. Summary tiles ────────────────────────────────────────────────────── */

function Tile({ value, label, hint, action }: { value: number; label: string; hint?: string; action?: ReactNode }) {
  return (
    <Paper withBorder radius="lg" p="md">
      <Text fw={700} fz={28} lh={1.1}>{formatCount(value)}</Text>
      <Text size="sm" c="dimmed" mt={4}>{label}</Text>
      {hint ? <Text size="xs" c="dimmed">{hint}</Text> : null}
      {action}
    </Paper>
  );
}

function SummaryTiles({
  moduleKey,
  refreshKey,
  summary,
  loading,
  error,
  onRetry,
  bypassOn,
  onShowFolder,
}: {
  moduleKey: string;
  refreshKey: number;
  summary: RagAccessSummaryView | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  bypassOn: boolean;
  onShowFolder: (folderId: string | null) => void;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const folders = useRagFolderIndex(moduleKey, showClosed, refreshKey);

  if (loading) {
    return (
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} aria-busy="true" aria-label="Loading the summary">
        {[0, 1, 2, 3].map((index) => <Paper key={index} withBorder radius="lg" p="md"><CardSkeleton lines={2} /></Paper>)}
      </SimpleGrid>
    );
  }
  if (error || !summary) {
    return (
      <Paper withBorder radius="lg" p="lg">
        <CardError message={ACCESS_TEXT.summaryLoadFailed} detail={error?.message} onRetry={onRetry} />
      </Paper>
    );
  }

  const closedTotal = summary.folders.closed + summary.documents.closed;
  const syncedFolders = summary.folders.synced;

  const where = (item: RagAccessClosedItem): string => {
    if (item.type === 'folder') return folderPathText(item.path ?? item.name);
    if (!item.folderId) return 'At the top level';
    const path = folders.byId.get(item.folderId)?.path;
    return path ? `In ${folderPathText(path)}` : 'In a folder';
  };

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <Tile value={summary.folders.own} label="Folders with own permissions" />
        <Tile value={summary.documents.own} label="Documents with own permissions" />
        <Tile
          value={summary.documents.synced}
          label="Synced from connectors"
          hint={syncedFolders > 0 ? `plus ${syncedFolders === 1 ? '1 folder' : `${formatCount(syncedFolders)} folders`}` : undefined}
        />
        <Tile
          value={closedTotal}
          label="Readable by nobody"
          action={summary.closed.length > 0 ? (
            <Button size="xs" variant="subtle" mt={6} px={0} onClick={() => setShowClosed((open) => !open)} aria-expanded={showClosed}>
              {showClosed ? 'Hide' : 'Show'}
            </Button>
          ) : undefined}
        />
      </SimpleGrid>

      {showClosed ? (
        <Paper component="section" aria-label="Readable by nobody" withBorder radius="lg" p="lg">
          <Text fw={600}>Readable by nobody</Text>
          <Text size="sm" c="dimmed" mb="sm">{bypassOn ? ACCESS_TEXT.closedNoteBypassOn : ACCESS_TEXT.closedNoteBypassOff}</Text>
          <div role="list" aria-label="Closed folders and documents">
            {summary.closed.map((item) => (
              <Group key={`${item.type}:${item.id}`} role="listitem" justify="space-between" wrap="nowrap" gap="sm" py={6}>
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  {item.type === 'folder' ? <IconFolder size={18} /> : <IconFile size={18} />}
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={500} truncate>{item.name}</Text>
                    <Text size="xs" c="dimmed" truncate>{where(item)}</Text>
                  </div>
                </Group>
                <Button
                  size="xs"
                  variant="light"
                  aria-label={`Open ${item.name}`}
                  onClick={() => onShowFolder(item.type === 'folder' ? item.id : item.folderId ?? null)}
                >
                  Open
                </Button>
              </Group>
            ))}
          </div>
          {!summary.closedComplete ? <Text size="xs" c="dimmed" mt="xs">{ACCESS_TEXT.closedTruncated}</Text> : null}
        </Paper>
      ) : null}
    </Stack>
  );
}

/* ── 5. Permissions from connectors ──────────────────────────────────────── */

function ConnectorsCard({
  directories,
  loading,
  error,
  onRetry,
  refreshKey,
}: {
  directories: RagAccessDirectoryUse[] | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  refreshKey: number;
}) {
  return (
    <AccessCard icon={<IconPlugConnected size={18} />} title="Permissions from connectors" color="grape">
      {loading ? (
        <CardSkeleton lines={2} />
      ) : error || !directories ? (
        <CardError message={ACCESS_TEXT.connectorsLoadFailed} detail={error?.message} onRetry={onRetry} />
      ) : directories.length === 0 ? (
        <Text size="sm" c="dimmed">{ACCESS_TEXT.connectorsNone}</Text>
      ) : (
        <Stack gap="md">
          {directories.map((directory) => <DirectoryRow key={directory.key} directory={directory} refreshKey={refreshKey} />)}
        </Stack>
      )}
    </AccessCard>
  );
}

function DirectoryRow({ directory, refreshKey }: { directory: RagAccessDirectoryUse; refreshKey: number }) {
  // One user is enough: the answer carries the counts of the whole directory.
  const people = useAccessLoad(
    (signal) => ragAccessApi.directoryPeople(directory.key, { limit: 1 }, signal),
    `${directory.key}:${refreshKey}`,
  );
  const counts = people.data?.summary;
  // Matching people needs Knowledge Engine admin rights for the whole workspace: without them the line is left out.
  const forbidden = errorStatus(people.error) === 403;

  return (
    <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
      <div style={{ minWidth: 0 }}>
        <Text size="sm" fw={500}>
          {directory.label} · {keepsPermissionsText(directory.documents, directory.folders)}
        </Text>
        {counts ? (
          <Text size="sm" c="dimmed">
            {formatCount(counts.matchedUsers)} of {formatCount(counts.directoryUsers)} people matched
          </Text>
        ) : people.error && !forbidden ? (
          <Text size="sm" c="dimmed">The people of this directory could not be counted.</Text>
        ) : !people.error ? (
          <Text size="sm" c="dimmed">Counting people…</Text>
        ) : null}
      </div>
      {directory.connectorId ? (
        <Button
          component={Link}
          href={`/dashboard/connectors/${encodeURIComponent(directory.connectorId)}?tab=people`}
          size="xs"
          variant="light"
          rightSection={<IconExternalLink size={12} />}
        >
          Open connector
        </Button>
      ) : null}
    </Group>
  );
}
