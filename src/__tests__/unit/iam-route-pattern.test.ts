/**
 * The route label that logs and audit rows of the authorization gates carry
 * (src/lib/iam/routePattern.ts): the framework's pattern when there is one, else
 * the request path with every id-looking segment masked - never a query string,
 * always bounded in length.
 */
import { describe, expect, it } from 'vitest';
import { canonicalRoute, maskPath, maskPathSegment } from '@/lib/iam/routePattern';

describe('canonicalRoute', () => {
  it('prefers the route pattern, masks ids otherwise and never keeps a query string', () => {
    expect(canonicalRoute('/api/groups/:id', '/api/groups/5')).toBe('/api/groups/:id');
    expect(canonicalRoute(undefined, '/api/groups/507f1f77bcf86cd799439011/members/42')).toBe('/api/groups/:id/members/:id');
    expect(canonicalRoute(undefined, '/api/x/123e4567-e89b-12d3-a456-426614174000?token=abc')).toBe('/api/x/:id');
    expect(canonicalRoute(undefined, '/api/agents/my-agent')).toBe('/api/agents/my-agent');
    expect(canonicalRoute('', '/api/a')).toBe('/api/a');
    expect(canonicalRoute(undefined, `/api/${'a'.repeat(500)}`).length).toBeLessThanOrEqual(200);
  });

  it('ignores a pattern that is not a path, and the framework catch-all', () => {
    expect(canonicalRoute('not-a-path', '/api/things/12')).toBe('/api/things/:id');
    expect(canonicalRoute(null, '/api/things/12')).toBe('/api/things/:id');
    expect(canonicalRoute('/*', '/api/things/12')).toBe('/api/things/:id');
  });

  it('bounds an over-long pattern too', () => {
    const label = canonicalRoute(`/api/${'p'.repeat(400)}`, '/api/x');
    expect(label.length).toBeLessThanOrEqual(200);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('path masking', () => {
  it('masks object ids, uuids, numbers, long opaque tokens and prefixed ids - and nothing readable', () => {
    for (const id of ['507f1f77bcf86cd799439011', '123e4567-e89b-12d3-a456-426614174000', '42', 'a1b2c3d4e5f6g7h8i9j0k1', 'tok_abc12345678']) {
      expect(maskPathSegment(id), id).toBe(':id');
    }
    for (const word of ['agents', 'my-agent', 'v1', 'members', '']) {
      expect(maskPathSegment(word), word).toBe(word);
    }
  });

  it('drops the query string and the fragment before masking', () => {
    expect(maskPath('/api/tokens/507f1f77bcf86cd799439011?secret=1#frag')).toBe('/api/tokens/:id');
    expect(maskPath('/api/tokens?secret=1')).toBe('/api/tokens');
  });
});
