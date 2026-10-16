/**
 * Pure model of the channel library screens: a library entry as a form, its request bodies and the "in use" summary.
 * Reuses the inline channel validation (`channelItems`) so both pickers agree on what a valid destination is.
 */

import type { AlertChannelType, LibraryChannelDto } from '../alertTypes';
import { channelToInput, validateChannel, type ChannelIssue, type ChannelItem } from '../channelItems';

export interface LibraryFormValues {
  name: string;
  kind: AlertChannelType;
  recipients: string[];
  url: string;
  secret: string;
  routingKey: string;
  /** Edit: a stored secret / destination is being replaced, so the inputs are shown. */
  replace: boolean;
  /** Edit, webhook: remove the stored signing secret. */
  clearSecret: boolean;
}

export const MAX_LIBRARY_NAME = 80;

export function emptyLibraryForm(kind: AlertChannelType = 'email'): LibraryFormValues {
  return { name: '', kind, recipients: [], url: '', secret: '', routingKey: '', replace: false, clearSecret: false };
}

export function libraryFormFromEntry(entry: LibraryChannelDto): LibraryFormValues {
  return {
    ...emptyLibraryForm(entry.kind),
    name: entry.name,
    recipients: [...(entry.config?.recipients ?? [])],
  };
}

/** The values as a channel item (a stored entry counts as stored, so an untouched destination stays valid). */
export function libraryFormToItem(values: LibraryFormValues, entry?: LibraryChannelDto | null): ChannelItem {
  return {
    key: 'library-form',
    ...(entry ? { id: entry.id } : {}),
    type: values.kind,
    recipients: values.recipients,
    urlHint: entry?.config?.urlHint,
    keyHint: entry?.config?.keyHint,
    hasSecret: entry?.config?.hasSecret,
    url: values.url,
    secret: values.secret,
    routingKey: values.routingKey,
    replace: values.replace,
    clearSecret: values.clearSecret,
  };
}

export type LibraryIssue = { code: 'nameRequired' } | { code: 'nameTooLong' } | ChannelIssue;

/**
 * The first problem with the form, or null. An email channel may list no recipients: the server accepts that and
 * mails the workspace owners and admins then, as the field's hint says.
 */
export function validateLibraryForm(values: LibraryFormValues, entry?: LibraryChannelDto | null): LibraryIssue | null {
  const name = values.name.trim();
  if (!name) return { code: 'nameRequired' };
  if (name.length > MAX_LIBRARY_NAME) return { code: 'nameTooLong' };
  return validateChannel(libraryFormToItem(values, entry));
}

/** `config` of a request: the channel input without the rule-local `id` and `type` (the entry has its own). */
export function libraryConfigOf(values: LibraryFormValues, entry?: LibraryChannelDto | null): Record<string, unknown> {
  const { id: _id, type: _type, ...config } = channelToInput(libraryFormToItem(values, entry));
  void _id;
  void _type;
  return config;
}

/** Body of `POST /alerts/channels/library`. */
export function buildCreateLibraryBody(values: LibraryFormValues): Record<string, unknown> {
  return { name: values.name.trim(), kind: values.kind, config: libraryConfigOf(values) };
}

/**
 * Body of `PATCH /alerts/channels/library/:id`. The name is always sent; the config only when it carries something
 * (an email list, or a destination or secret typed this session), so an untouched webhook keeps its stored secret.
 */
export function buildUpdateLibraryBody(values: LibraryFormValues, entry: LibraryChannelDto): Record<string, unknown> {
  const body: Record<string, unknown> = { name: values.name.trim() };
  const config = libraryConfigOf(values, entry);
  if (values.kind === 'email' || Object.keys(config).length > 0) body.config = config;
  return body;
}

/** Distinct rule names that use an entry (for the "used by" cell and the delete explanation). */
export function usedByNames(entry: Pick<LibraryChannelDto, 'usedBy'>): string[] {
  return [...new Set((entry.usedBy ?? []).map((use) => use.ruleName).filter(Boolean))];
}

/** Hint line of an entry: recipients, or the masked destination. */
export function libraryDestinationHint(entry: LibraryChannelDto): string {
  const config = entry.config;
  if (!config) return '';
  if (entry.kind === 'email') return (config.recipients ?? []).join(', ');
  return config.urlHint ?? config.keyHint ?? '';
}
