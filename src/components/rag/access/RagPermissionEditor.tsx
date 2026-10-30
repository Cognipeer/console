'use client';

/**
 * Full-screen editor of one node's permissions: the knowledge base's default access (its root), a folder or a
 * document. Admins only; the page decides who gets it and opens it.
 *
 * A folder or document either INHERITS (it takes the permissions of its parent, and has no list of its own) or has
 * its OWN list, which replaces what it would inherit. The root always has its own list; none named there means
 * everyone who can open the knowledge base. An own list nobody is on closes the node: only the confirm before saving
 * one keeps that from happening by accident.
 */

import { useState } from 'react';
import { Alert, Button, Group, Paper, Radio, Skeleton, Stack, Tabs, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck, IconInfoCircle, IconLock, IconPlus, IconRefresh } from '@tabler/icons-react';
import { useConfirm } from '@/components/common/confirm';
import FormShell, { FormSection, SummaryGroup, SummaryKV } from '@/components/common/ui/FormShell';
import { EVERYONE_PRINCIPAL } from '@/lib/services/rag/access/principals';
import { PrincipalIcon } from './PrincipalIcon';
import { RagDirectoryPicker } from './RagDirectoryPicker';
import { RagEmailAdder, RagPrincipalPicker } from './RagPrincipalPicker';
import {
  MAX_ENTRIES,
  emptyListSentence,
  entryDetail,
  entryInput,
  entryTitle,
  formatCount,
  inheritedSentence,
  kindOf,
  listSentence,
  nodeSubtitle,
  sameEntries,
  startingEntries,
  toInput,
} from './principalDisplay';
import { ACCESS_TEXT } from './ragAccessText';
import {
  folderNode,
  isRagApiError,
  ragAccessApi,
  ragErrorMessage,
  type RagAccessAudienceItem,
  type RagAclEntryInput,
  type RagAclNodeKey,
  type RagFolderView,
  type RagNodeAclView,
} from './ragAccessApi';
import { useAccessLoad, useRagAudience } from './useRagAccessData';

export interface RagPermissionTarget {
  /** `module` = the knowledge base's default access (the root). */
  node: RagAclNodeKey;
  /** Folder or document name; the knowledge base name for the root. */
  name: string;
  /** The folder path of a folder, or of a document's folder; '' = top level. Not used for the root. */
  path?: string;
}

export interface RagPermissionEditorProps {
  moduleKey: string;
  moduleName: string;
  /** The node to edit; null = closed. */
  target: RagPermissionTarget | null;
  /** Access control is on (otherwise the stored permissions do not apply yet). */
  accessEnabled: boolean;
  /** The admin exception in force (absent in the module = true). */
  adminBypass: boolean;
  onClose: () => void;
  /** After a save: the node's permissions as stored. */
  onSaved: (acl: RagNodeAclView) => void;
}

export function RagPermissionEditor(props: RagPermissionEditorProps) {
  const { target } = props;
  if (!target) return null;
  // One mount per node: opening another node starts from that node's stored permissions, with nothing left over.
  return <EditorBody key={`${props.moduleKey}|${target.node}`} {...props} target={target} />;
}

/* ── Where a node reads from ─────────────────────────────────────────────── */

type Mode = 'own' | 'inherit';

/** What the person has changed and not saved yet. */
interface Draft {
  mode: Mode;
  entries: RagAclEntryInput[];
}

interface Parent {
  node: RagAclNodeKey;
  /** What "Inherit from ..." names. */
  label: string;
}

const ROOT_PARENT: Parent = { node: 'module', label: 'the default access' };

/**
 * The node a folder or document inherits from: its folder, or the root at the top level. null while the folders are
 * not loaded (or cannot place the node): the screen then says "its parent" and shows no inherited list.
 */
function resolveParent(target: RagPermissionTarget, folders: RagFolderView[] | null): Parent | null {
  if (target.node === 'module' || folders === null) return null;
  const asParent = (folder: RagFolderView): Parent => ({ node: folderNode(folder._id), label: folder.name });
  if (target.node.startsWith('folder:')) {
    const id = target.node.slice('folder:'.length);
    const folder = folders.find((item) => item._id === id);
    if (!folder) return null;
    if (!folder.parentId) return ROOT_PARENT;
    const parent = folders.find((item) => item._id === folder.parentId);
    return parent ? asParent(parent) : null;
  }
  const path = (target.path ?? '').trim();
  if (!path) return ROOT_PARENT;
  const holder = folders.find((item) => item.path === path);
  return holder ? asParent(holder) : null;
}

/* ── The editor ──────────────────────────────────────────────────────────── */

type BodyProps = Omit<RagPermissionEditorProps, 'target'> & { target: RagPermissionTarget };

function EditorBody({ moduleKey, moduleName, target, accessEnabled, adminBypass, onClose, onSaved }: BodyProps) {
  const { confirm } = useConfirm();
  const isRoot = target.node === 'module';

  const acl = useAccessLoad((signal) => ragAccessApi.getAcl(moduleKey, target.node, signal), `${moduleKey}|${target.node}`);
  const folderList = useAccessLoad((signal) => ragAccessApi.folders(moduleKey, signal), moduleKey, !isRoot);
  const stored = acl.data;
  const synced = stored?.managed === 'sync';

  // What a node that has its own list would inherit is read from its parent; a node that inherits already knows.
  const parent = resolveParent(target, folderList.data);
  const parentAcl = useAccessLoad(
    (signal) => ragAccessApi.getAcl(moduleKey, parent?.node ?? 'module', signal),
    `${moduleKey}|parent|${parent?.node ?? ''}`,
    parent !== null && stored?.mode === 'own',
  );
  const inherited = stored?.mode === 'inherit' ? stored.effective : parentAcl.data?.effective ?? null;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [addTab, setAddTab] = useState('people');

  const storedEntries = stored ? stored.entries.map(toInput) : [];
  const mode: Mode = isRoot ? 'own' : draft?.mode ?? stored?.mode ?? 'inherit';
  const entries: RagAclEntryInput[] = mode === 'own' ? draft?.entries ?? storedEntries : [];
  const taken = new Set(entries.map((entry) => entry.principal));
  const full = entries.length >= MAX_ENTRIES;
  const locked = synced || !stored || saving;
  const dirty = stored !== null && (mode !== (isRoot ? 'own' : stored.mode) || (mode === 'own' && !sameEntries(entries, storedEntries)));

  const { audience } = useRagAudience(moduleKey, [
    ...entries.map((entry) => entry.principal),
    ...(inherited?.entries ?? []).slice(0, 3).map((entry) => entry.principal),
  ]);

  function chooseMode(next: Mode) {
    if (isRoot || locked || !stored || next === mode) return;
    // Own again after inherit keeps what was there; the first time, an own list starts as a copy of what is inherited.
    const kept = draft?.entries ?? (stored.mode === 'own' ? storedEntries : startingEntries(inherited));
    setDraft({ mode: next, entries: kept });
    setProblem(null);
  }

  function changeEntries(next: RagAclEntryInput[]) {
    setDraft({ mode: 'own', entries: next });
    setProblem(null);
  }

  function addEntry(entry: RagAclEntryInput) {
    if (locked || full || taken.has(entry.principal)) return;
    changeEntries([entry, ...entries]);
  }

  function removeEntry(principal: string) {
    if (locked) return;
    changeEntries(entries.filter((entry) => entry.principal !== principal));
  }

  async function save() {
    if (!stored || synced || saving) return;
    const list = mode === 'own' ? entries : [];
    if (!isRoot && mode === 'own' && list.length === 0) {
      const confirmed = await confirm({
        title: ACCESS_TEXT.emptyConfirmTitle,
        message: `${ACCESS_TEXT.nobodyTitle} ${emptyListSentence(adminBypass)}`,
        confirmLabel: ACCESS_TEXT.emptyConfirmLabel,
        tone: 'warning',
      });
      if (!confirmed) return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const saved = await ragAccessApi.putAcl(moduleKey, target.node, mode, list);
      notifications.show({ color: 'green', title: ACCESS_TEXT.saved, message: target.name });
      onSaved(saved);
      onClose();
    } catch (error) {
      setProblem(saveProblem(error, entries, audience));
    } finally {
      setSaving(false);
    }
  }

  /* Why Save is off, if it is. */
  const saveReason = !stored
    ? acl.error ? ACCESS_TEXT.aclLoadFailed : ACCESS_TEXT.loadingAcl
    : synced ? ACCESS_TEXT.syncedSaveReason : !dirty ? ACCESS_TEXT.notChanged : undefined;

  const subtitle = nodeSubtitle(target.node, target.name, target.path, moduleName);
  const parentLabel = parent?.label ?? 'its parent';
  const listNumber = isRoot ? 1 : 2;

  const summary = (
    <SummaryGroup title="Summary">
      <SummaryKV label="Node" value={subtitle} />
      <SummaryKV
        label="Permissions come from"
        value={isRoot ? 'The default access' : mode === 'inherit' ? `Inherited from ${parentLabel}` : 'Its own list'}
      />
      <SummaryKV label="Entries" value={mode === 'own' ? `${formatCount(entries.length)} of ${formatCount(MAX_ENTRIES)}` : '—'} />
      <SummaryKV label="Enforcement" value={accessEnabled ? 'On' : 'Off · stored, not applied'} />
      <SummaryKV label="Admin exception" value={adminBypass ? 'On' : 'Off'} />
    </SummaryGroup>
  );

  return (
    <FormShell
      open
      onClose={onClose}
      icon={<IconLock size={16} />}
      title="Permissions"
      subtitle={subtitle}
      summary={summary}
      footerStatus={problem ? 'Not saved' : dirty ? 'Unsaved changes' : undefined}
      primaryAction={{
        label: 'Save',
        icon: <IconCheck size={13} />,
        loading: saving,
        disabled: saveReason !== undefined,
        disabledReason: saveReason,
        onClick: () => void save(),
      }}
    >
      {!accessEnabled ? (
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />} mb="md">{ACCESS_TEXT.accessOffNote}</Alert>
      ) : null}
      {synced ? (
        <Alert color="blue" variant="light" icon={<IconRefresh size={16} />} title={ACCESS_TEXT.syncedTitle} mb="md">
          {ACCESS_TEXT.syncedNote}
        </Alert>
      ) : null}
      {problem ? (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} mb="md">{problem}</Alert>
      ) : null}

      {!stored ? (
        acl.error ? (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title={ACCESS_TEXT.aclLoadFailed}>
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <Text size="sm">{acl.error.message}</Text>
              <Button size="xs" variant="light" color="red" leftSection={<IconRefresh size={12} />} onClick={acl.reload}>Retry</Button>
            </Group>
          </Alert>
        ) : (
          <Stack gap="sm" aria-busy="true" aria-label="Loading permissions">
            <Skeleton height={16} width="45%" radius="sm" />
            <Skeleton height={52} radius="md" />
            <Skeleton height={52} radius="md" />
          </Stack>
        )
      ) : (
        <>
          {!isRoot ? (
            <FormSection number={1} title="Where its permissions come from">
              <Radio.Group name="permission-source" aria-label="Where its permissions come from" value={mode} onChange={(value) => chooseMode(value === 'own' ? 'own' : 'inherit')}>
                <Stack gap="md">
                  <Radio
                    value="inherit"
                    disabled={locked}
                    label={`Inherit from ${parentLabel}`}
                    description={inheritedSentence(inherited, audience) || (parent && !parentAcl.error ? 'Looking up who can read now…' : undefined)}
                  />
                  <Radio value="own" disabled={locked} label="Give it its own permissions" description={ACCESS_TEXT.ownDescription} />
                </Stack>
              </Radio.Group>
              {mode === 'inherit' && stored.mode === 'own' ? (
                <Text size="xs" c="orange" mt="sm" role="note">{ACCESS_TEXT.inheritHint}</Text>
              ) : null}
            </FormSection>
          ) : null}

          {mode === 'own' ? (
            <>
              <FormSection
                number={listNumber}
                title="Who can read"
                description={`${formatCount(entries.length)} of ${formatCount(MAX_ENTRIES)}`}
              >
                {entries.length === 0 ? (
                  isRoot ? (
                    <Paper withBorder radius="md" p="sm">
                      <Group gap="sm" wrap="nowrap">
                        <PrincipalIcon kind="everyone" />
                        <Text size="sm" fw={500}>{ACCESS_TEXT.rootDefaultRow}</Text>
                      </Group>
                    </Paper>
                  ) : (
                    <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} title={ACCESS_TEXT.nobodyTitle}>
                      {emptyListSentence(adminBypass)}
                    </Alert>
                  )
                ) : (
                  <div role="list" aria-label="Who can read" style={{ maxHeight: 420, overflowY: 'auto' }}>
                    {entries.map((entry) => (
                      <EntryRow
                        key={entry.principal}
                        entry={entry}
                        audience={audience[entry.principal]}
                        disabled={locked}
                        onRemove={() => removeEntry(entry.principal)}
                      />
                    ))}
                  </div>
                )}
              </FormSection>

              <FormSection number={listNumber + 1} title="Add" description={full ? ACCESS_TEXT.listFull : undefined}>
                <Stack gap="md">
                  <Paper withBorder radius="md" p="xs" px="sm">
                    <Group justify="space-between" wrap="nowrap" gap="sm">
                      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                        <PrincipalIcon kind="everyone" size={26} />
                        <Text size="sm" fw={500}>{ACCESS_TEXT.everyoneDefault}</Text>
                      </Group>
                      {taken.has(EVERYONE_PRINCIPAL) ? (
                        <Button size="xs" variant="subtle" color="teal" leftSection={<IconCheck size={12} />} disabled>Added</Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="light"
                          leftSection={<IconPlus size={12} />}
                          disabled={locked || full}
                          onClick={() => addEntry(entryInput(EVERYONE_PRINCIPAL))}
                          aria-label={`Add ${ACCESS_TEXT.everyoneDefault}`}
                        >
                          Add
                        </Button>
                      )}
                    </Group>
                  </Paper>

                  <Tabs value={addTab} onChange={(value) => setAddTab(value ?? 'people')} keepMounted={false}>
                    <Tabs.List>
                      <Tabs.Tab value="people">People</Tabs.Tab>
                      <Tabs.Tab value="groups">Groups</Tabs.Tab>
                      <Tabs.Tab value="tokens">API tokens</Tabs.Tab>
                      <Tabs.Tab value="email">E-mail</Tabs.Tab>
                      <Tabs.Tab value="connector">From a connector</Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panel value="people" pt="sm">
                      <RagPrincipalPicker moduleKey={moduleKey} type="user" taken={taken} full={full} disabled={locked} onAdd={addEntry} />
                    </Tabs.Panel>
                    <Tabs.Panel value="groups" pt="sm">
                      <RagPrincipalPicker moduleKey={moduleKey} type="group" taken={taken} full={full} disabled={locked} onAdd={addEntry} />
                    </Tabs.Panel>
                    <Tabs.Panel value="tokens" pt="sm">
                      <RagPrincipalPicker moduleKey={moduleKey} type="token" taken={taken} full={full} disabled={locked} onAdd={addEntry} />
                    </Tabs.Panel>
                    <Tabs.Panel value="email" pt="sm">
                      <RagEmailAdder taken={taken} full={full} disabled={locked} onAdd={addEntry} />
                    </Tabs.Panel>
                    <Tabs.Panel value="connector" pt="sm">
                      <RagDirectoryPicker taken={taken} full={full} disabled={locked} onAdd={addEntry} />
                    </Tabs.Panel>
                  </Tabs>
                </Stack>
              </FormSection>
            </>
          ) : null}
        </>
      )}
    </FormShell>
  );
}

/* ── A row of the list ───────────────────────────────────────────────────── */

function EntryRow({
  entry,
  audience,
  disabled,
  onRemove,
}: {
  entry: RagAclEntryInput;
  audience: RagAccessAudienceItem | undefined;
  disabled: boolean;
  onRemove: () => void;
}) {
  const title = entryTitle(entry.principal, entry.label, audience);
  const detail = entryDetail(entry.principal, audience);
  return (
    <Group role="listitem" justify="space-between" wrap="nowrap" gap="sm" py={8} style={{ borderBottom: '1px solid var(--ds-border, var(--mantine-color-default-border))' }}>
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
        <PrincipalIcon kind={kindOf(entry.principal)} />
        <div style={{ minWidth: 0 }}>
          <Text size="sm" fw={500} truncate>{title}</Text>
          <Text size="xs" c={detail.warn ? 'orange' : 'dimmed'} truncate>{detail.text}</Text>
        </div>
      </Group>
      <Button size="xs" variant="subtle" color="gray" disabled={disabled} onClick={onRemove} aria-label={`Remove ${title}`}>
        Remove
      </Button>
    </Group>
  );
}

/* ── A refused save ──────────────────────────────────────────────────────── */

/** The server's sentence, and for entries it could not find, which ones. */
function saveProblem(
  error: unknown,
  entries: readonly RagAclEntryInput[],
  audience: Readonly<Record<string, RagAccessAudienceItem | undefined>>,
): string {
  const message = ragErrorMessage(error, ACCESS_TEXT.saveFailed);
  const raw = isRagApiError(error) ? error.details?.principals : undefined;
  const named = Array.isArray(raw) ? (raw as unknown[]) : [];
  const titles = named
    .filter((value): value is string => typeof value === 'string')
    .map((principal) => entryTitle(principal, entries.find((entry) => entry.principal === principal)?.label, audience[principal]));
  return titles.length > 0 ? `${message}: ${listSentence(titles, 5)}.` : message;
}
