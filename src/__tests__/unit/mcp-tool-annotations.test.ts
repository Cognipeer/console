import { describe, expect, it } from 'vitest';
import {
  defaultAnnotationsForSource,
  describeMcpTools,
  resolveToolAnnotations,
} from '@/lib/services/mcp/toolAnnotations';

describe('mcp tool annotations', () => {
  it('always emits every hint strict clients validate', () => {
    const [tool] = describeMcpTools([
      { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
    ]);
    expect(Object.keys(tool.annotations).sort()).toEqual([
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
      'readOnlyHint',
      'title',
    ]);
  });

  it('keeps hints declared on the tool', () => {
    const annotations = resolveToolAnnotations({
      name: 'search',
      annotations: { readOnlyHint: true, openWorldHint: false, title: 'Search KB' },
    });
    expect(annotations).toEqual({
      title: 'Search KB',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('derives hints from the OpenAPI HTTP method', () => {
    expect(resolveToolAnnotations({ name: 'listPets', httpMethod: 'get' })).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(resolveToolAnnotations({ name: 'deletePet', httpMethod: 'DELETE' })).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(resolveToolAnnotations({ name: 'createPet', httpMethod: 'POST' })).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it('assumes unknown tools are not read-only', () => {
    expect(resolveToolAnnotations({ name: 'mystery' })).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it('treats internal-source servers as read-only console-local tools', () => {
    expect(defaultAnnotationsForSource('internal')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(defaultAnnotationsForSource('remote')).toBeUndefined();
  });
});
