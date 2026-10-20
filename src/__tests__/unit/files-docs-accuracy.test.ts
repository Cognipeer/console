/**
 * Unit tests - the Files pages say what the code does
 *
 * The Files guide, the Files API page, the OpenAPI document, the provider pages and the CHANGELOG repeat the codes,
 * headers, limits and rules the routes answer with. A page that is not updated with a change is how a reader meets a
 * refusal the page never mentioned. This holds the pages to the code: statuses, codes, messages, header names and
 * limits are read from the code (`composeUploadKeyHint`, `setFileDownloadHeaders`, `sendProviderConfigError`,
 * `assertWithinReadCeiling`, the local filesystem contract, ...) instead of being typed again here, and each page is
 * searched for what the code produces.
 *
 * What the routes answer is pinned by the API tests (`client-files-errors-and-headers`, `files-errors-and-headers`,
 * `files-session-visibility-real-stack`, `provider-config-errors`). Here the pages are read as text and searched for
 * tokens - a status with its code, a header name, an environment variable, a number. The wording around them is not
 * compared, and neither are the pictures (a screenshot is only right when it is retaken from a running server).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyReply } from 'fastify';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { filesBucketEn } from '@/lib/i18n/messages/filesBucket.en';
import { LocalFileProviderContract } from '@/lib/providers/contracts/localFile.contract';
import { PROVIDER_KEY_EXISTS, ProviderKeyExistsError, ProviderSettingsError } from '@/lib/providers/errors';
import { isSafePathSegment } from '@/lib/providers/pathSegments';
import { StorageInvalidKeyError } from '@/lib/providers/contracts/storageLimits';
import { bucketInactiveError, FileServiceError } from '@/lib/services/files/errors';
import {
  assertWithinReadCeiling,
  composeUploadKeyHint,
  FILE_RUNTIME_POOL_PREFIX,
  generateFileRelativeKey,
} from '@/lib/services/files/fileService';
import { bucketHoldsSourcesBody } from '@/lib/services/files/knowledgeSources';
import { describeFileError, setFileDownloadHeaders } from '@/server/api/fileHttp';
import { sendProviderConfigError } from '@/server/api/providerConfigErrors';

const ROOT = path.resolve(__dirname, '../../..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

// ── Reading the pages ─────────────────────────────────────────────────────

/** Line breaks and runs of space read as one space, so a token wrapped over two lines is still found. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/**
 * The text under a heading (the heading line included), up to the next heading of the same or a higher level.
 * Lines inside a code fence are never headings.
 */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) throw new Error(`The page has no heading "${heading}".`);
  const level = /^#+/.exec(heading)![0].length;
  let fenced = false;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trimStart().startsWith('```')) fenced = !fenced;
    const next = !fenced ? /^(#+)\s/.exec(lines[index]) : null;
    if (next && next[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** The cells of every row of the tables in a block of Markdown (the header row included, the divider row not). */
function tableRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .filter((line) => /^\|.*\|\s*$/.test(line))
    .map((line) => line.trim().slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
}

/** The JSON examples (```json fences) of a block of Markdown. */
function jsonExamples(markdown: string): unknown[] {
  return [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]) as unknown);
}

/** What the CHANGELOG lists as merged and not yet released. */
function unreleased(changelog: string): string {
  const start = changelog.indexOf('\n## Unreleased');
  if (start < 0) throw new Error('The CHANGELOG has no "Unreleased" section.');
  const rest = changelog.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next < 0 ? rest : rest.slice(0, next);
}

/** `expect` with a message that names the page and the token it should hold. */
function expectMention(page: string, text: string, token: string | RegExp): void {
  const found = typeof token === 'string' ? flat(text).includes(token) : token.test(flat(text));
  expect(found, `${page} should mention ${String(token)}`).toBe(true);
}

/** A walk down an OpenAPI document by key; undefined when a step is missing. */
function at(root: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (node, key) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
    root,
  );
}
const textAt = (root: unknown, ...keys: string[]): string => {
  const value = at(root, ...keys);
  return typeof value === 'string' ? value : '';
};

const API = read('docs/api/files.md');
const GUIDE = read('docs/guide/files.md');
const POOL = read('docs/guide/core-runtime-pool.md');
const PROVIDERS = read('docs/guide/providers.md');
const DEPLOYMENT = read('docs/guide/deployment.md');
const CONFIGURATION = read('docs/guide/configuration.md');
const CHANGES = unreleased(read('CHANGELOG.md'));
const SPEC = parse(read('openapi.yaml')) as unknown;

const OBJECTS = '/files/buckets/{bucketKey}/objects';
const OBJECT = '/files/buckets/{bucketKey}/objects/{objectKey}';
const DOWNLOAD = `${OBJECT}/download`;
const PROVIDERS_ROUTE = '/files/providers';

// ── What the code answers ─────────────────────────────────────────────────

/** The status and body `sendProviderConfigError` answers a provider create with. */
function providerAnswer(error: unknown): { status?: number; body?: unknown } {
  const answer: { status?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      answer.status = status;
      return reply;
    },
    send(body: unknown) {
      answer.body = body;
      return reply;
    },
  };
  sendProviderConfigError(reply as unknown as FastifyReply, error);
  return answer;
}

/** The headers a download is given, as `setFileDownloadHeaders` sets them. */
function downloadHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const reply = {
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
  };
  setFileDownloadHeaders(reply as unknown as FastifyReply, 'report.pdf');
  return headers;
}

/** The refusal of an object larger than the server reads at once. */
function tooLargeToRead(): FileServiceError {
  try {
    assertWithinReadCeiling(Number.MAX_SAFE_INTEGER);
  } catch (error) {
    return error as FileServiceError;
  }
  throw new Error('An object of any size was accepted.');
}

/** How many characters the `X-File-Metadata` header carries at most, as the client Files API source declares it. */
function metadataHeaderCap(): number {
  const declared = /const FILE_METADATA_HEADER_MAX_CHARS = (\d+)(?: \* (\d+))?;/.exec(read('src/server/api/plugins/client-files.ts'));
  if (!declared) throw new Error('FILE_METADATA_HEADER_MAX_CHARS is not declared in client-files.ts any more.');
  return Number(declared[1]) * Number(declared[2] ?? 1);
}

/** The refusals of the local filesystem driver, by the settings that cause them. */
function localDiskRefusals(): Array<{ settings: Record<string, unknown>; isOnPrem: boolean; allowHostPaths: boolean }> {
  return [
    { settings: { basePath: '/srv/files' }, isOnPrem: false, allowHostPaths: true },
    { settings: { basePath: '/srv/files' }, isOnPrem: true, allowHostPaths: false },
    { settings: { subdirectory: '../files' }, isOnPrem: true, allowHostPaths: true },
    { settings: { subdirectory: '/files' }, isOnPrem: true, allowHostPaths: true },
    { settings: { subdirectory: 'C:\\files' }, isOnPrem: true, allowHostPaths: true },
  ];
}

function localDiskRefusalOf(input: { settings: Record<string, unknown>; isOnPrem: boolean; allowHostPaths: boolean }): ProviderSettingsError {
  try {
    void LocalFileProviderContract.validateSettings!({ credentials: {}, ...input });
  } catch (error) {
    if (error instanceof ProviderSettingsError) return error;
    throw error;
  }
  throw new Error(`The local filesystem driver accepted ${JSON.stringify(input)}.`);
}

// ── The Files API page ────────────────────────────────────────────────────

describe('the Files API page: keys', () => {
  const refusedHints: unknown[] = [
    'reports/../secret',
    'reports/./q3',
    'reports/\u0007q3',
    'reports/\ud83dq3',
    'reports/\ude00q3',
    42,
    'x'.repeat(513),
  ];

  it('quotes every message the code gives for a keyHint it refuses', () => {
    const messages = new Set(
      refusedHints.map((keyHint) => {
        const answer = composeUploadKeyHint({ keyHint });
        return 'error' in answer ? answer.error : undefined;
      }),
    );
    expect(messages.has(undefined)).toBe(false);
    // dot segments, control characters, an unpaired surrogate, a value that is not text and a value that is too long
    expect(messages.size).toBe(5);
    for (const message of messages) expectMention('The Files API page', API, message as string);
  });

  it('gives the limits of a generated name and of a keyHint that the code applies', () => {
    const generated = generateFileRelativeKey(`${'a'.repeat(300)}.pdf`);
    const longExtension = generateFileRelativeKey(`a.${'e'.repeat(60)}`);
    const extensionBytes = Buffer.byteLength(longExtension.slice(longExtension.indexOf('.')));
    const nameBytes = Buffer.byteLength(generated);
    expect(nameBytes).toBe(200);
    expect(extensionBytes).toBe(32);

    for (const [page, text] of [['The Files API page', API], ['The CHANGELOG', CHANGES]] as const) {
      expectMention(page, text, `${nameBytes} bytes`);
      expectMention(page, text, `${extensionBytes} bytes`);
    }
    expectMention('The Files API page', API, 'at most 512 characters');
  });

  it('says what a key the store cannot hold is answered with', () => {
    const answer = describeFileError(new StorageInvalidKeyError());
    const token = `\`${answer.status} ${answer.body.code}\``;
    expectMention('The Files API page', API, token);
    expectMention('The CHANGELOG', CHANGES, token);
    expectMention('The OpenAPI upload call', textAt(SPEC, 'paths', OBJECTS, 'post', 'responses', String(answer.status), 'description'), String(answer.body.code));
  });
});

describe('the Files API page: providers', () => {
  it('answers a taken provider key with the status and code the code gives', () => {
    const taken = new ProviderKeyExistsError('minio-archive');
    const answer = providerAnswer(taken);
    expect(typeof answer.status).toBe('number');
    expect(answer.body).toEqual({ error: taken.message, code: PROVIDER_KEY_EXISTS });

    const created = section(API, '### Create a file provider');
    expectMention('The create-provider section', created, `\`${answer.status}\` with \`code: "${PROVIDER_KEY_EXISTS}"\``);
    expect(created).toContain(JSON.stringify(taken.message));
    expect(created).toContain(`"code": "${PROVIDER_KEY_EXISTS}"`);
    expectMention('The CHANGELOG', CHANGES, `\`${answer.status} ${PROVIDER_KEY_EXISTS}\``);
    expectMention('The providers guide', PROVIDERS, `\`${answer.status}\` with \`code: "${PROVIDER_KEY_EXISTS}"\``);
  });

  it('says the key is one name for a folder, with the field the code names', () => {
    for (const key of ['.', '..', 'a/b', 'a\\b', 'a\u0001b', '']) expect(isSafePathSegment(key), JSON.stringify(key)).toBe(false);
    expect(isSafePathSegment('minio-archive')).toBe(true);

    const created = flat(section(API, '### Create a file provider'));
    expect(created).toContain('not `.` or `..`');
    expect(created).toContain('no `/`, `\\` or control character');
    expect(created).toContain('`400 provider_settings_invalid`, `field` `key`');
  });

  it('describes the local filesystem settings the way the driver validates them', () => {
    const fields = new Set(localDiskRefusals().map((input) => localDiskRefusalOf(input).field));
    expect([...fields].sort()).toEqual(['basePath', 'subdirectory']);
    // the base directory is accepted from an owner or an admin of a self-hosted install, a relative subdirectory inside it
    expect(() => LocalFileProviderContract.validateSettings!({
      credentials: {},
      settings: { basePath: '/srv/files', subdirectory: 'console/files' },
      isOnPrem: true,
      allowHostPaths: true,
    })).not.toThrow();

    const created = flat(section(API, '### Create a file provider'));
    const local = flat(section(GUIDE, '### Local filesystem'));
    for (const field of fields) {
      expect(created, `the API page names the field ${field}`).toContain(`\`${field}\``);
      expect(created).toContain(`\`field\` \`${field}\``);
    }
    for (const [page, text] of [['The Files API page', created], ['The guide', local]] as const) {
      expectMention(page, text, 'DEPLOYMENT_MODE=onprem');
      expectMention(page, text, /owner or an admin/);
      expectMention(page, text, /delegating token/);
      expectMention(page, text, 'no `..`');
    }
    expectMention('The guide', local, '**Base directory**');
    expectMention('The guide', local, '**Subdirectory**');
    expectMention('The guide', local, '`502 storage_failure`');
  });

  it('is repeated by the providers guide, the OpenAPI document and the CHANGELOG', () => {
    expectMention('The providers guide', PROVIDERS, '`allowHostPaths`');
    expectMention('The providers guide', PROVIDERS, `\`code: "${PROVIDER_KEY_EXISTS}"\``);
    expectMention('The providers guide', PROVIDERS, '`provider_settings_invalid`');

    const key = textAt(SPEC, 'components', 'schemas', 'FileCreateProviderRequest', 'properties', 'key', 'description');
    expectMention('The OpenAPI provider key', key, PROVIDER_KEY_EXISTS);
    expectMention('The OpenAPI provider key', key, 'provider_settings_invalid');
    const settings = textAt(SPEC, 'components', 'schemas', 'FileCreateProviderRequest', 'properties', 'settings', 'description');
    expectMention('The OpenAPI provider settings', settings, '`local-filesystem`');
    expectMention('The OpenAPI provider settings', settings, '`basePath`');
    expectMention('The OpenAPI provider settings', settings, '`subdirectory`');

    const create = textAt(SPEC, 'paths', PROVIDERS_ROUTE, 'post', 'description');
    expectMention('The OpenAPI create-provider call', create, PROVIDER_KEY_EXISTS);
    const conflict = at(SPEC, 'paths', PROVIDERS_ROUTE, 'post', 'responses', '409', 'content', 'application/json', 'example');
    expect(conflict).toEqual({ error: new ProviderKeyExistsError('minio-archive').message, code: PROVIDER_KEY_EXISTS });

    expectMention('The CHANGELOG', CHANGES, '`400 provider_settings_invalid`, `field: "key"`');
    expectMention('The CHANGELOG', CHANGES, '**Base directory**');
    expectMention('The CHANGELOG', CHANGES, '**Subdirectory**');
  });
});

describe('the Files API page: downloads', () => {
  it('lists every header the code sets on a download, in the page and in the OpenAPI document', () => {
    const headers = downloadHeaders();
    expect(Object.keys(headers)).toContain('Cache-Control');

    const rows = tableRows(section(API, '### Download a file'));
    const documented = new Map(rows.map(([name, value]) => [name.replace(/`/g, ''), value]));
    const specified = at(SPEC, 'paths', DOWNLOAD, 'get', 'responses', '200', 'headers') as Record<string, unknown>;
    for (const name of [...Object.keys(headers), 'X-File-Metadata']) {
      expect(documented.has(name), `The Files API page should list the header ${name}`).toBe(true);
      expect(Object.keys(specified), `The OpenAPI document should list the header ${name}`).toContain(name);
    }
    expect(documented.get('Cache-Control')).toContain(headers['Cache-Control']);
    expect(textAt(specified, 'Cache-Control', 'description')).toContain(headers['Cache-Control']);
    expectMention('The CHANGELOG', CHANGES, `Cache-Control: ${headers['Cache-Control']}`);
    expectMention('The OpenAPI download call', textAt(SPEC, 'paths', DOWNLOAD, 'get', 'description'), 'Cache-Control');
  });

  it('gives the size above which the metadata header is left out', () => {
    const cap = metadataHeaderCap().toLocaleString('en-US');
    const row = tableRows(section(API, '### Download a file')).find(([name]) => name === '`X-File-Metadata`');
    expectMention('The X-File-Metadata row of the Files API page', row?.[1] ?? '', cap);
    expectMention('The OpenAPI X-File-Metadata header', textAt(SPEC, 'paths', DOWNLOAD, 'get', 'responses', '200', 'headers', 'X-File-Metadata', 'description'), cap);
    expectMention('The CHANGELOG', CHANGES, cap);
  });

  it('refuses an object larger than the server reads at once with the status and code the code gives', () => {
    const refusal = tooLargeToRead();
    const answer = describeFileError(refusal);
    expect(answer.status).toBe(refusal.status);
    expect(answer.body.code).toBe(refusal.code);

    const row = tableRows(section(API, '## Errors')).find(([status, code]) => status === String(refusal.status) && code.includes(`\`${refusal.code}\``));
    expect(row, `The Errors table should have a ${refusal.status} row for ${refusal.code}`).toBeDefined();
    expectMention('The CHANGELOG', CHANGES, `\`${refusal.status} ${refusal.code}\``);
    expectMention('The guide', GUIDE, `\`${refusal.status} ${refusal.code}\``);
    expect(at(SPEC, 'paths', DOWNLOAD, 'get', 'responses', String(refusal.status), '$ref')).toBeDefined();
  });
});

describe('the Files API page: errors', () => {
  const errorRows = tableRows(section(API, '## Errors'));
  const documents = (status: number, code: string): boolean =>
    errorRows.some(([cell, codes]) => cell === String(status) && codes.split(',').map((part) => part.trim()).includes(`\`${code}\``));

  it('has a row for each refusal a client of the Files API switches on', () => {
    const inactive = bucketInactiveError();
    const pairs: Array<[number, string]> = [
      [inactive.status, inactive.code],
      [tooLargeToRead().status, tooLargeToRead().code],
      [providerAnswer(new ProviderKeyExistsError('docs')).status as number, PROVIDER_KEY_EXISTS],
      // the refusals about a session's file come from the session permission check; the API tests pin their wire form
      [403, 'session_forbidden'],
      [503, 'authorization_unavailable'],
    ];
    for (const [status, code] of pairs) expect(documents(status, code), `${status} ${code}`).toBe(true);
  });

  it('says that the refusals about a session file are in the nested form and the gate answers are flat', () => {
    const intro = flat(section(API, '## Errors'));
    expect(intro).toContain('`session_forbidden`');
    expect(intro).toContain('`authorization_unavailable`');
    expect(intro).toMatch(/nested form `\{ "error": \{ "type": "…", "message": "…", "code": "…" \} \}`/);
    const unavailable = errorRows.find(([status, code]) => status === '503' && code.includes('`authorization_unavailable`'));
    expect(unavailable?.[2]).toMatch(/nested form/);
    expect(unavailable?.[2]).toMatch(/flat/);
    expect(unavailable?.[2]).toContain('Retry-After');
  });
});

describe('the Files API page: session files', () => {
  const session = section(API, '## Session files');

  it('shows the refusal in the nested form, with a sentence the code sends', () => {
    const [example] = jsonExamples(session) as Array<{ error: { type: string; message: string; code: string; decision_id: string } }>;
    expect(example.error.type).toBe('permission_error');
    expect(example.error.code).toBe('session_forbidden');
    expect(typeof example.error.decision_id).toBe('string');
    expect(read('src/server/api/plugins/agent-session-access.ts')).toContain(example.error.message);
  });

  it('names what each kind of call needs and where the refusal is explained', () => {
    const text = flat(session);
    expect(text).toContain('`403 session_forbidden`');
    expect(text).toContain('`503 authorization_unavailable`');
    expect(text).toMatch(/uploading to its key/);
    expect(text).toContain('(/guide/session-files)');
    expect(text).toContain('(/guide/agent-sessions#who-sees-a-session)');
  });
});

// ── The OpenAPI document ──────────────────────────────────────────────────

describe('the OpenAPI document: Files', () => {
  it('describes the Markdown copy fields as they behave', () => {
    const key = textAt(SPEC, 'components', 'schemas', 'FileObject', 'properties', 'markdownKey', 'description');
    for (const status of ['pending', 'failed', 'skipped']) expectMention('The OpenAPI markdownKey', key, `\`${status}\``);
    expectMention('The OpenAPI markdownKey', key, 'variant=markdown');

    const row = tableRows(API).find(([name]) => name.startsWith('`markdownKey`'));
    expect(row, 'The Files API page should describe markdownKey').toBeDefined();
    for (const status of ['pending', 'failed', 'skipped']) expectMention('The markdownKey row', row?.[1] ?? '', `\`${status}\``);
    expectMention('The markdownKey row', row?.[1] ?? '', 'variant=markdown');
  });

  it('declares the session refusal on every call that checks a session file', () => {
    for (const [route, method] of [[OBJECTS, 'post'], [OBJECT, 'get'], [OBJECT, 'delete'], [DOWNLOAD, 'get']] as const) {
      expect(at(SPEC, 'paths', route, method, 'responses', '403', '$ref'), `${method} ${route}`).toBe('#/components/responses/SessionForbidden');
    }
    expectMention('The SessionForbidden response', textAt(SPEC, 'components', 'responses', 'SessionForbidden', 'description'), 'Files API');
  });

  it('declares the answer for a permission check that could not decide', () => {
    for (const [route, method, response] of [
      [OBJECTS, 'get', 'AuthorizationUnavailable'],
      [OBJECT, 'get', 'AuthorizationUnavailable'],
      [OBJECTS, 'post', 'FileStorageUnavailable'],
      [OBJECT, 'delete', 'FileStorageUnavailable'],
      [DOWNLOAD, 'get', 'FileStorageUnavailable'],
    ] as const) {
      expect(at(SPEC, 'paths', route, method, 'responses', '503', '$ref'), `${method} ${route}`).toBe(`#/components/responses/${response}`);
    }
    const unavailable = at(SPEC, 'components', 'responses', 'FileStorageUnavailable');
    expectMention('The FileStorageUnavailable response', textAt(unavailable, 'description'), 'authorization_unavailable');
    expect(at(unavailable, 'headers', 'Retry-After')).toBeDefined();
    const example = at(unavailable, 'content', 'application/json', 'examples', 'authorization', 'value', 'error') as Record<string, string>;
    expect(example.code).toBe('authorization_unavailable');
    expect(read('src/server/api/plugins/agent-session-access.ts')).toContain(example.message);
  });

  it('describes the keyHint rules the code applies', () => {
    const upload = at(SPEC, 'components', 'schemas', 'FileUploadRequest', 'properties', 'keyHint', 'description');
    expectMention('The OpenAPI keyHint', String(upload), 'unpaired surrogates');
    expectMention('The OpenAPI keyHint', String(upload), '`session_forbidden`');
    expectMention('The OpenAPI upload call', textAt(SPEC, 'paths', OBJECTS, 'post', 'responses', '400', 'description'), 'invalid_request');
    expectMention('The OpenAPI upload call', textAt(SPEC, 'paths', OBJECTS, 'post', 'responses', '400', 'description'), 'unpaired surrogates');
  });
});

// ── The guide, the runtime pool page and the deployment page ──────────────

describe('the Files guide', () => {
  it('says that the delete refusals include a Knowledge Engine module, as the code words it', () => {
    const body = bucketHoldsSourcesBody('docs', [{ key: 'kb', name: 'Knowledge base' }]);
    expect(body.code).toBe('bucket_in_use');
    expect(body.error).toContain('Knowledge Engine module');
    expect(body.modules).toEqual([{ key: 'kb', name: 'Knowledge base' }]);

    const deleting = flat(section(GUIDE, '### Deleting files and buckets'));
    expect(deleting).toMatch(/Knowledge Engine module[^.]*\(`409 bucket_in_use`, with the modules named\)/);
    expect(deleting).toContain('Delete the bucket only');
    expect(deleting).toContain('`409 storage_location_shared`');
    expectMention('The CHANGELOG', CHANGES, /Knowledge Engine module keeps the sources/);
  });

  it('names the buttons of the delete dialog as the console labels them, and the way out of a stuck deletion', () => {
    const deleting = flat(section(GUIDE, '### Deleting files and buckets'));
    const { danger, delete: dialog } = filesBucketEn;
    for (const label of [danger.button, danger.buttonAgain, dialog.deleteAgain, dialog.bucketOnly, dialog.withFilesSome]) {
      expectMention('The delete section', deleting, `**${label}**`);
    }
    // asking again is refused for a shared folder; deleting the bucket only is then the way out
    expectMention(
      'The delete section',
      deleting,
      /refused because another bucket keeps files in the same folder \(`409 storage_location_shared`\)[^.]*\*\*Delete the bucket only\*\* is the way out/,
    );
    expectMention('The CHANGELOG', CHANGES, /\*\*Delete the bucket only\*\* is the way out of a deletion that seems stuck/);
  });

  it('says that a restart queues an interrupted deletion again, for as many buckets as the code does', () => {
    const declared = /const BOOT_RESUME_MAX = (\d+);/.exec(read('src/server/resumeDeletingFileBuckets.ts'));
    if (!declared) throw new Error('BOOT_RESUME_MAX is not declared in resumeDeletingFileBuckets.ts any more.');
    const deleting = flat(section(GUIDE, '### Deleting files and buckets'));
    expectMention('The delete section', deleting, `up to ${declared[1]} per start`);
    expectMention('The delete section', deleting, /when the console starts it queues the deletion again/);
    expectMention('The CHANGELOG', CHANGES, /the console queues again at start when a restart interrupted it/);
  });

  it('says that a bucket prefix is fixed once the bucket holds files', () => {
    expectMention('The bucket settings', section(GUIDE, '### Bucket settings'), '`409 prefix_locked`');
    expectMention('The CHANGELOG', CHANGES, '`409 prefix_locked`');
  });

  it('says that a switched-off bucket is read-only', () => {
    const inactive = bucketInactiveError();
    expectMention('The CHANGELOG', CHANGES, `\`${inactive.status} ${inactive.code}\``);
    expectMention('The Files API page', section(API, '### Download a file'), 'A disabled bucket still gives its files back');
  });

  it('describes the steps of Test connection as the drivers run them', () => {
    const testing = section(GUIDE, '## Testing a connection');
    expectMention('The Test connection section', testing, /no step follows/);
    expectMention('The Test connection section', testing, /Read back\*\*[^.]*Delete\*\*[^.]*still runs/);
    const rows = tableRows(testing);
    const list = rows.find(([step]) => step === '**List**')?.[1] ?? '';
    const write = rows.find(([step]) => step.startsWith('**Write'))?.[1] ?? '';
    // the S3 drivers create a missing bucket in the list step; Azure creates the container with the first upload
    expectMention('The List row', list, /S3-compatible or Amazon S3 bucket/);
    expectMention('The List row', list, /Azure Blob nothing is created here/);
    expectMention('The List row', list, /first upload/);
    expectMention('The Write row', write, /Azure container[^.]*created here, by the upload/);
  });

  it('puts the hosted-service switch of MONGODB_SINGLE_DATABASE where the deployment mode is set', () => {
    const rule = flat(section(CONFIGURATION, '### Deployment mode'));
    expect(rule).toContain('`MONGODB_SINGLE_DATABASE`');
    for (const [page, text] of [
      ['The Files guide', section(GUIDE, '## Which endpoints a provider may use')],
      ['The deployment page', DEPLOYMENT],
    ] as const) {
      expectMention(page, text, '`MONGODB_SINGLE_DATABASE=false`');
      expectMention(page, text, '(/guide/configuration#deployment-mode)');
    }
    expectMention('The CHANGELOG', CHANGES, '`MONGODB_SINGLE_DATABASE=false`');
  });

  it('does not tell that skipping TLS verification is for self-hosted installations only', () => {
    for (const [page, text] of [['The Files guide', GUIDE], ['The providers guide', PROVIDERS], ['The Files API page', API]] as const) {
      expect(/Skip TLS verification[^|\n]*\|[^|\n]*\|\s*Self-hosted installations only/i.test(text), page).toBe(false);
    }
  });

  it('keeps the limits of a keyHint in step with the code', () => {
    const limits = tableRows(section(GUIDE, '## Limits'));
    const hint = limits.find(([limit]) => limit.startsWith('Folder or key hint'));
    expectMention('The limits table', hint?.[1] ?? '', '512 characters');
    expectMention('The limits table', hint?.[1] ?? '', 'no unpaired surrogates');
  });
});

describe('the runtime pool page', () => {
  it('uses the key the file service pools its runtimes under', () => {
    expect(FILE_RUNTIME_POOL_PREFIX).toBe('file-runtime:');
    expect(POOL).toContain(`${FILE_RUNTIME_POOL_PREFIX}\${tenantId}:\${record.key}`);
    expect(POOL).toContain(`${FILE_RUNTIME_POOL_PREFIX}<tenantId>:<providerKey>`);
    expect(POOL).not.toMatch(/`file:(\$\{tenantId\}|<tenantId>)/);
  });
});

// ── The CHANGELOG ─────────────────────────────────────────────────────────

describe('the CHANGELOG', () => {
  it('lists what changed for a client of the Files API', () => {
    const refusal = tooLargeToRead();
    const tokens = [
      `${bucketInactiveError().status} ${bucketInactiveError().code}`,
      `${refusal.status} ${refusal.code}`,
      `${providerAnswer(new ProviderKeyExistsError('docs')).status} ${PROVIDER_KEY_EXISTS}`,
      '403 session_forbidden',
      `${describeFileError(new StorageInvalidKeyError()).status} invalid_request`,
      'unpaired surrogate',
      'Cache-Control: private, no-store',
    ];
    for (const token of tokens) expectMention('The CHANGELOG', CHANGES, token);
  });

  it('links the new sections to pages that have them', () => {
    const anchors = [...CHANGES.matchAll(/\(docs\/(guide|api)\/(files)\.md#([a-z0-9-]+)\)/g)];
    expect(anchors.length).toBeGreaterThan(0);
    for (const [, folder, name, anchor] of anchors) {
      const headings = read(`docs/${folder}/${name}.md`)
        .split('\n')
        .filter((line) => /^#{1,6}\s/.test(line))
        .map((line) => line.replace(/^#+\s+/, '').trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'));
      expect(headings, `docs/${folder}/${name}.md#${anchor}`).toContain(anchor);
    }
  });
});
