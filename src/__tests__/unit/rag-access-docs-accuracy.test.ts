/**
 * Unit tests - the Knowledge Engine access control pages say what the code does
 *
 * The guide's "Access control" section and the API page repeat the routes, principal keys, limits, matching defaults
 * and refusal codes of knowledge base access control. Here they are read from the code (the routes the plugin
 * registers, the principal parser, the limits, `DEFAULT_USER_MATCH`, the status of each `RagAccessError`) and each page
 * is searched for what the code produces. The wording around them is not compared.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_MATCH } from '@/lib/services/rag/access/identity';
import {
  isValidIdentityDomainKey,
  MAX_ACL_ENTRIES_PER_NODE,
  MAX_ACL_LABEL_LENGTH,
  parsePrincipal,
  type RagPrincipalKind,
} from '@/lib/services/rag/access/principals';
import {
  MAX_DOCUMENTS_PER_MOVE,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_NAME_LENGTH,
  parseRagAclNode,
  RagAccessError,
} from '@/lib/services/rag/ragAccessService';
import { ragAccessApiPlugin } from '@/server/api/plugins/rag-access';

const ROOT = path.resolve(__dirname, '../../..');
/** Line breaks and runs of space read as one space, so a token wrapped over two lines is still found. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const read = (file: string): string => flat(readFileSync(path.join(ROOT, file), 'utf8'));

const guidePage = read('docs/guide/rag.md');
const guide = guidePage.slice(guidePage.indexOf('## Access control'));
const api = read('docs/api/rag.md');

describe('the guide\'s access control section', () => {
  it('lists every route the access control plugin registers, under the dashboard prefix', async () => {
    const routes: string[] = [];
    const record = (method: string) => (url: string) => routes.push(`${method} /api${url}`);
    await ragAccessApiPlugin(
      { get: record('GET'), post: record('POST'), put: record('PUT'), patch: record('PATCH'), delete: record('DELETE') } as never,
      {} as never,
    );
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) {
      const [method, url] = route.split(' ');
      expect(guide.includes(`${method} ${url}`) || (method === 'GET' && guide.includes(`GET ${url}?`)), route).toBe(true);
    }
  });

  it('names each kind of principal, in its table, in the form the parser reads', () => {
    const forms: Record<RagPrincipalKind, string> = {
      everyone: 'everyone',
      user: 'user:<id>',
      group: 'group:<id>',
      token: 'token:<id>',
      email: 'email:<address>',
      external_user: 'x:<directory>:u:<id>',
      external_group: 'x:<directory>:g:<id>',
      external_all: 'x:<directory>:all',
    };
    for (const [kind, form] of Object.entries(forms)) {
      expect(guide, form).toContain(`| \`${form}\` |`);
      const sample = form.replace('<id>', 'a1').replace('<address>', 'ada@example.com').replace('<directory>', 'corp');
      expect(parsePrincipal(sample)?.kind, sample).toBe(kind);
    }
    for (const node of ['module', 'folder:f1', 'document:d1']) expect(() => parseRagAclNode(node, 'kb'), node).not.toThrow();
    expect(guide).toContain('`folder:<id>`');
    expect(guide).toContain('`document:<id>`');
  });

  it('gives the limits the code enforces', () => {
    expect(guide).toContain(`at most ${MAX_ACL_ENTRIES_PER_NODE} entries`);
    expect(guide).toContain(`up to ${MAX_ACL_LABEL_LENGTH} characters`);
    expect(guide).toContain(`1 to ${MAX_FOLDER_NAME_LENGTH} characters`);
    expect(guide).toContain(`at most ${MAX_FOLDER_DEPTH} levels`);
    expect(guide).toContain(`up to ${MAX_DOCUMENTS_PER_MOVE} documents`);
    expect(isValidIdentityDomainKey('a'.repeat(64))).toBe(true);
    expect(isValidIdentityDomainKey('a'.repeat(65))).toBe(false);
    expect(guide).toContain('up to 64 lower-case letters');
  });

  it('describes the default matching of a person to a directory', () => {
    expect(DEFAULT_USER_MATCH.map((rule) => `${rule.console}>${rule.external}`)).toEqual(['email>email', 'email>upn']);
    expect(guide).toContain('by `email` to `email`, then by `email` to `upn`');
  });

  it('answers each refusal it names with the status the code sends', () => {
    const named = ['principal_unknown', 'folder_not_empty', 'folder_too_deep', 'folder_exists', 'folder_cycle', 'access_denied', 'domain_in_use'] as const;
    for (const code of named) expect(guide, code).toContain(`\`${new RagAccessError(code, '').statusCode} ${code}\``);
    for (const code of ['domain_managed_by_source', 'folder_managed_by_source', 'document_managed_by_source', 'acl_managed_by_source'] as const) {
      expect(new RagAccessError(code, '').statusCode, code).toBe(409);
      expect(guide, code).toContain(code);
    }
    expect(guide).toContain('`403 session_restricted`');
    expect(guide).toContain('`403 kb_access_controlled`');
  });
});

describe('the API page', () => {
  it('names the ingest fields, the module setting and the refusals', () => {
    for (const token of ['`folderId`', '`folderPath`', '`acl`', '"adminBypass"', '`totalDocuments`', '`access_denied`', '`kb_access_controlled`']) {
      expect(api, token).toContain(token);
    }
    expect(api).toContain('(/guide/rag#access-control)');
  });
});
