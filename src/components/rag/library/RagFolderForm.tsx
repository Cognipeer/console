'use client';

/**
 * The three full-screen forms of the library: a new folder, a rename, and a move of folders and documents. Each one
 * is a `FormShell` that mounts only while its flow is open, so it starts clean every time. A refusal of the server
 * is shown in the form, in the server's own words.
 */

import { useMemo, useState, type KeyboardEvent } from 'react';
import { Alert, Select, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconFolderPlus, IconFolderSymlink, IconPencil } from '@tabler/icons-react';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import { ragAccessApi, ragErrorMessage, type RagFolderView } from '@/components/rag/access/ragAccessApi';
import { MoveFailedError, moveLibraryItems } from './libraryActions';
import {
  MAX_FOLDER_NAME_LENGTH,
  TOP_LEVEL,
  displayPath,
  folderChoices,
  folderNameProblem,
  knownPlace,
  moveCount,
  moveIsNoop,
  placeOf,
  plural,
  type MoveItems,
} from './libraryModel';

export type FolderFlow =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'rename'; folder: RagFolderView }
  | { kind: 'move'; items: MoveItems };

export interface RagFolderFormProps {
  /** The form to show; null = none. */
  flow: FolderFlow | null;
  moduleKey: string;
  moduleName: string;
  folders: RagFolderView[];
  /** Access control is on: moving changes who reads what, and the forms say so. */
  accessEnabled: boolean;
  onClose: () => void;
  /** The server accepted a change: the library reads folders and documents again. Never throws. */
  onChanged: () => Promise<void> | void;
}

type FormProps = Omit<RagFolderFormProps, 'flow'>;

export default function RagFolderForm({ flow, ...rest }: RagFolderFormProps) {
  if (!flow) return null;
  if (flow.kind === 'create') return <NewFolderForm {...rest} parentId={flow.parentId} />;
  if (flow.kind === 'rename') return <RenameFolderForm {...rest} folder={flow.folder} />;
  return <MoveItemsForm {...rest} items={flow.items} />;
}

/** Enter in a text field saves, as a form would. */
function submitOnEnter(save: () => void) {
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    save();
  };
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
      {message}
    </Alert>
  );
}

/* ── New folder ──────────────────────────────────────────────────────────── */

function NewFolderForm({
  moduleKey,
  moduleName,
  folders,
  accessEnabled,
  parentId,
  onClose,
  onChanged,
}: FormProps & { parentId: string | null }) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState<string>(knownPlace(folders, parentId) ?? TOP_LEVEL);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const places = useMemo(() => folderChoices(folders), [folders]);
  const problem = folderNameProblem(name);

  const save = async () => {
    if (problem || saving) return;
    setSaving(true);
    setError(null);
    try {
      const folder = await ragAccessApi.createFolder(moduleKey, { name: name.trim(), parentId: placeOf(location) });
      notifications.show({ color: 'green', title: 'Folder created', message: `${folder.name} was added.` });
      await onChanged();
      onClose();
    } catch (failure) {
      setError(ragErrorMessage(failure, 'The folder could not be created.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormShell
      open
      onClose={onClose}
      icon={<IconFolderPlus size={16} />}
      title="New folder"
      subtitle={moduleName}
      primaryAction={{
        label: 'Create folder',
        loading: saving,
        disabled: problem !== null,
        disabledReason: problem ?? undefined,
        onClick: () => void save(),
      }}
    >
      <FormSection focusOnMount number={1} title="Folder" done={problem === null}>
        <FormError message={error} />
        <FormRow cols={1}>
          <FormField label="Name" required hint={`Up to ${MAX_FOLDER_NAME_LENGTH} characters, without “/”.`}>
            <TextInput
              aria-label="Folder name"
              placeholder="e.g. Policies"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={submitOnEnter(() => void save())}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField
            label="Location"
            hint={accessEnabled ? 'A new folder takes the permissions of its location until you give it its own.' : undefined}
          >
            <Select
              aria-label="Location"
              data={places}
              value={location}
              onChange={(value) => setLocation(value ?? TOP_LEVEL)}
              allowDeselect={false}
              searchable
              nothingFoundMessage="No folder"
            />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}

/* ── Rename ──────────────────────────────────────────────────────────────── */

function RenameFolderForm({ moduleKey, folder, onClose, onChanged }: FormProps & { folder: RagFolderView }) {
  const [name, setName] = useState(folder.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = folderNameProblem(name);
  const unchanged = name.trim() === folder.name;

  const save = async () => {
    if (problem || unchanged || saving) return;
    setSaving(true);
    setError(null);
    try {
      const renamed = await ragAccessApi.updateFolder(moduleKey, folder._id, { name: name.trim() });
      notifications.show({ color: 'green', title: 'Folder renamed', message: `It is now ${renamed.name}.` });
      await onChanged();
      onClose();
    } catch (failure) {
      setError(ragErrorMessage(failure, 'The folder could not be renamed.'));
    } finally {
      setSaving(false);
    }
  };

  const blocked = problem ?? (unchanged ? 'Change the name first.' : null);
  return (
    <FormShell
      open
      onClose={onClose}
      icon={<IconPencil size={16} />}
      title="Rename folder"
      subtitle={displayPath(folder)}
      primaryAction={{
        label: 'Rename',
        loading: saving,
        disabled: blocked !== null,
        disabledReason: blocked ?? undefined,
        onClick: () => void save(),
      }}
    >
      <FormSection focusOnMount number={1} title="Name" done={blocked === null}>
        <FormError message={error} />
        <FormRow cols={1}>
          <FormField label="Name" required hint={`Up to ${MAX_FOLDER_NAME_LENGTH} characters, without “/”.`}>
            <TextInput
              aria-label="Folder name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={submitOnEnter(() => void save())}
            />
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}

/* ── Move ────────────────────────────────────────────────────────────────── */

function MoveItemsForm({ moduleKey, folders, accessEnabled, items, onClose, onChanged }: FormProps & { items: MoveItems }) {
  const count = moveCount(items);
  // null = no place chosen yet: a move is never to a default.
  const [destination, setDestination] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const places = useMemo(
    () => folderChoices(folders, { exclude: items.folders.map((folder) => folder._id), skipSynced: true }),
    [folders, items.folders],
  );
  const names = [...items.folders.map((folder) => folder.name), ...items.documents.map((doc) => doc.fileName)];

  const blocked = count === 0
    ? 'Nothing here can move: items from a connected source change only there.'
    : destination === null
      ? 'Choose where to move them.'
      : moveIsNoop(items, placeOf(destination))
        ? 'They are already there.'
        : null;

  const save = async () => {
    if (blocked || saving || destination === null) return;
    setSaving(true);
    setError(null);
    try {
      const outcome = await moveLibraryItems(moduleKey, items, placeOf(destination));
      notifications.show({
        color: 'green',
        title: 'Moved',
        message: `${plural(outcome.folders + outcome.documents, 'item')} moved.`,
      });
      await onChanged();
      onClose();
    } catch (failure) {
      if (failure instanceof MoveFailedError) {
        setError(failure.moved > 0 ? `${failure.message} ${failure.moved} of ${failure.total} items had moved before it.` : failure.message);
        // Part of it may have moved: the lists show the truth.
        if (failure.moved > 0) await onChanged();
      } else {
        setError(ragErrorMessage(failure, 'The move failed.'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormShell
      open
      onClose={onClose}
      icon={<IconFolderSymlink size={16} />}
      title={count > 0 ? `Move ${plural(count, 'item')}` : 'Move items'}
      subtitle={names.length > 0 ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? `, and ${names.length - 3} more` : ''}` : undefined}
      primaryAction={{
        label: 'Move',
        loading: saving,
        disabled: blocked !== null,
        disabledReason: blocked ?? undefined,
        onClick: () => void save(),
      }}
    >
      <FormSection number={1} title="Where to" done={blocked === null}>
        <FormError message={error} />
        {items.skipped > 0 ? (
          <Alert color="gray" variant="light">
            {`${plural(items.skipped, 'selected item')} from a connected source ${items.skipped === 1 ? 'is' : 'are'} left out: ${items.skipped === 1 ? 'it changes' : 'they change'} only in the source.`}
          </Alert>
        ) : null}
        <FormRow cols={1}>
          <FormField
            label="Destination"
            required
            hint={accessEnabled ? 'Items that inherit take the permissions of their new folder.' : undefined}
          >
            <Select
              aria-label="Destination"
              placeholder="Top level or a folder"
              data={places}
              value={destination}
              onChange={setDestination}
              allowDeselect={false}
              searchable
              nothingFoundMessage="No folder"
            />
          </FormField>
        </FormRow>
        <Text size="xs" c="dimmed">
          {count > 0 ? `${plural(count, 'item')} will move.` : 'Nothing will move.'}
        </Text>
      </FormSection>
    </FormShell>
  );
}
