/**
 * Unit tests — Spec Import & Normalization
 * Tests: normalizeApiSpec (OpenAPI JSON/YAML pass-through, Postman conversion),
 *        convertPostmanToOpenApi (paths, params, body, base URL resolution).
 */

import { describe, it, expect } from 'vitest';
import { normalizeApiSpec, convertPostmanToOpenApi } from '@/lib/services/specImport';

describe('normalizeApiSpec', () => {
  it('passes through OpenAPI JSON', () => {
    const raw = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: { '/x': { get: { operationId: 'getX' } } },
    });
    const { openApiJson, detectedFormat } = normalizeApiSpec(raw);
    expect(detectedFormat).toBe('openapi-json');
    expect(JSON.parse(openApiJson).paths['/x'].get.operationId).toBe('getX');
  });

  it('parses OpenAPI YAML into JSON', () => {
    const yaml = [
      'openapi: 3.0.0',
      'info:',
      '  title: Pets',
      '  version: "1"',
      'servers:',
      '  - url: https://api.pets.com',
      'paths:',
      '  /pets/{id}:',
      '    get:',
      '      operationId: getPet',
      '      parameters:',
      '        - name: id',
      '          in: path',
      '          required: true',
      '          schema: { type: string }',
    ].join('\n');
    const { openApiJson, detectedFormat } = normalizeApiSpec(yaml);
    expect(detectedFormat).toBe('openapi-yaml');
    const spec = JSON.parse(openApiJson);
    expect(spec.paths['/pets/{id}'].get.operationId).toBe('getPet');
    expect(spec.servers[0].url).toBe('https://api.pets.com');
  });

  it('auto-detects and converts a Postman collection', () => {
    const postman = {
      info: {
        _postman_id: 'abc',
        name: 'My API',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      variable: [{ key: 'baseUrl', value: 'https://api.example.com' }],
      item: [
        {
          name: 'Get user',
          request: {
            method: 'GET',
            url: {
              raw: '{{baseUrl}}/users/:id?verbose=true',
              host: ['{{baseUrl}}'],
              path: ['users', ':id'],
              query: [{ key: 'verbose', value: 'true' }],
              variable: [{ key: 'id' }],
            },
          },
        },
        {
          name: 'Create user',
          request: {
            method: 'POST',
            url: { host: ['{{baseUrl}}'], path: ['users'] },
            body: { mode: 'raw', raw: '{"name":"a","age":3}', options: { raw: { language: 'json' } } },
          },
        },
      ],
    };
    const { openApiJson, detectedFormat } = normalizeApiSpec(JSON.stringify(postman));
    expect(detectedFormat).toBe('postman');
    const spec = JSON.parse(openApiJson);

    // Base URL variable resolved without doubling the scheme.
    expect(spec.servers[0].url).toBe('https://api.example.com');

    // `:id` becomes an OpenAPI path parameter.
    const getParams = spec.paths['/users/{id}'].get.parameters;
    expect(getParams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
        expect.objectContaining({ name: 'verbose', in: 'query' }),
      ]),
    );

    // Raw JSON body becomes a typed request-body schema.
    const bodyProps = spec.paths['/users'].post.requestBody.content['application/json'].schema.properties;
    expect(bodyProps.name.type).toBe('string');
    expect(bodyProps.age.type).toBe('integer');
  });

  it('resolves plain host arrays and bare hostnames to https origins', () => {
    const spec = convertPostmanToOpenApi({
      info: { _postman_id: 'x', name: 't' },
      item: [{ name: 'g', request: { method: 'GET', url: { host: ['api', 'example', 'com'], path: ['ping'] } } }],
    });
    expect((spec.servers as Array<{ url: string }>)[0].url).toBe('https://api.example.com');
  });

  it('throws on unrecognized / unparseable input', () => {
    expect(() => normalizeApiSpec('%%% not : valid : [')).toThrow();
    expect(() => normalizeApiSpec(JSON.stringify({ hello: 'world' }))).toThrow(/Unrecognized/);
    expect(() => normalizeApiSpec('')).toThrow();
  });
});
