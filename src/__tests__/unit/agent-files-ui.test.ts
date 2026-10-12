/**
 * Files on buckets, as the Studio and the Document Store show them: the
 * Configure → Files section and its bucket picker, saving blocked without a
 * bucket, folder browsing and the session columns in the bucket view, the
 * session page's Files tab, the warning on an image the model cannot take, and
 * the model forms' input types — each in English and Turkish.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider, Table } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import { AgentFilesPanelView, type BucketsState } from '@/components/agents/studio/AgentFilesPanel';
import {
  attachesNewUploads,
  bucketPickerItems,
  bytesToMb,
  bucketProblem,
  bucketUnusableReason,
  compactAttachments,
  filesEnabled,
  filesSaveErrors,
  folderIssue,
  folderPreview,
  mbToBytes,
  normalizeFolder,
  patchAttachments,
  type AttachmentBucketOption,
  type AttachmentsSettings,
} from '@/components/agents/studio/filesSettings';
import { CONFIG_SECTION_KEYS, CONFIG_SECTION_TITLES, changedConfigSections, configSectionTitle } from '@/components/agents/studio/configSections';
import {
  applySessionFilter,
  bucketRefusalMessage,
  breadcrumbs,
  expiryLabel,
  filesInFolder,
  normalizePrefix,
  objectsUrl,
  parentPrefix,
  purposeParam,
  sessionHref,
  subFolders,
} from '@/components/files/fileBrowse';
import { FolderPath, SessionFileCells } from '@/components/files/FileBrowseParts';
import SessionFilesPanel from '@/components/agents/session/SessionFilesPanel';
import { AttachmentChips } from '@/components/agents/session/SessionAttachments';
import { bucketHref, conversionBadge, fileLocation, sessionFileUrl, sessionFilesUrl, type SessionFileItem } from '@/components/agents/session/sessionFilesUi';
import { visionOf } from '@/components/agents/session/agentModelVision';
import ModelInputModalitiesField from '@/components/models/ModelInputModalitiesField';
import {
  inferredInputModalities,
  inputModalitiesPayload,
  isMultimodalFor,
  shownInputModalities,
  storedInputModalities,
  toggleInputModality,
} from '@/components/models/inputModalities';
import { ApiError } from '@/lib/api/client';
import { getDefaultModelInputModalities } from '@/lib/services/models/modelCapabilities';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;

const docs: AttachmentBucketOption = {
  key: 'docs', name: 'Docs', providerKey: 'prod-s3', providerLabel: 'Production S3', driver: 'aws-s3-files',
  bucketStatus: 'active', providerStatus: 'active', usable: true, localDisk: false,
};
const disk: AttachmentBucketOption = {
  key: 'scratch', name: 'Scratch', providerKey: 'builtin', providerLabel: 'Built-in', driver: 'local-filesystem',
  bucketStatus: 'active', providerStatus: 'active', usable: true, localDisk: true,
};
const disabledBucket: AttachmentBucketOption = {
  ...docs, key: 'old', name: 'Old', bucketStatus: 'disabled', usable: false,
  reason: 'The bucket "old" is disabled.', reasonCode: 'bucket_disabled',
};
const deadProvider: AttachmentBucketOption = {
  ...docs, key: 'orphan', name: 'Orphan', providerStatus: 'missing', usable: false,
  reason: 'The storage provider "gone" of the bucket "orphan" no longer exists.', reasonCode: 'provider_missing',
};

const labels = {
  byCode: {
    bucket_disabled: 'disabled', provider_inactive: 'provider inactive', provider_missing: 'provider gone', provider_unassigned: 'provider unassigned',
  },
  unusable: 'unusable',
  notFound: (key: string) => `${key} (not found)`,
};

describe('the file settings as the Files section edits them', () => {
  it('is off unless switched on', () => {
    expect(filesEnabled(undefined)).toBe(false);
    expect(filesEnabled({ maxFiles: 4 })).toBe(false);
    expect(filesEnabled({ enabled: false })).toBe(false);
    expect(filesEnabled({ enabled: true })).toBe(true);
  });

  it('sends new uploads with the next message unless the agent says otherwise', () => {
    expect(attachesNewUploads(undefined)).toBe(true);
    expect(attachesNewUploads({ attachNewUploads: false })).toBe(false);
  });

  it('drops emptied fields, so an untouched agent stores no attachments', () => {
    expect(compactAttachments({ enabled: undefined, allowedMimeTypes: [], folder: '' })).toBeUndefined();
    const on = patchAttachments(undefined, { enabled: true, bucketKey: 'docs' });
    expect(on).toEqual({ enabled: true, bucketKey: 'docs' });
    expect(patchAttachments(on, { bucketKey: undefined })).toEqual({ enabled: true });
    // Turning it off keeps the rest, so turning it back on does not start over.
    expect(patchAttachments(on, { enabled: false })).toEqual({ enabled: false, bucketKey: 'docs' });
  });

  it('normalises the folder like the server and previews the path a session’s files get', () => {
    expect(normalizeFolder(undefined)).toBe('agent-sessions');
    expect(normalizeFolder('  /uploads//2026/ ')).toBe('uploads/2026');
    expect(folderPreview(undefined, 'support')).toBe('agent-sessions/support/<sessionId>/…');
    expect(folderPreview('uploads', undefined)).toBe('uploads/<agentKey>/<sessionId>/…');
  });

  it('says why a folder is refused', () => {
    expect(folderIssue('')).toBeNull();
    expect(folderIssue('a/b-c_d.e')).toBeNull();
    expect(folderIssue('a b')).toBe('invalid_chars');
    expect(folderIssue('a/../b')).toBe('dot_dot');
    expect(folderIssue('a/./b')).toBe('dot_dot');
    expect(folderIssue('x'.repeat(201))).toBe('too_long');
  });
});

describe('the bucket picker', () => {
  it('lists the project’s buckets as “name · provider”, unusable ones disabled with the reason', () => {
    const items = bucketPickerItems([docs, disabledBucket, deadProvider, disk], undefined, labels);
    expect(items.map((item) => item.label)).toEqual(['Docs · Production S3', 'Old · Production S3', 'Orphan · Production S3', 'Scratch · Built-in']);
    expect(items.map((item) => item.disabled)).toEqual([false, true, true, false]);
    expect(items[1].reason).toBe('disabled');
    expect(items[2].reason).toBe('provider gone');
    expect(items[3].localDisk).toBe(true);
    expect(items[0].reason).toBeUndefined();
  });

  it('words the reason by its code, in the viewer’s own language', () => {
    expect(bucketUnusableReason({ ...docs, usable: false, reasonCode: 'provider_unassigned', reason: 'English sentence.' }, labels)).toBe('provider unassigned');
    expect(bucketUnusableReason(docs, labels)).toBeUndefined();
  });

  it('falls back to the statuses for a server that sends no code, then to the server’s sentence', () => {
    expect(bucketUnusableReason({ ...docs, providerStatus: 'disabled', usable: false }, labels)).toBe('provider inactive');
    expect(bucketUnusableReason({ ...docs, providerStatus: 'errored', usable: false }, labels)).toBe('provider inactive');
    expect(bucketUnusableReason({ ...docs, bucketStatus: 'disabled', usable: false }, labels)).toBe('disabled');
    expect(bucketUnusableReason({ ...docs, providerStatus: 'missing', usable: false, reason: 'Server sentence.' }, labels)).toBe('Server sentence.');
    expect(bucketUnusableReason({ ...docs, providerStatus: 'missing', usable: false }, labels)).toBe('unusable');
    // A code the viewer's language has no wording for still shows the server's sentence.
    expect(bucketUnusableReason({ ...docs, usable: false, reasonCode: 'bucket_missing', reason: 'Gone.' }, labels)).toBe('Gone.');
  });

  it('keeps a stored key the project no longer has, marked “(not found)” — and shows it as it is while loading', () => {
    const gone = bucketPickerItems([docs], 'deleted-bucket', labels);
    expect(gone[0]).toMatchObject({ value: 'deleted-bucket', label: 'deleted-bucket (not found)', missing: true });
    expect(bucketPickerItems(null, 'docs', labels)).toEqual([expect.objectContaining({ value: 'docs', label: 'docs' })]);
    expect(bucketPickerItems([docs], 'docs', labels)).toHaveLength(1);
  });

  it('knows what is wrong with the choice', () => {
    const on: AttachmentsSettings = { enabled: true };
    expect(bucketProblem(undefined, [docs])).toBeNull();
    expect(bucketProblem({ enabled: false }, [docs])).toBeNull();
    expect(bucketProblem(on, null)).toBe('required');
    expect(bucketProblem({ ...on, bucketKey: '  ' }, [docs])).toBe('required');
    expect(bucketProblem({ ...on, bucketKey: 'docs' }, null)).toBeNull();
    expect(bucketProblem({ ...on, bucketKey: 'docs' }, [docs])).toBeNull();
    expect(bucketProblem({ ...on, bucketKey: 'nope' }, [docs])).toBe('not_found');
    expect(bucketProblem({ ...on, bucketKey: 'old' }, [docs, disabledBucket])).toBe('unusable');
  });
});

describe('saving with files on', () => {
  it('is blocked without a bucket, and only then', () => {
    expect(filesSaveErrors(undefined)).toEqual([]);
    expect(filesSaveErrors({ enabled: false })).toEqual([]);
    expect(filesSaveErrors({ enabled: true })).toEqual([{ field: 'attachments.bucketKey', code: 'bucket_required' }]);
    expect(filesSaveErrors({ enabled: true, bucketKey: 'docs' })).toEqual([]);
  });

  it('is blocked for a folder the server would refuse', () => {
    expect(filesSaveErrors({ enabled: true, bucketKey: 'docs', folder: 'a/../b' })).toEqual([{ field: 'attachments.folder', code: 'dot_dot' }]);
    // A folder left over from before files were switched off does not stop an unrelated save.
    expect(filesSaveErrors({ enabled: false, folder: 'a b' })).toEqual([]);
  });
});

describe('Configure → Files', () => {
  const panel = (value: AttachmentsSettings | undefined, buckets: BucketsState, extra: Record<string, unknown> = {}, locale: 'en' | 'tr' = 'en') =>
    render(h(AgentFilesPanelView, { value, onChange: noop, agentKey: 'support', buckets, ...extra }), locale);
  const ready = (...list: AttachmentBucketOption[]): BucketsState => ({ status: 'ready', buckets: list });

  it('is a section of its own, right after Execution, owning config.attachments', () => {
    const keys = Object.keys(CONFIG_SECTION_KEYS);
    expect(keys[keys.indexOf('execution') + 1]).toBe('files');
    expect(CONFIG_SECTION_KEYS.files).toEqual(['attachments']);
    expect(CONFIG_SECTION_TITLES.files).toBe('Files');
    const translate = (language: typeof en) => (key: string) =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], language.agents) as string;
    expect(configSectionTitle('files', translate(en))).toBe('Files');
    expect(configSectionTitle('files', translate(tr))).toBe('Dosyalar');
  });

  it('marks Files changed when the stored attachments differ from the published ones', () => {
    const published = { modelKey: 'm', attachments: { enabled: true, bucketKey: 'docs' } };
    expect([...changedConfigSections({ modelKey: 'm', attachments: { enabled: true, bucketKey: 'other' } }, published)]).toEqual(['files']);
    expect([...changedConfigSections({ modelKey: 'm', execution: { backgroundEnabled: false }, attachments: published.attachments }, published)]).toEqual(['execution']);
  });

  it('shows only the switch while files are off — off by default', () => {
    const html = panel(undefined, { status: 'loading' });
    expect(html).toContain('Let people attach files');
    expect(html).not.toMatch(/Where files are stored|Limits|Folder/);
    expect(html).toMatch(/<input[^>]*type="checkbox"(?![^>]*checked)/);
  });

  it('with files on shows the bucket, folder, limits, types, reading rules and the summary', () => {
    const html = panel({ enabled: true, bucketKey: 'docs', retentionDays: 14 }, ready(docs, disk));
    for (const text of ['Where files are stored', 'Bucket', 'Folder', 'Limits', 'Files per session', 'Largest file (MB)', 'Keep files for (days)',
      'Allowed file types', 'How the agent reads them', 'Put in the message up to (tokens)', 'Page size when reading (characters)',
      'Send new uploads with the next message', 'Manage buckets']) {
      expect(html).toContain(text);
    }
    // The chosen bucket is what the field holds; the path preview and the summary follow it.
    expect(html).toContain('value="Docs · Production S3"');
    expect(html).toContain('Saved as agent-sessions/support/&lt;sessionId&gt;/…');
    expect(html).toContain('Files are stored in Docs (Production S3) under agent-sessions/… and deleted 14 days after upload or with the session.');
    for (const placeholder of ['placeholder="agent-sessions"', 'placeholder="10"', 'placeholder="20"', 'placeholder="30"', 'placeholder="30000"', 'placeholder="20000"']) {
      expect(html).toContain(placeholder);
    }
    // All of a message’s files are summed — said in the help text.
    expect(html).toContain('is added up');
    expect(html).toContain('none is');
  });

  it('keeps the image budget editable: images per request, megabytes per request, and how many recent ones are shown again', () => {
    const html = panel({ enabled: true, bucketKey: 'docs' }, ready(docs));
    for (const text of ['Images per model request', 'Image size per request (MB)', 'Show recent images again (messages)']) expect(html).toContain(text);
    for (const placeholder of ['placeholder="6"', 'placeholder="12"', 'placeholder="2"']) expect(html).toContain(placeholder);

    const stored = panel({ enabled: true, bucketKey: 'docs', maxImages: 4, maxBytes: 8_500_000, carryRecentImages: 0 }, ready(docs));
    expect(stored).toContain('value="4"');
    expect(stored).toContain('value="8.5"');
    // 0 is a real choice (“never”), not an empty box.
    expect(stored).toContain('value="0"');
    expect(panel({ enabled: true, bucketKey: 'docs' }, ready(docs), {}, 'tr')).toContain('Model isteği başına görsel sayısı');
  });

  it('stores the image size in bytes and shows it in megabytes', () => {
    expect(bytesToMb(12_000_000)).toBe(12);
    expect(bytesToMb(undefined)).toBeUndefined();
    expect(bytesToMb(0)).toBeUndefined();
    expect(mbToBytes(8.5)).toBe(8_500_000);
    expect(mbToBytes(0.1)).toBe(100_000);
    expect(mbToBytes('')).toBeUndefined();
    expect(patchAttachments({ enabled: true, bucketKey: 'docs' }, { carryRecentImages: 0 })).toEqual({ enabled: true, bucketKey: 'docs', carryRecentImages: 0 });
  });

  it('shows the stored limits and a custom folder', () => {
    const html = panel({ enabled: true, bucketKey: 'docs', maxFiles: 4, maxFileSizeMb: 8, folder: 'uploads/2026', allowedMimeTypes: ['image/*', 'application/pdf'] }, ready(docs));
    expect(html).toContain('value="4"');
    expect(html).toContain('value="8"');
    expect(html).toContain('value="uploads/2026"');
    expect(html).toContain('uploads/2026/…');
    expect(html).toContain('image/*');
    expect(html).toContain('application/pdf');
  });

  it('asks for a bucket when none is chosen — once touched or after a refused save', () => {
    const quiet = panel({ enabled: true }, ready(docs));
    expect(quiet).not.toContain('Choose a bucket</');
    expect(quiet).toContain('Choose a bucket to see where the files will be stored.');
    expect(panel({ enabled: true }, ready(docs), { showErrors: true })).toContain('Choose a bucket</p>');
  });

  it('says so when the project has no bucket, and points at the Document Store', () => {
    const html = panel({ enabled: true }, ready());
    expect(html).toContain('No bucket in this project yet');
    expect(html).toContain('href="/dashboard/files"');
    expect(html).toContain('Open the Document Store');
  });

  it('shows a stored bucket the project no longer has as “(not found)”, in error', () => {
    const html = panel({ enabled: true, bucketKey: 'deleted-bucket' }, ready(docs));
    expect(html).toContain('value="deleted-bucket (not found)"');
    expect(html).toContain('no longer exists in this project');
  });

  it('explains a chosen bucket that cannot take files right now', () => {
    const html = panel({ enabled: true, bucketKey: 'old' }, ready(docs, disabledBucket));
    expect(html).toContain('The chosen bucket cannot be used right now: The bucket is disabled');
  });

  it('warns that a server-disk bucket lives on one server', () => {
    expect(panel({ enabled: true, bucketKey: 'scratch' }, ready(docs, disk))).toContain('disk of the server running Console');
    expect(panel({ enabled: true, bucketKey: 'docs' }, ready(docs, disk))).not.toContain('disk of the server running Console');
  });

  it('calls a server-disk bucket single-node storage, and says portal users get the published version', () => {
    const html = panel({ enabled: true, bucketKey: 'scratch' }, ready(docs, disk));
    expect(html).toContain('single-node storage');
    expect(html).toContain('Portal users get the settings of the published version, not of the draft.');
    const turkish = panel({ enabled: true, bucketKey: 'scratch' }, ready(docs, disk), {}, 'tr');
    expect(turkish).toContain('tek düğümlü depolama');
    expect(turkish).toContain('yayımlanmış sürümün ayarlarını');
  });

  it('explains, instead of showing an outage, that the viewer may not list buckets — in the server’s words when it gave them', () => {
    const forbidden = panel({ enabled: true, bucketKey: 'docs' }, { status: 'forbidden', message: 'Listing buckets needs the Document Store: ask an admin.' });
    expect(forbidden).toContain('data-testid="buckets-forbidden"');
    expect(forbidden).toContain('You cannot choose a bucket');
    expect(forbidden).toContain('Listing buckets needs the Document Store: ask an admin.');
    expect(forbidden).not.toContain('Could not load the buckets of this project.');
    expect(forbidden).not.toContain('Manage buckets');
    // The saved bucket is shown as it is, and cannot be changed from here.
    expect((forbidden.match(/<input[^>]*>/g) ?? []).some((tag) => tag.includes('value="docs"') && tag.includes('disabled'))).toBe(true);

    const plain = panel({ enabled: true, bucketKey: 'docs' }, { status: 'forbidden' });
    expect(plain).toContain('Choosing where files are stored needs access to the Document Store.');
    expect(panel({ enabled: true, bucketKey: 'docs' }, { status: 'forbidden' }, {}, 'tr')).toContain('Bucket seçemezsiniz');
  });

  it('asks the picker endpoint and reads a 403 as “forbidden”, anything else as an outage', () => {
    const source = readFileSync(join(__dirname, '../../components/agents/studio/AgentFilesPanel.tsx'), 'utf8');
    expect(source).toContain('res.status === 403');
    expect(source).toContain("status: 'forbidden'");
    expect(source).toContain("'/api/agents/attachments/buckets'");
  });

  it('shows a loading list and a failed one with a way to retry', () => {
    expect(panel({ enabled: true }, { status: 'loading' })).toContain('Loading the buckets of this project…');
    const failed = panel({ enabled: true }, { status: 'error' }, { onRetryBuckets: noop });
    expect(failed).toContain('Could not load the buckets of this project.');
    expect(failed).toContain('Try again');
  });

  it('refuses a folder with a character the server would, as a field error', () => {
    expect(panel({ enabled: true, bucketKey: 'docs', folder: 'my folder' }, ready(docs))).toContain('Use letters, numbers, dots, dashes, underscores and slashes only.');
  });

  it('is fully translated', () => {
    const html = panel({ enabled: true, bucketKey: 'scratch' }, ready(docs, disk), {}, 'tr');
    for (const text of ['Kişiler dosya ekleyebilsin', 'Dosyalar nerede saklanır', 'Depolama bucket’ı', 'Klasör', 'Sınırlar', 'Oturum başına dosya sayısı',
      'İzin verilen dosya türleri', 'Agent dosyaları nasıl okur', 'hiçbiri konmaz', 'Bucket’ları yönet', 'sunucunun diskinde', 'Dosyalar Scratch (Built-in)']) {
      expect(html, text).toContain(text);
    }
    for (const text of ['Let people attach files', 'Where files are stored', 'Manage buckets']) expect(html).not.toContain(text);
  });
});

describe('browsing a bucket by folder', () => {
  it('normalises a folder path and walks the breadcrumb', () => {
    expect(normalizePrefix(undefined)).toBe('');
    expect(normalizePrefix('/a//b')).toBe('a/b/');
    expect(breadcrumbs('a/b/').map((crumb) => [crumb.label, crumb.prefix])).toEqual([['', ''], ['a', 'a/'], ['b', 'a/b/']]);
    expect(breadcrumbs('')).toEqual([{ label: '', prefix: '' }]);
    expect(parentPrefix('a/b/')).toBe('a/');
    expect(parentPrefix('a/')).toBe('');
    expect(parentPrefix('')).toBeNull();
  });

  it('shows the files directly in the folder and a folder row for each sub-folder, once', () => {
    const items = [{ key: 'root.txt' }, { key: 'agent-sessions/support/s1/a.pdf' }, { key: 'agent-sessions/support/s2/b.pdf' }, { key: 'agent-sessions/c.txt' }];
    expect(filesInFolder('', items).map((item) => item.key)).toEqual(['root.txt']);
    expect(subFolders('', undefined, items)).toEqual([{ name: 'agent-sessions', path: 'agent-sessions/' }]);
    expect(filesInFolder('agent-sessions/', items).map((item) => item.key)).toEqual(['agent-sessions/c.txt']);
    expect(subFolders('agent-sessions/', undefined, items)).toEqual([{ name: 'support', path: 'agent-sessions/support/' }]);
  });

  it('uses the folders the server named, folded with those the keys imply, in name order', () => {
    const folders = subFolders('a/', ['a/zeta/', 'a/alpha/deep/', 'b/other/'], [{ key: 'a/mid/x.txt' }, { key: 'a/zeta/y.txt' }]);
    expect(folders.map((folder) => folder.path)).toEqual(['a/alpha/', 'a/mid/', 'a/zeta/']);
  });

  it('asks for one folder at a time, with the session filter when set', () => {
    expect(objectsUrl('docs', { prefix: '', filter: 'all' })).toBe('/api/files/buckets/docs/objects?limit=50&prefix=');
    expect(objectsUrl('my bucket', { prefix: 'a/b/', filter: 'session', cursor: 'a/b/k' })).toBe(
      '/api/files/buckets/my%20bucket/objects?limit=50&prefix=a%2Fb%2F&purpose=conversation&cursor=a%2Fb%2Fk',
    );
    expect(purposeParam('other')).toBe('other');
    expect(purposeParam('all')).toBeUndefined();
  });

  it('filters session files from the others', () => {
    const rows = [{ purpose: 'conversation' as const, key: 'a' }, { key: 'b' }];
    expect(applySessionFilter(rows, 'all')).toHaveLength(2);
    expect(applySessionFilter(rows, 'session').map((row) => row.key)).toEqual(['a']);
    expect(applySessionFilter(rows, 'other').map((row) => row.key)).toEqual(['b']);
  });

  it('draws the path above the list — the last part is where you are, the others open that folder', () => {
    const html = render(h(FolderPath, { prefix: 'agent-sessions/support/', onOpen: noop }));
    expect(html).toContain('aria-label="Folder path"');
    expect(html).toContain('Bucket root');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="Up one folder"');
    expect(render(h(FolderPath, { prefix: '', onOpen: noop }))).not.toContain('Up one folder');
    expect(render(h(FolderPath, { prefix: 'a/', onOpen: noop }), 'tr')).toContain('Bucket kökü');
  });
});

describe('session files in the bucket view', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const row = (record: Parameters<typeof SessionFileCells>[0]['record'], agentId?: string, locale: 'en' | 'tr' = 'en') =>
    render(h(Table, null, h(Table.Tbody, null, h(Table.Tr, null, h(SessionFileCells, { record, agentId, now, locale })))), locale);

  it('links the session page, shows when the file goes and who uploaded it', () => {
    const html = row({ purpose: 'conversation', conversationId: 'conv1', agentKey: 'support', expiresAt: new Date('2026-10-23T12:00:00Z'), uploadedBy: 'user-7' }, 'agent-id-1');
    expect(html).toContain('href="/dashboard/agents/agent-id-1/sessions/conv1"');
    expect(html).toContain('support · conv1');
    expect(html).toContain('in 12 days');
    expect(html).toContain('user-7');
  });

  it('shows the session without a link when the agent cannot be found', () => {
    const html = row({ purpose: 'conversation', conversationId: 'conv1', agentKey: 'gone', expiresAt: null });
    expect(html).not.toContain('href=');
    expect(html).toContain('gone · conv1');
    expect(html).toContain('Does not expire');
  });

  it('takes the agent’s id from the row the server sent, not from a second request for every agent', () => {
    const source = readFileSync(join(__dirname, '../../components/files/FileObjectManager.tsx'), 'utf8');
    expect(source).toContain('agentId={record.agentId}');
    expect(source).not.toContain("'/api/agents'");
    expect(source).not.toContain('agents-by-key');
  });

  it('marks an expired file', () => {
    const html = row({ purpose: 'conversation', conversationId: 'c', agentKey: 'a', expiresAt: new Date('2026-10-09T12:00:00Z') });
    expect(html).toContain('Expired · 2 days ago');
  });

  it('leaves the cells of any other file empty', () => {
    const html = row({ conversationId: undefined });
    expect(html).not.toContain('Session file');
    expect((html.match(/—/g) ?? []).length).toBe(3);
  });

  it('speaks Turkish', () => {
    const html = row({ purpose: 'conversation', conversationId: 'c', agentKey: 'a', expiresAt: new Date('2026-10-23T12:00:00Z') }, 'x', 'tr');
    expect(html).toContain('Oturum dosyası');
    expect(html).toContain('12 gün sonra');
  });

  it('words expiry from the clock it is given', () => {
    expect(expiryLabel(null, now, 'en')).toEqual({ kind: 'none', text: '' });
    expect(expiryLabel('not a date', now, 'en').kind).toBe('none');
    expect(expiryLabel(new Date('2026-10-11T15:00:00Z'), now, 'en')).toEqual({ kind: 'future', text: 'in 3 hours' });
    expect(expiryLabel(new Date('2026-10-11T11:30:00Z'), now, 'en')).toEqual({ kind: 'expired', text: '30 minutes ago' });
  });

  it('addresses the session page by the agent’s id', () => {
    expect(sessionHref('a b', 'c/d')).toBe('/dashboard/agents/a%20b/sessions/c%2Fd');
    expect(sessionHref(undefined, 'c')).toBeNull();
    expect(sessionHref('a', undefined)).toBeNull();
  });
});

describe('a refused bucket delete or disable', () => {
  it('carries the server’s reason, plus any agent it names that the sentence lacks', () => {
    const reason = 'The bucket "docs" is where this agent keeps session files: Support. Choose another bucket in its Files settings before you delete it.';
    const full = new ApiError(reason, 409, { error: reason, agents: [{ key: 'support', name: 'Support' }] });
    expect(bucketRefusalMessage(full)).toBe(reason);
    const terse = new ApiError('Bucket in use', 409, { error: 'Bucket in use', agents: [{ key: 'support', name: 'Support' }, { key: 'sales' }] });
    expect(bucketRefusalMessage(terse)).toBe('Bucket in use (Support, sales)');
    expect(bucketRefusalMessage(new ApiError('Nope', 500))).toBe('Nope');
    expect(bucketRefusalMessage('weird')).toBe('Unexpected error');
  });
});

describe('the session page’s Files tab', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const files: SessionFileItem[] = [
    { id: 'f1', name: 'report.pdf', mimeType: 'application/pdf', size: 2048, conversionStatus: 'succeeded', bucketKey: 'docs', path: 'agent-sessions/support/s1/report-1.pdf', expiresAt: '2026-10-23T12:00:00Z', uploadedBy: 'user-1' },
    { id: 'f2', name: 'scan.pdf', mimeType: 'application/pdf', size: 1024, conversionStatus: 'failed', conversionError: 'No text layer', bucketKey: 'docs', path: 'agent-sessions/support/s1/scan-2.pdf', expiresAt: null },
    { id: 'f3', name: 'photo.png', mimeType: 'image/png', size: 4096, conversionStatus: 'skipped', bucketKey: 'docs', path: 'agent-sessions/support/s1/photo-3.png', expiresAt: '2026-10-10T12:00:00Z' },
  ];
  const panel = (props: Partial<Parameters<typeof SessionFilesPanel>[0]>, locale: 'en' | 'tr' = 'en') =>
    render(h(SessionFilesPanel, { files, maxFiles: 10, onDelete: noop, onRetry: noop, now, ...props }), locale);

  it('counts the files the server lists against the limit, from the list and not from the messages', () => {
    const html = panel({});
    expect(html).toContain('3 of 10 files');
    expect(panel({ maxFiles: undefined })).toContain('3 files');
  });

  it('shows each file’s size, type, text status, location, expiry and uploader', () => {
    const html = panel({});
    for (const text of ['report.pdf', '2.0 KB · application/pdf', 'Readable', 'No text', 'docs/agent-sessions/support/s1/report-1.pdf',
      'Expires in 12 days', 'Does not expire', 'Expired · yesterday', 'Uploaded by user-1']) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain('href="/dashboard/files/docs"');
    // An image goes to the model as it is: no “no text” badge for it.
    expect(html.split('photo.png')[1]!.split('report.pdf')[0]).not.toContain('Original only');
  });

  it('offers a delete per file, unless the session is read-only', () => {
    expect((panel({}).match(/aria-label="Delete file"/g) ?? []).length).toBe(3);
    expect(panel({ readOnly: true })).not.toContain('Delete file');
  });

  it('says so when the session holds none, while loading, and when the list failed', () => {
    expect(panel({ files: [] })).toContain('No files in this session yet.');
    expect(panel({ files: null })).not.toContain('No files');
    const failed = panel({ files: null, failed: true });
    expect(failed).toContain('Could not load the files of this session.');
    expect(failed).toContain('Try again');
    // A list already on screen survives a failed refresh.
    expect(panel({ failed: true })).toContain('report.pdf');
  });

  it('speaks Turkish', () => {
    const html = panel({}, 'tr');
    expect(html).toContain('3 / 10 dosya');
    expect(html).toContain('Saklandığı yer');
    expect(html).toContain('Okunabilir');
  });

  it('builds the URLs it calls and reads a location', () => {
    expect(sessionFilesUrl('a1', 's 1')).toBe('/api/agents/a1/sessions/s%201/files');
    expect(sessionFileUrl('a1', 's1', 'f/1')).toBe('/api/agents/a1/sessions/s1/files/f%2F1');
    expect(fileLocation({ bucketKey: 'docs', path: 'x/y.pdf' })).toBe('docs/x/y.pdf');
    expect(fileLocation({ bucketKey: 'docs' })).toBe('docs');
    expect(fileLocation({})).toBeNull();
    expect(bucketHref('my bucket')).toBe('/dashboard/files/my%20bucket');
    expect(conversionBadge({ mimeType: 'application/pdf', conversionStatus: 'pending' })).toEqual({ key: 'conversionPending', color: 'yellow' });
    expect(conversionBadge({ mimeType: 'image/png', conversionStatus: 'failed' })).toBeNull();
    expect(conversionBadge({ mimeType: 'text/plain' })).toBeNull();
  });
});

describe('an image the agent’s model cannot take', () => {
  const photo = { fileId: 'p', name: 'photo.png', mimeType: 'image/png', size: 2048 };
  const pdf = { fileId: 'd', name: 'a.pdf', mimeType: 'application/pdf', size: 1024, conversionStatus: 'succeeded' as const };
  const chips = (files: Array<typeof photo | typeof pdf>, textOnlyModel?: { name: string; href: string } | null, locale: 'en' | 'tr' = 'en') =>
    render(h(AttachmentChips, { files, uploading: [], onRemove: noop, textOnlyModel }), locale);
  const model = { name: 'gpt-6-luna', href: '/dashboard/models/m1/edit' };

  it('shows a warning with a link to the model when an image is attached', () => {
    const html = chips([photo, pdf], model);
    expect(html).toContain('data-testid="image-warning"');
    expect(html).toContain('gpt-6-luna is set to text only; the image will not be sent.');
    expect(html).toContain('href="/dashboard/models/m1/edit"');
    expect(html).toContain('Change it in Models');
  });

  it('says nothing when the model takes images, when it is unknown, or when no image is attached', () => {
    expect(chips([photo, pdf], null)).not.toContain('image-warning');
    expect(chips([photo, pdf])).not.toContain('image-warning');
    expect(chips([pdf], model)).not.toContain('image-warning');
  });

  it('speaks Turkish', () => {
    expect(chips([photo], model, 'tr')).toContain('gpt-6-luna yalnızca metin olarak ayarlı; görsel gönderilmeyecek.');
  });

  it('reads the verdict from the models list: only a known model with a resolved list can be text-only', () => {
    const models = [
      { _id: 'm1', key: 'luna', name: 'Luna', capabilities: { inputModalities: ['text'] } },
      { _id: 'm2', key: 'vision', name: 'Vision', capabilities: { inputModalities: ['text', 'image'] } },
      { _id: 'm3', key: 'unknown', name: 'Unknown', capabilities: {} },
    ];
    expect(visionOf(models, 'luna')).toEqual({ key: 'luna', name: 'Luna', href: '/dashboard/models/m1/edit', acceptsImages: false });
    expect(visionOf(models, 'vision')?.acceptsImages).toBe(true);
    expect(visionOf(models, 'unknown')).toBeNull();
    expect(visionOf(models, 'missing')).toBeNull();
    expect(visionOf(models, undefined)).toBeNull();
  });
});

describe('a model’s input types in the forms', () => {
  it('starts from what is detected and stores a choice only when one is made', () => {
    expect(storedInputModalities(undefined)).toBeNull();
    expect(storedInputModalities({ capabilities: { contextWindow: 1000 } })).toBeNull();
    expect(storedInputModalities({ capabilities: { inputModalities: ['image', 'text', 'bogus'] } })).toEqual(['text', 'image']);
    expect(inputModalitiesPayload(null)).toEqual({});
    expect(inputModalitiesPayload(['text', 'image'])).toEqual({ inputModalities: ['text', 'image'] });
  });

  it('detects a known vision model from its id, so a model nobody set is no longer text-only', () => {
    // The model of the report: it had an explicit “text” stored by the old form.
    expect(inferredInputModalities('llm', 'gpt-6-luna')).toEqual(['text', 'image']);
    const stored = storedInputModalities({ capabilities: { inputModalities: ['text'] } });
    expect(shownInputModalities(stored, inferredInputModalities('llm', 'gpt-6-luna'))).toEqual(['text']);
    // “Detect automatically” sets the choice back to nothing: the detection shows again and nothing is stored.
    expect(shownInputModalities(null, inferredInputModalities('llm', 'gpt-6-luna'))).toEqual(['text', 'image']);
    expect(inputModalitiesPayload(null)).toEqual({});
  });

  it('infers from the category when nothing else is known', () => {
    expect(inferredInputModalities('llm', 'some-model')).toEqual(['text']);
    expect(inferredInputModalities('llm', 'some-model', true)).toEqual(['text', 'image']);
    expect(inferredInputModalities('stt', 'whisper')).toEqual(['audio']);
  });

  it('draws the choice, else the detection — never narrowed by the provider', () => {
    expect(shownInputModalities(null, ['text', 'image'])).toEqual(['text', 'image']);
    expect(shownInputModalities(['text'], ['text', 'image'])).toEqual(['text']);
    expect(shownInputModalities(['text', 'audio'], ['text'])).toEqual(['text', 'audio']);
  });

  it('toggles a box, in the boxes’ order, never leaving none', () => {
    expect(toggleInputModality(['text'], 'image', true)).toEqual(['text', 'image']);
    expect(toggleInputModality(['text', 'audio'], 'image', true)).toEqual(['text', 'image', 'audio']);
    expect(toggleInputModality(['text', 'image'], 'image', false)).toEqual(['text']);
    expect(toggleInputModality(['text'], 'text', false)).toEqual(['text']);
  });

  it('calls a model multimodal when it takes images, audio or video', () => {
    expect(isMultimodalFor(['text'])).toBe(false);
    expect(isMultimodalFor(['text', 'file'])).toBe(false);
    expect(isMultimodalFor(['text', 'image'])).toBe(true);
    expect(isMultimodalFor(['audio'])).toBe(true);
  });

  it('prefills from the very function the gateway resolves a model’s input types with', () => {
    const cases: Array<[Parameters<typeof inferredInputModalities>[0], boolean, string]> = [
      ['llm', false, 'gpt-4o'], ['llm', false, 'gpt-6-luna'], ['llm', false, 'plain-model'], ['llm', true, 'plain-model'],
      ['stt', false, 'whisper'], ['ocr', false, 'ocr-1'], ['embedding', false, 'embed-1'], ['llm', false, ''],
    ];
    for (const [category, multimodal, modelId] of cases) {
      expect(inferredInputModalities(category, modelId, multimodal), `${category}/${modelId}`)
        .toEqual(getDefaultModelInputModalities(category, multimodal, modelId || undefined));
    }
  });

  it('is never written back as a default: no form calls the category default, and both save only an explicit choice', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
    });
    const root = join(__dirname, '../..');
    const offenders = [...walk(join(root, 'components')), ...walk(join(root, 'app/dashboard'))]
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes('getDefaultModelInputModalities') || /inputModalities:\s*\[\s*['"]text['"]\s*\]/.test(source);
      })
      .map((file) => file.slice(root.length + 1));
    expect(offenders).toEqual([]);

    for (const file of ['components/models/CreateModelModal.tsx', 'app/dashboard/models/[id]/edit/page.tsx']) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source, file).toContain('inputModalitiesPayload(');
    }
    // The old page that posts a model without capabilities leaves the input types to the detection as well.
    expect(readFileSync(join(root, 'app/dashboard/models/new/page.tsx'), 'utf8')).not.toContain('inputModalities');
  });

  const checkboxes = (html: string) => html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
  const field = (props: Partial<Parameters<typeof ModelInputModalitiesField>[0]>, locale: 'en' | 'tr' = 'en') =>
    render(h(ModelInputModalitiesField, { value: null, inferred: ['text', 'image'], onChange: noop, ...props }), locale);

  it('shows a box per type, ticked from the detection, and says it was detected', () => {
    const html = field({});
    expect(html).toContain('Input types');
    for (const label of ['Text', 'Images', 'Audio', 'Video', 'Files']) expect(html).toContain(label);
    expect(checkboxes(html).filter((tag) => tag.includes('checked')).length).toBe(2);
    expect(html).toContain('Detected from the model id');
    expect(html).not.toContain('Detect automatically');
  });

  it('shows an explicit choice as set manually, with a way back to detection', () => {
    const html = field({ value: ['text'] });
    expect(checkboxes(html).filter((tag) => tag.includes('checked')).length).toBe(1);
    expect(html).toContain('Set manually');
    expect(html).toContain('Detect automatically');
  });

  it('disables only the last ticked box: every other type can be chosen, whatever the provider is', () => {
    const html = field({ value: ['text'] });
    // Text (the last one ticked) cannot be cleared; images, audio, video and files can be ticked.
    const disabled = checkboxes(html).filter((tag) => tag.includes('disabled'));
    expect(disabled.length).toBe(1);
    expect(field({ value: ['text', 'image'] })).not.toContain('disabled');
  });

  it('speaks Turkish', () => {
    const html = field({ value: ['text'] }, 'tr');
    expect(html).toContain('Girdi türleri');
    expect(html).toContain('Görseller');
    expect(html).toContain('Elle ayarlandı');
    expect(html).toContain('Otomatik algıla');
  });
});

describe('strings', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const flatten = (node: unknown, path = ''): Array<[string, string]> =>
    typeof node === 'string'
      ? [[path, node]]
      : node && typeof node === 'object'
        ? Object.entries(node).flatMap(([key, value]) => flatten(value, path ? `${path}.${key}` : key))
        : [];
  const lookup = (language: typeof en | typeof tr, key: string) =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], language);

  const namespaces: Array<[string, unknown, unknown]> = [
    ['agents.attachments', en.agents.attachments, tr.agents.attachments],
    ['files', en.files, tr.files],
    ['modelWizard.fields.inputModalities', en.modelWizard.fields.inputModalities, tr.modelWizard.fields.inputModalities],
  ];

  it.each(namespaces)('%s has the same keys and placeholders in English and Turkish, none empty', (_name, english, turkish) => {
    const en_ = Object.fromEntries(flatten(english));
    const tr_ = Object.fromEntries(flatten(turkish));
    expect(Object.keys(tr_).sort()).toEqual(Object.keys(en_).sort());
    for (const key of Object.keys(en_)) {
      expect(tr_[key].trim(), key).not.toBe('');
      expect(placeholders(tr_[key]), key).toEqual(placeholders(en_[key]));
    }
  });

  it('translates the new strings rather than copying the English', () => {
    const same = (namespace: string, english: unknown, turkish: unknown) => {
      const t_ = Object.fromEntries(flatten(turkish));
      return flatten(english).filter(([key, text]) => t_[key] === text).map(([key]) => `${namespace}.${key}`);
    };
    // Words that are the same in both languages, or only a unit / MIME type.
    const allowed = new Set([
      'files.session.badge', 'modelWizard.fields.inputModalities.options.video',
    ]);
    const untranslated = [
      ...same('files', en.files, tr.files),
      ...same('modelWizard.fields.inputModalities', en.modelWizard.fields.inputModalities, tr.modelWizard.fields.inputModalities),
    ].filter((key) => !allowed.has(key));
    expect(untranslated).toEqual([]);
  });

  it('defines every key the Files components ask for, in both languages', () => {
    const files = [
      'components/agents/studio/AgentFilesPanel.tsx',
      'components/agents/session/SessionFilesPanel.tsx',
      'components/agents/session/SessionAttachments.tsx',
      'components/files/FileBrowseParts.tsx',
      'components/files/FileObjectManager.tsx',
      'components/files/FileBucketManager.tsx',
      'components/models/ModelInputModalitiesField.tsx',
      'app/dashboard/files/page.tsx',
    ];
    const missing: string[] = [];
    let checked = 0;
    for (const file of files) {
      const source = readFileSync(join(__dirname, '../..', file), 'utf8');
      const spaces: Record<string, string> = {};
      for (const match of source.matchAll(/const\s+(\w+)\s*=\s*useTranslations\('([\w.]+)'\)/g)) spaces[match[1]] = match[2];
      for (const match of source.matchAll(/\b(\w+)\(\s*'([\w.]+)'/g)) {
        const namespace = spaces[match[1]];
        if (!namespace) continue;
        checked += 1;
        const key = `${namespace}.${match[2]}`;
        for (const [name, language] of [['en', en], ['tr', tr]] as const) {
          if (typeof lookup(language, key) !== 'string') missing.push(`${file}: ${key} (${name})`);
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
    expect(missing).toEqual([]);
  });

  it('defines the Files section’s messages the agent page asks for', () => {
    const source = readFileSync(join(__dirname, '../../components/agents/AgentDetailPage.tsx'), 'utf8');
    const keys = [...source.matchAll(/\bt\('attachments\.(\w+)'/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(3);
    for (const key of keys) {
      expect(typeof lookup(en, `agents.attachments.${key}`), key).toBe('string');
      expect(typeof lookup(tr, `agents.attachments.${key}`), key).toBe('string');
    }
  });
});
