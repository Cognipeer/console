/**
 * A log payload that cannot be reduced to JSON (nested deeper than the
 * serializer can walk, a getter that throws, a value JSON has no form for) is
 * replaced by a marker of fixed size. Handing the structure back instead would
 * lose the whole log row: the stores serialize it again, and cannot either.
 *
 * Structures here are built in a loop and only ever inspected through the
 * serialized form of the result, so a failing assertion cannot try to print a
 * hundred thousand levels of nesting.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_PAYLOAD_BYTES, LOG_SECRET_MASK, redactLogPayload } from '@/lib/services/logRedaction';

const DEPTH = 100_000;
const SECRET = 'upstream-secret-value-123';

/** `{ a: { a: { ... } } }`, `depth` levels, built without recursion. */
function nestedObject(depth: number, leaf: unknown = 'leaf'): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf };
  for (let level = 0; level < depth; level += 1) node = { a: node };
  return node;
}

/** `[[[ ... ]]]`, `depth` levels, built without recursion. */
function nestedArray(depth: number, leaf: unknown = 'leaf'): unknown[] {
  let node: unknown[] = [leaf];
  for (let level = 0; level < depth; level += 1) node = [node];
  return node;
}

const SHAPES: Array<[string, () => unknown]> = [
  ['objects', () => nestedObject(DEPTH)],
  ['arrays', () => nestedArray(DEPTH)],
];

/** The serialized form of a redaction result, which is what a store writes. */
function stored(value: unknown): string {
  return JSON.stringify(value);
}

describe('redactLogPayload — a payload nested deeper than a store can hold', () => {
  it.each(SHAPES)('nested %s 100000 levels deep is cut at the stored depth', (_name, build) => {
    const deep = build();
    // Control: this really is a structure a store cannot serialize as it is.
    expect(() => JSON.stringify(deep)).toThrow(RangeError);

    const out = redactLogPayload({ tool: 'lookup', arguments: deep });

    expect(out).toMatchObject({ tool: 'lookup' });
    expect(stored(out)).toContain('[nested too deep]');
    expect(stored(out).length).toBeLessThan(2_000);
  });

  it('keeps the top of the payload and nothing below the stored depth', () => {
    const out = redactLogPayload({ tool: 'lookup-tool', arguments: nestedObject(DEPTH, 'leaf-value') });
    expect(stored(out)).toContain('lookup-tool');
    expect(stored(out)).not.toContain('leaf-value');
  });

  it('is also what a response payload becomes', () => {
    const out = redactLogPayload({ content: [{ type: 'text', text: 'ok' }], extra: nestedArray(DEPTH) });
    expect(out).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
    expect(stored(out)).toContain('[nested too deep]');
  });

  it('answers with a new copy each time, so one caller cannot change what another gets', () => {
    const first = redactLogPayload(nestedObject(DEPTH)) as Record<string, unknown>;
    first.added = true;
    expect(redactLogPayload(nestedObject(DEPTH))).not.toHaveProperty('added');
  });
});

describe('redactLogPayload — a payload that cannot be serialized', () => {

  it('is the same with secret values supplied, and no secret is left', () => {
    const out = redactLogPayload({ arguments: nestedObject(DEPTH, SECRET) }, { secretValues: [SECRET] });
    // Past the depth that is walked key by key the subtree is masked as text.
    expect(stored(out).length).toBeLessThan(4_096);
    expect(stored(out)).not.toContain(SECRET);
  });

  it('is what a getter that throws becomes', () => {
    const payload = {
      tool: 'lookup',
      get arguments(): never {
        throw new Error('getter failed');
      },
    };
    expect(redactLogPayload(payload)).toMatchObject({ _truncated: true, _unserializable: true });
  });

  it('is what an object whose property listing throws becomes', () => {
    const payload = new Proxy({}, {
      ownKeys() {
        throw new Error('listing failed');
      },
    });
    expect(redactLogPayload(payload)).toMatchObject({ _truncated: true, _unserializable: true });
  });

  it('is what a secret list that cannot be read becomes', () => {
    const secrets = {
      [Symbol.iterator]() {
        throw new Error('iteration failed');
      },
    } as unknown as Iterable<string>;
    const out = redactLogPayload({ tool: 'lookup' }, { secretValues: secrets });
    expect(out).toMatchObject({ _truncated: true, _unserializable: true });
    expect(stored(out)).not.toContain('lookup');
  });

  it('is what a value JSON has no form for becomes', () => {
    expect(redactLogPayload({ count: BigInt(10) })).toMatchObject({ _truncated: true, _unserializable: true });
  });

  it('stays within a small cap, like the size marker', () => {
    const out = redactLogPayload({ count: BigInt(10) }, { maxBytes: 300 });
    expect(stored(out).length).toBeLessThanOrEqual(300);
    expect(out).toMatchObject({ _truncated: true, _unserializable: true });
  });

  it('keeps a deep payload within the size cap too', () => {
    const out = redactLogPayload({ arguments: nestedObject(DEPTH) }, { maxBytes: 120 });
    expect(stored(out).length).toBeLessThanOrEqual(300);
    expect(out).toMatchObject({ _truncated: true });
  });
});

describe('redactLogPayload — payloads that can be serialized are not touched by that', () => {
  it('keeps a payload nested deeper than the key walk as it is, down to the stored depth', () => {
    const input = { arguments: nestedObject(20, 'leaf-20') };
    const out = redactLogPayload(input);
    expect(stored(out)).toBe(stored(input));
    expect(out).not.toHaveProperty('_unserializable');
  });

  it('cuts a serializable payload nested deeper than a document store can hold', () => {
    // 200 levels serialize fine but exceed document-store nesting limits (MongoDB: 100).
    const out = redactLogPayload({ arguments: nestedObject(200, 'leaf-200') }, { secretValues: [SECRET] });
    const text = stored(out);
    expect(out).not.toHaveProperty('_unserializable');
    expect(text).toContain('[nested too deep]');
    expect(text).not.toContain('leaf-200');
    let depth = 0;
    let node: unknown = out;
    while (node && typeof node === 'object') {
      node = (node as Record<string, unknown>).arguments ?? (node as Record<string, unknown>).a;
      depth += 1;
    }
    expect(depth).toBeLessThanOrEqual(40);
  });

  it('still masks sensitive keys and secret values in an ordinary payload', () => {
    const out = redactLogPayload(
      { tool: 'lookup', api_key: 'k-1', note: `sent ${SECRET}` },
      { secretValues: [SECRET] },
    );
    expect(out).toEqual({ tool: 'lookup', api_key: LOG_SECRET_MASK, note: `sent ${LOG_SECRET_MASK}` });
  });

  it('still answers an over-size payload with the size marker, not this one', () => {
    const out = redactLogPayload({ blob: 'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES + 10) }) as Record<string, unknown>;
    expect(out._truncated).toBe(true);
    expect(out._originalBytes).toBeGreaterThan(DEFAULT_MAX_PAYLOAD_BYTES);
    expect(out).not.toHaveProperty('_unserializable');
  });

  it('passes null and undefined through', () => {
    expect(redactLogPayload(null)).toBeNull();
    expect(redactLogPayload(undefined)).toBeUndefined();
  });
});
