/**
 * The parameter names an operation declares in the stored spec — the ones the
 * import-time tool schema does not list (declared by `$ref`, or once on the
 * path item). The request builder treats them as declared arguments.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetSpecParameterCache, specDeclaredParameters } from '@/lib/services/mcp/openApiSpecParameters';
import { buildOpenApiRequest } from '@/lib/services/mcp/openApiRequest';

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'T', version: '1' },
  components: {
    parameters: {
      PerPage: { name: 'per_page', in: 'query', schema: { type: 'integer' } },
      State: { name: 'state', in: 'query', schema: { type: 'string' } },
      Alias: { $ref: '#/components/parameters/State' },
      Loop: { $ref: '#/components/parameters/Loop' },
      'odd/name': { name: 'odd_name', in: 'query' },
    },
  },
  paths: {
    '/repos/{owner}/issues': {
      parameters: [
        { name: 'owner', in: 'path', required: true },
        { $ref: '#/components/parameters/PerPage' },
      ],
      get: {
        operationId: 'listIssues',
        parameters: [
          { $ref: '#/components/parameters/Alias' },
          { name: 'labels', in: 'query' },
          { $ref: '#/components/parameters/Loop' },
          { $ref: '#/components/parameters/Missing' },
          { $ref: 'https://elsewhere.example/params.json#/Foreign' },
          { $ref: '#/components/parameters/odd~1name' },
          'not-a-parameter',
          { in: 'query' },
        ],
      },
      post: { operationId: 'createIssue' },
    },
  },
};

const server = (spec: unknown, extra: Record<string, unknown> = {}) => ({
  _id: 'server-1',
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  openApiSpec: JSON.stringify(spec),
  ...extra,
});

beforeEach(() => resetSpecParameterCache());

describe('specDeclaredParameters', () => {
  it('lists parameters written inline, by reference and on the path item', () => {
    const names = specDeclaredParameters(server(SPEC), { httpPath: '/repos/{owner}/issues', httpMethod: 'GET' });
    expect(names.sort()).toEqual(['labels', 'odd_name', 'owner', 'per_page', 'state']);
  });

  it('gives an operation the path-level parameters even when it lists none of its own', () => {
    const names = specDeclaredParameters(server(SPEC), { httpPath: '/repos/{owner}/issues', httpMethod: 'POST' });
    expect(names.sort()).toEqual(['owner', 'per_page']);
  });

  it('follows only same-document references, and gives up on a loop', () => {
    const names = specDeclaredParameters(server(SPEC), { httpPath: '/repos/{owner}/issues', httpMethod: 'GET' });
    expect(names).not.toContain('Foreign');
    expect(names).toContain('state'); // reference to a reference
    expect(names).not.toContain('odd/name');
    expect(names).toContain('odd_name'); // a "/" in a pointer segment is written ~1
  });

  it('is empty for anything it cannot read', () => {
    const op = { httpPath: '/repos/{owner}/issues', httpMethod: 'GET' };
    expect(specDeclaredParameters(server(SPEC), { httpPath: '/nope', httpMethod: 'GET' })).toEqual([]);
    expect(specDeclaredParameters(server(SPEC), { httpPath: op.httpPath, httpMethod: 'DELETE' })).toEqual([]);
    expect(specDeclaredParameters({ _id: 'x', openApiSpec: '{not json' }, op)).toEqual([]);
    expect(specDeclaredParameters({ _id: 'x', openApiSpec: undefined }, op)).toEqual([]);
    expect(specDeclaredParameters({ _id: 'x', openApiSpec: JSON.stringify({ paths: [] }) }, op)).toEqual([]);
    expect(specDeclaredParameters(server(SPEC), { httpPath: undefined, httpMethod: 'GET' })).toEqual([]);
  });

  it('reads the spec again when the server record changed', () => {
    const op = { httpPath: '/a', httpMethod: 'GET' };
    const v1 = server({ paths: { '/a': { get: { parameters: [{ name: 'one', in: 'query' }] } } } });
    expect(specDeclaredParameters(v1, op)).toEqual(['one']);

    const v2 = server(
      { paths: { '/a': { get: { parameters: [{ name: 'two', in: 'query' }] } } } },
      { updatedAt: new Date('2026-02-01T00:00:00Z') },
    );
    expect(specDeclaredParameters(v2, op)).toEqual(['two']);
  });

  it('does not parse the spec again for an unchanged record', () => {
    const op = { httpPath: '/a', httpMethod: 'GET' };
    const record = server({ paths: { '/a': { get: { parameters: [{ name: 'one', in: 'query' }] } } } });
    expect(specDeclaredParameters(record, op)).toEqual(['one']);
    // Same stamp, different text: the cached names answer.
    expect(specDeclaredParameters({ ...record, openApiSpec: record.openApiSpec.replace('one', 'xyz') }, op))
      .toEqual(['one']);
  });
});

describe('buildOpenApiRequest with spec-declared names', () => {
  const base = {
    baseUrl: 'https://api.example.com',
    httpPath: '/repos/{owner}/issues',
    inputSchema: { type: 'object', properties: { undefined: { type: 'string' } } },
  };

  it('forwards a parameter the spec declares by reference, and still drops the rest', () => {
    const declaredNames = specDeclaredParameters(server(SPEC), { httpPath: base.httpPath, httpMethod: 'GET' });
    const request = buildOpenApiRequest({
      ...base,
      declaredNames,
      args: { owner: 'acme', per_page: 50, state: 'open', unlisted: 'x' },
    });
    expect(request.url).toBe('https://api.example.com/repos/acme/issues?per_page=50&state=open');
  });

  it('does not let a spec parameter named "body" stand in for a request body', () => {
    const request = buildOpenApiRequest({
      baseUrl: 'https://api.example.com',
      httpPath: '/things',
      inputSchema: { type: 'object', properties: {} },
      declaredNames: ['body'],
      args: { body: { a: 1 } },
    });
    expect(request.body).toBeUndefined();
  });
});
