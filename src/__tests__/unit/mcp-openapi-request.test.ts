/**
 * The request builder for OpenAPI-sourced MCP tools: where `tools/call`
 * arguments may land in the upstream request.
 *
 * Placeholders are filled in the tool's path template only; only declared
 * arguments are forwarded; a path parameter must be a non-empty scalar that
 * cannot read as a relative path segment; and the finished URL has to stay on
 * the configured origin under the template's static head.
 */

import { describe, expect, it } from 'vitest';
import { McpToolInputError } from '@/lib/services/mcp/errors';
import { buildOpenApiRequest, pathPlaceholderNames } from '@/lib/services/mcp/openApiRequest';

const BASE = 'https://api.example.com/v1';

const USER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    limit: { type: 'integer' },
    expand: { type: 'string' },
  },
  required: ['id'],
};

function build(overrides: Partial<Parameters<typeof buildOpenApiRequest>[0]> = {}) {
  return buildOpenApiRequest({
    baseUrl: BASE,
    httpPath: '/users/{id}',
    inputSchema: USER_SCHEMA,
    args: { id: '42' },
    ...overrides,
  });
}

describe('buildOpenApiRequest — path parameters', () => {
  it('fills a placeholder and percent-encodes the value', () => {
    expect(build().url).toBe('https://api.example.com/v1/users/42');
    expect(build({ args: { id: 'a b/c?d#e' } }).url).toBe('https://api.example.com/v1/users/a%20b%2Fc%3Fd%23e');
    expect(build({ args: { id: 42 } }).url).toBe('https://api.example.com/v1/users/42');
    expect(build({ args: { id: true } }).url).toBe('https://api.example.com/v1/users/true');
  });

  it('fills every occurrence and every distinct placeholder', () => {
    const request = buildOpenApiRequest({
      baseUrl: BASE,
      httpPath: '/orgs/{org}/teams/{team}/mirror/{org}',
      inputSchema: { type: 'object', properties: { org: {}, team: {} } },
      args: { org: 'acme', team: 'core' },
    });
    expect(request.url).toBe('https://api.example.com/v1/orgs/acme/teams/core/mirror/acme');
  });

  it('accepts values that merely contain dots or percent signs', () => {
    for (const id of ['..a', 'a..b', '.hidden', 'file.txt', '...', 'v1.2.3', '100%', 'a%2Fb', '日本語', 'x y']) {
      expect(() => build({ args: { id } }), id).not.toThrow();
    }
  });

  it('fills a placeholder the schema does not list (a path-level parameter)', () => {
    const request = buildOpenApiRequest({
      baseUrl: BASE,
      httpPath: '/users/{id}',
      inputSchema: { type: 'object', properties: {} },
      args: { id: '7' },
    });
    expect(request.url).toBe('https://api.example.com/v1/users/7');
  });

  it.each([
    ['..'],
    ['.'],
    ['../x'],
    ['a/../b'],
    ['a/./b'],
    ['..\\x'],
    ['a\\..\\b'],
    ['/..'],
    ['%2e%2e'],
    ['%2E%2E'],
    ['.%2e'],
    ['%2e.'],
    ['%2e%2e%2fx'],
    ['%2e%2e%5cx'],
    ['a%2f..%2fb'],
    ['%2e'],
  ])('refuses a value that reads as a relative segment: %j', (id) => {
    expect(() => build({ args: { id } })).toThrow(McpToolInputError);
  });

  it.each([
    ['a\nb'],
    ['a\r\nb: c'],
    ['a\u0000b'],
    ['a\tb'],
    ['a\u007fb'],
    ['%0d%0a'],
    ['%00'],
  ])('refuses control characters: %j', (id) => {
    expect(() => build({ args: { id } })).toThrow(McpToolInputError);
  });

  it('requires every path parameter to be present and non-empty', () => {
    expect(() => build({ args: {} })).toThrow(/missing required path parameter "id"/i);
    expect(() => build({ args: { id: '' } })).toThrow(/missing required path parameter "id"/i);
    expect(() => build({ args: { id: null } })).toThrow(McpToolInputError);
    expect(() => build({ args: { id: undefined } })).toThrow(McpToolInputError);
    expect(() => build({ args: undefined })).toThrow(McpToolInputError);
    expect(() => build({ args: null as never })).toThrow(McpToolInputError);
  });

  it('requires a scalar', () => {
    expect(() => build({ args: { id: { a: 1 } } })).toThrow(McpToolInputError);
    expect(() => build({ args: { id: ['1', '2'] } })).toThrow(McpToolInputError);
  });

  it('refuses a value that cannot be percent-encoded', () => {
    expect(() => build({ args: { id: '\uD800' } })).toThrow(McpToolInputError);
  });

  it('does not take a path value from the prototype chain', () => {
    expect(() => buildOpenApiRequest({
      baseUrl: BASE,
      httpPath: '/things/{constructor}',
      inputSchema: { type: 'object', properties: {} },
      args: {},
    })).toThrow(/missing required path parameter "constructor"/i);
  });
});

describe('buildOpenApiRequest — unresolved placeholders', () => {
  it('refuses a template whose braces survive substitution', () => {
    expect(() => buildOpenApiRequest({
      baseUrl: BASE,
      httpPath: '/x/{{id}}',
      inputSchema: { type: 'object', properties: { id: {} } },
      args: { id: '1' },
    })).toThrow(/unresolved path parameter/i);
  });
});

describe('buildOpenApiRequest — the base URL is never templated', () => {
  it('does not fill a placeholder that sits in the base URL host', () => {
    for (const baseUrl of ['https://{region}.example.com/v1', 'https://{host}', 'https://api.example.com/{tenant}/v1']) {
      let thrown: unknown;
      try {
        buildOpenApiRequest({
          baseUrl,
          httpPath: '/users/{id}',
          inputSchema: { type: 'object', properties: { id: {}, region: {}, host: {}, tenant: {} } },
          args: { id: '1', region: 'other', host: 'other.test', tenant: 'other' },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, baseUrl).toBeInstanceOf(Error);
      // A configuration problem, not a problem with the caller's arguments.
      expect(thrown, baseUrl).not.toBeInstanceOf(McpToolInputError);
      expect(String((thrown as Error).message), baseUrl).not.toContain('other');
    }
  });

  it('reports a missing or unparsable base URL as a configuration error', () => {
    expect(() => build({ baseUrl: undefined })).toThrow(/base url/i);
    expect(() => build({ baseUrl: '' })).toThrow(/base url/i);
    expect(() => build({ baseUrl: 'not a url' })).toThrow(/base url/i);
  });
});

describe('buildOpenApiRequest — declared arguments only', () => {
  it('forwards declared non-path arguments as query parameters and drops the rest', () => {
    const request = build({
      args: { id: '42', limit: 5, expand: 'orders', debug: '1', role: 'x', api_key: 'x' },
    });
    expect(request.url).toBe('https://api.example.com/v1/users/42?limit=5&expand=orders');
  });

  it('keeps query parameters in the order the caller sent them', () => {
    const request = build({ args: { expand: 'orders', id: '42', limit: 5 } });
    expect(request.url).toBe('https://api.example.com/v1/users/42?expand=orders&limit=5');
  });

  it('never echoes a dropped name into the request', () => {
    const request = build({ args: { id: '42', include_deleted: 'true', fields: '*' } });
    expect(request.url).not.toMatch(/include_deleted|fields/);
  });

  it('adds nothing when no declared query argument was sent', () => {
    expect(build({ args: { id: '42', other: 1 } }).url).toBe('https://api.example.com/v1/users/42');
  });

  it('ignores an own "__proto__" key from parsed JSON', () => {
    const args = JSON.parse('{"id":"42","__proto__":{"limit":"9"},"limit":3}') as Record<string, unknown>;
    expect(build({ args }).url).toBe('https://api.example.com/v1/users/42?limit=3');
  });

  it('forwards the body only when the tool declares one', () => {
    const withBody = buildOpenApiRequest({
      baseUrl: BASE,
      httpPath: '/users',
      inputSchema: { type: 'object', properties: { body: { type: 'object' } } },
      args: { body: { name: 'Ada' }, extra: 1 },
    });
    expect(withBody.url).toBe('https://api.example.com/v1/users');
    expect(withBody.body).toEqual({ name: 'Ada' });

    const withoutBody = buildOpenApiRequest({
      baseUrl: BASE,
      httpPath: '/users',
      inputSchema: { type: 'object', properties: { limit: {} } },
      args: { body: { name: 'Ada' }, limit: 1 },
    });
    expect(withoutBody.body).toBeUndefined();
    expect(withoutBody.url).toBe('https://api.example.com/v1/users?limit=1');
  });

  it('treats a missing or malformed schema as declaring only the path placeholders', () => {
    for (const inputSchema of [undefined, {}, { properties: null }, { properties: [] }]) {
      const request = buildOpenApiRequest({
        baseUrl: BASE,
        httpPath: '/users/{id}',
        inputSchema: inputSchema as never,
        args: { id: '1', limit: 5 },
      });
      expect(request.url).toBe('https://api.example.com/v1/users/1');
    }
  });

  it('keeps query values of the types a model sends', () => {
    const request = buildOpenApiRequest({
      baseUrl: BASE,
      httpPath: '/search',
      inputSchema: { type: 'object', properties: { q: {}, n: {}, on: {}, tags: {} } },
      args: { q: 'a b&c=d', n: 3, on: false, tags: ['x', 'y'] },
    });
    const url = new URL(request.url);
    expect(url.searchParams.get('q')).toBe('a b&c=d');
    expect(url.searchParams.get('n')).toBe('3');
    expect(url.searchParams.get('on')).toBe('false');
    expect(url.searchParams.get('tags')).toBe('x,y');
  });
});

describe('buildOpenApiRequest — result must stay on the configured operation', () => {
  it('refuses a template that moves the request to another host', () => {
    for (const httpPath of ['@other.example/x/{id}', ':8443/x/{id}', '.other.example/x/{id}']) {
      expect(() => buildOpenApiRequest({
        baseUrl: 'https://api.example.com',
        httpPath,
        inputSchema: USER_SCHEMA,
        args: { id: '1' },
      }), httpPath).toThrow(McpToolInputError);
    }
  });

  it('keeps a base path with a trailing slash working as it did', () => {
    const request = buildOpenApiRequest({
      baseUrl: 'https://api.example.com/v1/',
      httpPath: '/users/{id}',
      inputSchema: USER_SCHEMA,
      args: { id: '1' },
    });
    expect(request.url).toBe('https://api.example.com/v1//users/1');
  });

  it('keeps a Postman duplicate-path suffix as a fragment, with the query before it', () => {
    const request = buildOpenApiRequest({
      baseUrl: BASE,
      httpPath: '/users#3',
      inputSchema: { type: 'object', properties: { limit: {} } },
      args: { limit: 5 },
    });
    expect(request.url).toBe('https://api.example.com/v1/users?limit=5#3');
  });
});

describe('pathPlaceholderNames', () => {
  it('lists placeholders in order, repeats included', () => {
    expect(pathPlaceholderNames('/a/{x}/b/{y}/{x}')).toEqual(['x', 'y', 'x']);
    expect(pathPlaceholderNames('/static')).toEqual([]);
  });
});
