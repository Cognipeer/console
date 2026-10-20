/**
 * The code samples of the bucket's API tab: the client API (`/api/client/v1/files`) called from cURL, the
 * TypeScript SDK and Python, with the real host and this bucket's key filled in. Pure strings, so the shape of
 * every request is tested against the routes it documents (`clientApiRoutes` in `filesApi.ts`).
 *
 * Facts the samples rely on:
 * - an object's key is ONE path segment in the client API (its slashes are encoded);
 * - an upload sends the file as a base64 data URL in a JSON body; `keyHint` ending in `/` names a folder and the
 *   file keeps a generated unique name inside it, any other `keyHint` is the whole key;
 * - a Markdown copy is only made when `convertToMarkdown` is true (off by default on this API);
 * - the SDK's `files.list` takes `search`, `limit` and `cursor` only, so a folder listing calls the endpoint itself.
 */

import { clientApiRoutes } from '../filesApi';

export type ApiLanguage = 'curl' | 'typescript' | 'python';
export type ApiOperation = 'list' | 'listFolder' | 'upload' | 'uploadToFolder' | 'download' | 'delete';

export const API_LANGUAGES: readonly ApiLanguage[] = ['curl', 'typescript', 'python'];
export const API_OPERATIONS: readonly ApiOperation[] = ['list', 'listFolder', 'upload', 'uploadToFolder', 'download', 'delete'];

/** Shown until the page knows the host it is served from (and on the server render). */
export const PLACEHOLDER_ORIGIN = 'https://your-console-host';
export const TOKEN_PLACEHOLDER = 'YOUR_API_TOKEN';
/** The key the samples download and delete: the shape the server generates inside a folder. */
export const SAMPLE_FILE_KEY = 'reports/2026/report-1760000000000-a1b2c3d4.pdf';
export const SAMPLE_FOLDER = 'reports/2026/';

export interface SnippetContext {
  /** Scheme and host the console is served from (`window.location.origin`). */
  origin: string;
  bucketKey: string;
}

/** `https://host/api/client/v1`: what every route of the client API starts with. */
export function apiBaseUrl(origin: string): string {
  return `${trimOrigin(origin)}/api/client/v1`;
}

function trimOrigin(origin: string): string {
  return (origin.trim() || PLACEHOLDER_ORIGIN).replace(/\/+$/, '');
}

/** A single-quoted string literal for TypeScript. */
function ts(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** A double-quoted string literal for Python and the shell's JSON. */
function dq(value: string): string {
  return JSON.stringify(value);
}

function urlOf(context: SnippetContext, path: string): string {
  return `${trimOrigin(context.origin)}${path}`;
}

const lines = (...parts: string[]): string => parts.join('\n');

function curlSnippet(operation: ApiOperation, context: SnippetContext): string {
  const bucket = context.bucketKey;
  const objects = urlOf(context, clientApiRoutes.objects(bucket));
  const object = urlOf(context, clientApiRoutes.object(bucket, SAMPLE_FILE_KEY));
  const download = urlOf(context, clientApiRoutes.download(bucket, SAMPLE_FILE_KEY));
  const markdown = urlOf(context, clientApiRoutes.download(bucket, SAMPLE_FILE_KEY, 'markdown'));
  const auth = `-H "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;

  switch (operation) {
    case 'list':
      return lines(`curl "${objects}?limit=50" \\`, `  ${auth}`);
    case 'listFolder':
      return lines(
        `curl -G "${objects}" \\`,
        `  --data-urlencode "prefix=${SAMPLE_FOLDER}" \\`,
        '  --data-urlencode "limit=50" \\',
        `  ${auth}`,
      );
    case 'upload':
    case 'uploadToFolder': {
      const keyHint = operation === 'uploadToFolder' ? `, keyHint: "${SAMPLE_FOLDER}"` : '';
      return lines(
        '# The file travels as a base64 data URL inside the JSON body (needs jq).',
        "base64 < report.pdf | tr -d '\\n' \\",
        `  | jq -Rs '{fileName: "report.pdf", contentType: "application/pdf", convertToMarkdown: true${keyHint}, data: ("data:application/pdf;base64," + .)}' \\`,
        `  | curl -X POST "${objects}" \\`,
        `      ${auth} \\`,
        '      -H "Content-Type: application/json" \\',
        '      --data-binary @-',
      );
    }
    case 'download':
      return lines(
        `curl -L "${download}" \\`,
        `  ${auth} \\`,
        '  -o report.pdf',
        '',
        '# The Markdown copy of the file, when it has one',
        `curl -L "${markdown}" \\`,
        `  ${auth} \\`,
        '  -o report.md',
      );
    case 'delete':
      return lines(`curl -X DELETE "${object}" \\`, `  ${auth}`);
  }
}

function typescriptSnippet(operation: ApiOperation, context: SnippetContext): string {
  const bucket = ts(context.bucketKey);
  const origin = trimOrigin(context.origin);
  const setup = [
    "import { ConsoleClient } from '@cognipeer/console-sdk';",
    '',
    `const client = new ConsoleClient({ apiKey: process.env.API_TOKEN!, baseURL: ${ts(origin)} });`,
  ];

  switch (operation) {
    case 'list':
      return lines(
        ...setup,
        '',
        `const { files, count, nextCursor } = await client.files.list(${bucket}, { limit: 50 });`,
        `// The next page: client.files.list(${bucket}, { limit: 50, cursor: nextCursor ?? undefined })`,
      );
    case 'listFolder':
      return lines(
        "// The SDK's list helper has no folder option, so ask the endpoint for the folder directly.",
        `const url = new URL(${ts(urlOf(context, clientApiRoutes.objects(context.bucketKey)))});`,
        `url.searchParams.set('prefix', ${ts(SAMPLE_FOLDER)});`,
        "url.searchParams.set('limit', '50');",
        '',
        'const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } });',
        '// folders: the sub-folders of this folder; files: the files directly in it',
        'const { files, folders, nextCursor } = await response.json();',
      );
    case 'upload':
    case 'uploadToFolder':
      return lines(
        "import { readFile } from 'node:fs/promises';",
        ...setup,
        '',
        "const bytes = await readFile('report.pdf');",
        '',
        `const { file } = await client.files.upload(${bucket}, {`,
        "  fileName: 'report.pdf',",
        "  contentType: 'application/pdf',",
        '  data: `data:application/pdf;base64,${bytes.toString(\'base64\')}`,',
        ...(operation === 'uploadToFolder' ? [`  keyHint: ${ts(SAMPLE_FOLDER)}, // a trailing slash names a folder`] : []),
        '  convertToMarkdown: true,',
        '});',
        'console.log(file.key);',
      );
    case 'download':
      return lines(
        "import { writeFile } from 'node:fs/promises';",
        ...setup,
        '',
        `const { data, contentType } = await client.files.download(${bucket}, ${ts(SAMPLE_FILE_KEY)});`,
        "await writeFile('report.pdf', data);",
        '',
        '// The Markdown copy: GET the same address with ?variant=markdown (see the cURL sample).',
      );
    case 'delete':
      return lines(...setup, '', `await client.files.delete(${bucket}, ${ts(SAMPLE_FILE_KEY)});`);
  }
}

function pythonSnippet(operation: ApiOperation, context: SnippetContext): string {
  const bucket = context.bucketKey;
  const base = apiBaseUrl(context.origin);
  const objects = `f"{BASE}/files/buckets/${bucket}/objects"`;
  const setup = ['import httpx', '', `BASE = ${dq(base)}`, `HEADERS = {"Authorization": "Bearer ${TOKEN_PLACEHOLDER}"}`];

  switch (operation) {
    case 'list':
      return lines(
        ...setup,
        '',
        `page = httpx.get(${objects}, params={"limit": 50}, headers=HEADERS).json()`,
        '# page["files"], page["count"] and page.get("nextCursor") (pass it back as "cursor" for the next page)',
      );
    case 'listFolder':
      return lines(
        ...setup,
        '',
        `page = httpx.get(${objects}, params={"prefix": ${dq(SAMPLE_FOLDER)}, "limit": 50}, headers=HEADERS).json()`,
        '# page["folders"]: the sub-folders of this folder; page["files"]: the files directly in it',
      );
    case 'upload':
    case 'uploadToFolder':
      return lines(
        'import base64',
        ...setup,
        '',
        'with open("report.pdf", "rb") as handle:',
        '    encoded = base64.b64encode(handle.read()).decode()',
        '',
        'response = httpx.post(',
        `    ${objects},`,
        '    headers=HEADERS,',
        '    json={',
        '        "fileName": "report.pdf",',
        '        "contentType": "application/pdf",',
        ...(operation === 'uploadToFolder' ? [`        "keyHint": ${dq(SAMPLE_FOLDER)},  # a trailing slash names a folder`] : []),
        '        "convertToMarkdown": True,',
        '        "data": f"data:application/pdf;base64,{encoded}",',
        '    },',
        '    timeout=120,',
        ')',
        'print(response.json()["file"]["key"])',
      );
    case 'download':
      return lines(
        'from urllib.parse import quote',
        ...setup,
        '',
        `key = quote(${dq(SAMPLE_FILE_KEY)}, safe="")  # the key is one path segment`,
        `response = httpx.get(f"{BASE}/files/buckets/${bucket}/objects/{key}/download", headers=HEADERS)`,
        '# add params={"variant": "markdown"} for the Markdown copy',
        'open("report.pdf", "wb").write(response.content)',
      );
    case 'delete':
      return lines(
        'from urllib.parse import quote',
        ...setup,
        '',
        `key = quote(${dq(SAMPLE_FILE_KEY)}, safe="")`,
        `httpx.delete(f"{BASE}/files/buckets/${bucket}/objects/{key}", headers=HEADERS)`,
      );
  }
}

/** The request line of an operation (`GET /api/client/v1/...`); the object's key is the `{key}` placeholder. */
export function routeOf(operation: ApiOperation, bucketKey: string): string {
  const objects = clientApiRoutes.objects(bucketKey);
  switch (operation) {
    case 'list':
    case 'listFolder':
      return `GET ${objects}`;
    case 'upload':
    case 'uploadToFolder':
      return `POST ${objects}`;
    case 'download':
      return `GET ${objects}/{key}/download`;
    case 'delete':
      return `DELETE ${objects}/{key}`;
  }
}

/** The sample for one operation in one language. */
export function buildSnippet(operation: ApiOperation, language: ApiLanguage, context: SnippetContext): string {
  if (language === 'curl') return curlSnippet(operation, context);
  if (language === 'typescript') return typescriptSnippet(operation, context);
  return pythonSnippet(operation, context);
}

/** An abridged answer of an upload: the fields a caller usually reads. */
export function uploadResponseExample(bucketKey: string): string {
  return JSON.stringify(
    {
      file: {
        bucketKey,
        key: SAMPLE_FILE_KEY,
        name: 'report.pdf',
        size: 4823014,
        contentType: 'application/pdf',
        markdownStatus: 'succeeded',
        createdAt: '2026-10-19T10:30:00.000Z',
      },
      message: 'File uploaded successfully',
    },
    null,
    2,
  );
}

/** An abridged answer of a folder listing. */
export function listResponseExample(): string {
  return JSON.stringify(
    {
      count: 1,
      files: [{ key: SAMPLE_FILE_KEY, name: 'report.pdf', size: 4823014, contentType: 'application/pdf' }],
      folders: [`${SAMPLE_FOLDER}drafts/`],
      prefix: SAMPLE_FOLDER,
      nextCursor: null,
    },
    null,
    2,
  );
}
