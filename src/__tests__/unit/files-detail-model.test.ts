/**
 * The rules of the file drawer without a DOM: which preview a file gets, how its origin and checksum are named,
 * how much text is drawn, and the API snippets, which must stay inert when a key is pasted into a shell.
 * (The drawer itself is in files-detail-ui.test.ts.)
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PREVIEW_MAX_BYTES } from '@/components/files/shared';
import {
  apiSnippets,
  baseNameOfKey,
  bucketLockOf,
  capText,
  checksumKind,
  DETAIL_TABS,
  folderOfKey,
  originOf,
  PREVIEW_TEXT_CHARS,
  previewPlanOf,
  shellSafeUrl,
} from '@/components/files/detail/detailModel';

describe('keys', () => {
  it('splits a key into its folder and its last segment', () => {
    expect(folderOfKey('reports/2026/q3.pdf')).toBe('reports/2026/');
    expect(folderOfKey('q3.pdf')).toBe('');
    expect(folderOfKey('a/')).toBe('a/');
    expect(baseNameOfKey('reports/2026/q3.pdf')).toBe('q3.pdf');
    expect(baseNameOfKey('q3.pdf')).toBe('q3.pdf');
    expect(baseNameOfKey('folder/')).toBe('folder/');
  });

  it('has the three tabs in the order of the wireframe', () => {
    expect(DETAIL_TABS).toEqual(['preview', 'markdown', 'details']);
  });
});

describe('a bucket that takes no changes', () => {
  it('lets an active bucket be changed', () => {
    expect(bucketLockOf({ status: 'active' })).toBeNull();
    expect(bucketLockOf({ status: 'active', deleting: false })).toBeNull();
  });

  it('locks a disabled bucket, and tells a bucket that is being deleted apart', () => {
    expect(bucketLockOf({ status: 'disabled' })).toBe('disabled');
    expect(bucketLockOf({ status: 'disabled', deleting: true })).toBe('deleting');
    // Being deleted wins whatever the status says.
    expect(bucketLockOf({ status: 'active', deleting: true })).toBe('deleting');
  });

  it('treats a bucket that names no status as one that cannot be changed', () => {
    expect(bucketLockOf({})).toBe('disabled');
  });
});

describe('origin and checksum', () => {
  it('reads a record that names no origin as an upload', () => {
    expect(originOf({})).toBe('upload');
    expect(originOf({ origin: null })).toBe('upload');
    expect(originOf({ origin: 'agent_output' })).toBe('agent_output');
    expect(originOf({ origin: 'import' })).toBe('import');
    expect(originOf({ origin: 'something-new' })).toBe('upload');
  });

  it('calls 64 hex digits a SHA-256 and anything else a checksum', () => {
    expect(checksumKind('a'.repeat(64))).toBe('sha256');
    expect(checksumKind(`  ${'F0'.repeat(32)} `)).toBe('sha256');
    expect(checksumKind('d41d8cd98f00b204e9800998ecf8427e')).toBe('other');
    expect(checksumKind('g'.repeat(64))).toBe('other');
    expect(checksumKind('')).toBe('other');
  });
});

describe('previewPlanOf', () => {
  it('previews what the server serves inline, by content type', () => {
    expect(previewPlanOf({ contentType: 'image/png', size: 10 })).toEqual({ kind: 'image' });
    expect(previewPlanOf({ contentType: 'IMAGE/JPEG; q=1', size: 10 })).toEqual({ kind: 'image' });
    expect(previewPlanOf({ contentType: 'application/pdf', size: 10 })).toEqual({ kind: 'pdf' });
    for (const type of ['text/plain', 'text/markdown', 'text/csv', 'application/json']) {
      expect(previewPlanOf({ contentType: type, size: 10 }), type).toEqual({ kind: 'text' });
    }
  });

  it('has no preview for the rest, and says whether it is the type or the size', () => {
    expect(previewPlanOf({ contentType: 'image/svg+xml', size: 10 })).toEqual({ kind: 'none', reason: 'type' });
    expect(previewPlanOf({ contentType: 'application/zip', size: 10 })).toEqual({ kind: 'none', reason: 'type' });
    expect(previewPlanOf({ contentType: undefined, size: 10 })).toEqual({ kind: 'none', reason: 'type' });
    expect(previewPlanOf({ contentType: 'application/pdf', size: PREVIEW_MAX_BYTES })).toEqual({ kind: 'pdf' });
    expect(previewPlanOf({ contentType: 'application/pdf', size: PREVIEW_MAX_BYTES + 1 })).toEqual({ kind: 'none', reason: 'size' });
    expect(previewPlanOf({ contentType: 'application/zip', size: PREVIEW_MAX_BYTES + 1 })).toEqual({ kind: 'none', reason: 'type' });
  });
});

describe('capText', () => {
  it('leaves a short text alone', () => {
    expect(capText('abc')).toEqual({ text: 'abc', total: 3, truncated: false });
    expect(capText('a'.repeat(PREVIEW_TEXT_CHARS)).truncated).toBe(false);
  });

  it('cuts a long text and says how long it was', () => {
    const capped = capText('a'.repeat(PREVIEW_TEXT_CHARS + 50));
    expect(capped).toMatchObject({ total: PREVIEW_TEXT_CHARS + 50, truncated: true });
    expect(capped.text).toHaveLength(PREVIEW_TEXT_CHARS);
  });

  it('does not cut a character in half', () => {
    const capped = capText(`${'a'.repeat(4)}🎉🎉`, 5);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toBe('aaaa');
    expect(capText(`${'a'.repeat(4)}🎉🎉`, 6).text).toBe('aaaa🎉');
  });
});

describe('shellSafeUrl', () => {
  const SAFE = /^[A-Za-z0-9\-._~:/?&=%@+,;#]*$/;

  it('leaves a plain address as it is', () => {
    const url = 'https://console.example.com:8443/api/client/v1/files/buckets/docs/objects/a%2Fb.pdf/download?variant=markdown';
    expect(shellSafeUrl(url)).toBe(url);
  });

  it('encodes every character a shell could act on inside double quotes, and nothing is lost', () => {
    for (let code = 0; code < 0x250; code += 1) {
      const char = String.fromCharCode(code);
      const safe = shellSafeUrl(char);
      expect(safe, `U+${code.toString(16)}`).toMatch(SAFE);
      if (safe !== char) expect(decodeURIComponent(safe), `U+${code.toString(16)}`).toBe(char);
    }
    const hostile = `a'b"c$(x)\`d!e*f(g)h\\i j\nk;l|m&n<o>p{q}r~s`;
    expect(shellSafeUrl(hostile)).toMatch(SAFE);
    expect(decodeURIComponent(shellSafeUrl(hostile))).toBe(hostile);
    expect(decodeURIComponent(shellSafeUrl('🎉'))).toBe('🎉');
  });

  it('survives a lone surrogate', () => {
    expect(shellSafeUrl('a\ud800b')).toMatch(SAFE);
  });
});

describe('apiSnippets', () => {
  it('prints the download, the Markdown download (when there is a copy) and the delete of one file', () => {
    const snippets = apiSnippets('https://host.example/', 'my docs', 'reports/2026/q3.pdf', { markdown: true });
    expect(snippets.map((snippet) => snippet.id)).toEqual(['download', 'downloadMarkdown', 'delete']);
    const address = 'https://host.example/api/client/v1/files/buckets/my%20docs/objects/reports%2F2026%2Fq3.pdf';
    expect(snippets[0]!.code).toBe(`curl -H "Authorization: Bearer YOUR_API_TOKEN" \\\n  "${address}/download" \\\n  -o downloaded-file`);
    expect(snippets[1]!.code).toBe(`curl -H "Authorization: Bearer YOUR_API_TOKEN" \\\n  "${address}/download?variant=markdown" \\\n  -o downloaded-file.md`);
    expect(snippets[2]!.code).toBe(`curl -X DELETE -H "Authorization: Bearer YOUR_API_TOKEN" \\\n  "${address}"`);
  });

  it('writes the characters a shell treats specially in a key as percent-encoded text', () => {
    const [download] = apiSnippets('https://host.example', 'docs', "it's (1)*!🎉.txt");
    expect(download!.code).toContain('/objects/it%27s%20%281%29%2A%21%F0%9F%8E%89.txt/download');
  });

  it('leaves the Markdown download out until there is a copy', () => {
    expect(apiSnippets('https://h', 'b', 'k').map((snippet) => snippet.id)).toEqual(['download', 'delete']);
  });

  it.skipIf(process.platform === 'win32')('is inert in a shell, whatever the key holds', () => {
    // `echo` stands in for a command a hostile key would run; if it ran, its output would replace the text.
    const key = `x'y"z$(echo INJECTED)\`echo INJECTED\`!;echo INJECTED|cat&&echo INJECTED\n.txt`;
    for (const snippet of apiSnippets('https://host.example', 'docs', key, { markdown: true })) {
      const quoted = /"(https[^"]*)"/.exec(snippet.code)![1]!;
      const printed = execFileSync('/bin/sh', ['-c', `printf '%s' "${quoted}"`], { encoding: 'utf8' });
      expect(printed).toBe(quoted);
      expect(printed).not.toContain('INJECTED\n');
      expect(printed.split('\n')).toHaveLength(1);
    }
  });
});
