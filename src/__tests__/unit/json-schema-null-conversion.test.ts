import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
    jsonSchemaToZod,
    resolveStructuredOutputSchema,
    toolInputSchemaToZod,
} from '@/lib/services/agents/agentRuntimeConfig';

const accepts = (schema: z.ZodTypeAny, value: unknown) => schema.safeParse(value).success;

// One value of each JSON type that is NOT string or null.
const NON_STRING_NON_NULL: unknown[] = [123, 1.5, true, false, {}, { a: 1 }, [], ['x']];

describe('jsonSchemaToZod — JSON Schema null', () => {
    it('{type:"null"} accepts only null', () => {
        const schema = jsonSchemaToZod({ type: 'null' }, true);
        expect(schema._def.typeName).toBe('ZodNull');
        expect(accepts(schema, null)).toBe(true);
        for (const v of ['abc', '', 0, true, {}, [], undefined]) expect(accepts(schema, v)).toBe(false);
    });

    it('type:["string","null"] accepts a string and null only', () => {
        const schema = jsonSchemaToZod({ type: ['string', 'null'] }, true);
        expect(accepts(schema, 'abc')).toBe(true);
        expect(accepts(schema, null)).toBe(true);
        for (const v of NON_STRING_NON_NULL) expect(accepts(schema, v)).toBe(false);
        expect(accepts(schema, undefined)).toBe(false);
    });

    it('anyOf:[string,null] accepts a string and null only', () => {
        const schema = jsonSchemaToZod({ anyOf: [{ type: 'string' }, { type: 'null' }] }, true);
        expect(accepts(schema, 'abc')).toBe(true);
        expect(accepts(schema, null)).toBe(true);
        for (const v of NON_STRING_NON_NULL) expect(accepts(schema, v)).toBe(false);
    });

    it('both forms behave identically, strict or not', () => {
        for (const strict of [true, false]) {
            const a = jsonSchemaToZod({ type: ['string', 'null'] }, strict);
            const b = jsonSchemaToZod({ anyOf: [{ type: 'string' }, { type: 'null' }] }, strict);
            for (const v of ['abc', null, 123, {}, [], true]) expect(accepts(a, v)).toBe(accepts(b, v));
        }
    });

    it('keeps the other constraints on the non-null branch', () => {
        const schema = jsonSchemaToZod({ type: ['string', 'null'], minLength: 3 });
        expect(accepts(schema, 'abc')).toBe(true);
        expect(accepts(schema, 'ab')).toBe(false);
        expect(accepts(schema, null)).toBe(true);
    });

    it('supports other nullable scalars and multi-type arrays', () => {
        const int = jsonSchemaToZod({ type: ['integer', 'null'], minimum: 0 });
        expect([accepts(int, 3), accepts(int, null), accepts(int, 1.5), accepts(int, -1), accepts(int, '3')])
            .toEqual([true, true, false, false, false]);
        const multi = jsonSchemaToZod({ type: ['string', 'number', 'null'] });
        expect([accepts(multi, 'a'), accepts(multi, 2), accepts(multi, null), accepts(multi, true), accepts(multi, {})])
            .toEqual([true, true, true, false, false]);
        expect(accepts(jsonSchemaToZod({ type: ['null'] }), null)).toBe(true);
        expect(accepts(jsonSchemaToZod({ type: ['null'] }), 'a')).toBe(false);
    });

    it('a type array without null does not accept null', () => {
        const schema = jsonSchemaToZod({ type: ['string', 'number'] });
        expect(accepts(schema, null)).toBe(false);
        expect(accepts(jsonSchemaToZod({ type: ['string'] }), null)).toBe(false);
    });

    it('nullable enums stay restricted to their values', () => {
        const schema = jsonSchemaToZod({ type: ['string', 'null'], enum: ['low', 'high', null] });
        expect([accepts(schema, 'low'), accepts(schema, null), accepts(schema, 'medium'), accepts(schema, 1)])
            .toEqual([true, true, false, false]);
        // an enum that does not list null still rejects it
        expect(accepts(jsonSchemaToZod({ type: ['string', 'null'], enum: ['low'] }), null)).toBe(false);
    });

    it('nullable arrays and objects validate their contents', () => {
        const arr = jsonSchemaToZod({ type: ['array', 'null'], items: { type: 'string' } });
        expect([accepts(arr, ['a']), accepts(arr, null), accepts(arr, [1]), accepts(arr, 'a'), accepts(arr, {})])
            .toEqual([true, true, false, false, false]);

        const obj = jsonSchemaToZod(
            { type: ['object', 'null'], properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
        );
        expect([accepts(obj, { id: 'x' }), accepts(obj, null), accepts(obj, {}), accepts(obj, { id: 1 }),
            accepts(obj, { id: 'x', extra: 1 }), accepts(obj, [])]).toEqual([true, true, false, false, false, false]);

        const anyOfObj = jsonSchemaToZod({
            anyOf: [{ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, { type: 'null' }],
        });
        expect([accepts(anyOfObj, { id: 'x' }), accepts(anyOfObj, null), accepts(anyOfObj, { id: 1 }), accepts(anyOfObj, 'x')])
            .toEqual([true, true, false, false]);
    });

    it('keeps the description on a nullable node', () => {
        expect(jsonSchemaToZod({ type: ['string', 'null'], description: 'The id' }).description).toBe('The id');
    });
});

describe('jsonSchemaToZod — required vs nullable', () => {
    const schemaOf = (strict: boolean) => jsonSchemaToZod(
        { type: 'object', required: ['accountId'], properties: { accountId: { type: ['string', 'null'] }, note: { type: 'string' } } },
        strict,
    );

    it('a required nullable key must be present but may be null', () => {
        const schema = schemaOf(false);
        expect(accepts(schema, { accountId: 'a' })).toBe(true);
        expect(accepts(schema, { accountId: null })).toBe(true);
        expect(accepts(schema, {})).toBe(false);
        expect(accepts(schema, { accountId: 5 })).toBe(false);
    });

    it('a non-required nullable key may be omitted, null or a string', () => {
        const schema = jsonSchemaToZod({ type: 'object', properties: { accountId: { type: ['string', 'null'] } } });
        expect([accepts(schema, {}), accepts(schema, { accountId: null }), accepts(schema, { accountId: 'a' }),
            accepts(schema, { accountId: 5 })]).toEqual([true, true, true, false]);
    });

    it('strict mode still requires every declared nullable key', () => {
        const schema = schemaOf(true);
        expect(accepts(schema, { accountId: null, note: 'n' })).toBe(true);
        expect(accepts(schema, { accountId: null })).toBe(false);
        expect(accepts(schema, { note: 'n' })).toBe(false);
    });
});

describe('jsonSchemaToZod — Diagno-shaped nested nullable schema', () => {
    const DIAGNO = {
        type: 'object',
        additionalProperties: false,
        required: ['generalInfo', 'confluenceLink'],
        properties: {
            generalInfo: {
                type: 'object',
                additionalProperties: false,
                required: ['accountId'],
                properties: { accountId: { type: ['string', 'null'] } },
            },
            confluenceLink: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
    };

    it.each([true, false])('validates nested nullable fields (strict=%s)', (strict) => {
        const schema = jsonSchemaToZod(DIAGNO, strict);
        const ok = (accountId: unknown, confluenceLink: unknown) => accepts(schema, { generalInfo: { accountId }, confluenceLink });

        expect(ok('SA-1', 'https://x')).toBe(true);
        expect(ok(null, null)).toBe(true);
        expect(ok('SA-1', null)).toBe(true);
        for (const bad of NON_STRING_NON_NULL) {
            expect(ok(bad, null)).toBe(false);
            expect(ok('SA-1', bad)).toBe(false);
        }
        // required keys stay required, unknown keys stay rejected
        expect(accepts(schema, { generalInfo: {}, confluenceLink: null })).toBe(false);
        expect(accepts(schema, { generalInfo: { accountId: null } })).toBe(false);
        expect(accepts(schema, { generalInfo: { accountId: null, extra: 1 }, confluenceLink: null })).toBe(false);
    });

    it('is a usable structured-output contract (not degraded to z.any)', () => {
        const schema = resolveStructuredOutputSchema({ enabled: true, strict: true, schema: DIAGNO });
        expect(schema).toBeDefined();
        expect(accepts(schema!, { generalInfo: { accountId: 123 }, confluenceLink: null })).toBe(false);
    });

    it('is emitted to the provider with the null branch intact', () => {
        const json = zodToJsonSchema(jsonSchemaToZod(DIAGNO, true)) as unknown as {
            required: string[];
            properties: Record<string, { type: string[]; required?: string[]; properties: Record<string, { type: string[] }> }>;
        };
        const props = json.properties;
        expect(props.confluenceLink.type).toEqual(['string', 'null']);
        expect(props.generalInfo.properties.accountId.type).toEqual(['string', 'null']);
        expect(props.generalInfo.required).toEqual(['accountId']);
        expect(json.required).toEqual(['generalInfo', 'confluenceLink']);
    });
});

describe('jsonSchemaToZod — existing behaviour is preserved', () => {
    it('anyOf of non-null variants is unchanged', () => {
        const schema = jsonSchemaToZod({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
        expect([accepts(schema, 'a'), accepts(schema, 3), accepts(schema, null), accepts(schema, true)])
            .toEqual([true, true, false, false]);
        const one = jsonSchemaToZod({ anyOf: [{ type: 'string' }] });
        expect([accepts(one, 'a'), accepts(one, 3)]).toEqual([true, false]);
    });

    it('oneOf is unchanged', () => {
        const schema = jsonSchemaToZod({ oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['a'] }] });
        expect([accepts(schema, true), accepts(schema, 'a'), accepts(schema, 'b'), accepts(schema, null)])
            .toEqual([true, true, false, false]);
    });

    it('plain scalar, enum, array and unknown types behave as before', () => {
        expect(accepts(jsonSchemaToZod({ type: 'string' }), null)).toBe(false);
        expect(accepts(jsonSchemaToZod({ type: 'string', enum: ['a', 'b'] }), 'c')).toBe(false);
        expect(accepts(jsonSchemaToZod({ type: 'array', items: { type: 'integer' } }), [1, 2])).toBe(true);
        expect(accepts(jsonSchemaToZod({ type: 'array', items: { type: 'integer' } }), [1, 'x'])).toBe(false);
        expect(jsonSchemaToZod({ type: 'weird' })._def.typeName).toBe('ZodAny');
        expect(jsonSchemaToZod({ type: ['weird', 'null'] })._def.typeName).toBe('ZodAny');
        expect(jsonSchemaToZod({})._def.typeName).toBe('ZodAny');
    });

    it('tool input schemas accept null only where the schema allows it', () => {
        const schema = toolInputSchemaToZod({
            type: 'object',
            properties: { a: { type: ['string', 'null'] }, b: { type: 'string' } },
            required: ['a'],
        });
        expect([accepts(schema, { a: null }), accepts(schema, { a: 'x', extra: 1 }), accepts(schema, { a: 1 }),
            accepts(schema, { a: 'x', b: null })]).toEqual([true, true, false, false]);
    });
});
