import { describe, expect, it } from 'vitest';
import {
    addField,
    fieldErrors,
    fieldsToSchema,
    removeField,
    schemaToFields,
    updateField,
} from '@/components/agents/studio/schemaFields';

function roundTrip(schema: Record<string, unknown>) {
    const result = schemaToFields(schema);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    return { result, back: fieldsToSchema(result.fields, result.meta) };
}

describe('schemaFields round trip', () => {
    const accepted: Array<Record<string, unknown>> = [
        { type: 'object', properties: { a: { type: 'string' } } },
        {
            type: 'object',
            properties: {
                city: { type: 'string', description: 'City', enum: ['a', 'b'] },
                n: { type: 'number', minimum: 0, maximum: 10, default: 3 },
                i: { type: 'integer' },
                flag: { type: 'boolean', default: false },
                tags: { type: 'array', items: { type: 'string' } },
                anyList: { type: 'array' },
                nested: { type: 'object', description: 'Nested', properties: { x: { type: 'string' } }, required: ['x'] },
                s: { type: 'string', minLength: 1, maxLength: 5 },
            },
            required: ['city', 'nested'],
            description: 'Top',
            additionalProperties: false,
        },
        JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}') as Record<string, unknown>,
        { type: 'object', description: 'only a description' },
    ];

    it.each(accepted.map((s, i) => [i, s] as const))('round-trips schema #%i', (_i, schema) => {
        expect(roundTrip(schema).back).toEqual(schema);
    });

    it('round-trips generated schemas', () => {
        const types = ['string', 'number', 'integer', 'boolean', 'array', 'object'];
        let seed = 7;
        const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
        for (let run = 0; run < 200; run++) {
            const count = 1 + rnd(6);
            const properties: Record<string, unknown> = {};
            const names: string[] = [];
            for (let k = 0; k < count; k++) {
                const name = `f${k}_${rnd(100)}`;
                const type = types[rnd(types.length)];
                const prop: Record<string, unknown> = { type };
                if (rnd(2)) prop.description = `d${rnd(9)}`;
                if (type === 'string' && rnd(2)) prop.enum = ['x', 'y' + rnd(5)];
                if (type === 'array' && rnd(2)) prop.items = { type: ['string', 'number', 'integer', 'boolean'][rnd(4)] };
                if (type === 'object' && rnd(2)) prop.properties = { z: { type: 'string' } };
                if ((type === 'number' || type === 'integer') && rnd(2)) prop.minimum = rnd(5);
                properties[name] = prop;
                names.push(name);
            }
            const schema: Record<string, unknown> = { type: 'object', properties };
            const required = names.filter(() => rnd(2) === 1);
            if (required.length > 0) schema.required = required;
            expect(roundTrip(schema).back).toEqual(schema);
        }
    });

    it('treats undefined and {} as zero fields', () => {
        for (const s of [undefined, {}]) {
            const r = schemaToFields(s);
            expect(r.ok && r.fields).toEqual([]);
        }
        expect(fieldsToSchema([])).toBeUndefined();
    });
});

describe('schemaFields unsupported constructs', () => {
    const rejected: Array<[string, Record<string, unknown>]> = [
        ['anyOf', { type: 'object', anyOf: [{}] }],
        ['$ref', { type: 'object', $ref: '#/x' }],
        ['allOf', { type: 'object', allOf: [] }],
        ['patternProperties', { type: 'object', patternProperties: {} }],
        ['schema additionalProperties', { type: 'object', additionalProperties: { type: 'string' } }],
        ['non-object top type', { type: 'array' }],
        ['missing type', { properties: { a: { type: 'string' } } }],
        ['missing property type', { type: 'object', properties: { a: {} } }],
        ['array of types', { type: 'object', properties: { a: { type: ['string', 'null'] } } }],
        ['unknown type', { type: 'object', properties: { a: { type: 'null' } } }],
        ['pattern key', { type: 'object', properties: { a: { type: 'string', pattern: '^a' } } }],
        ['oneOf property', { type: 'object', properties: { a: { oneOf: [] } } }],
        ['enum on number', { type: 'object', properties: { a: { type: 'number', enum: [1] } } }],
        ['non-string enum', { type: 'object', properties: { a: { type: 'string', enum: [1] } } }],
        ['complex items', { type: 'object', properties: { a: { type: 'array', items: { type: 'object' } } } }],
        ['required without property', { type: 'object', properties: {}, required: ['x'] }],
    ];
    it.each(rejected)('rejects %s', (_label, schema) => {
        const r = schemaToFields(schema);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    });
});

describe('schemaFields conversion details', () => {
    it('omits required when empty and marks required fields', () => {
        const r = schemaToFields({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['b'] });
        if (!r.ok) throw new Error(r.reason);
        expect(r.fields.map((f) => f.required)).toEqual([false, true]);
        const off = updateField(r.fields, r.fields[1].id, { required: false });
        expect(fieldsToSchema(off)).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } });
    });

    it('keeps enum, items and raw nested objects', () => {
        const r = schemaToFields({
            type: 'object',
            properties: { c: { type: 'string', enum: ['a'] }, l: { type: 'array', items: { type: 'number' } }, o: { type: 'object', properties: { q: { type: 'string' } } } },
        });
        if (!r.ok) throw new Error(r.reason);
        expect(r.fields[0].enumValues).toEqual(['a']);
        expect(r.fields[1].itemsType).toBe('number');
        expect(r.fields[2].rawSchema).toEqual({ properties: { q: { type: 'string' } } });
    });

    it('add, update, remove', () => {
        let fields = addField([]);
        expect(fields).toHaveLength(1);
        const id = fields[0].id;
        fields = updateField(fields, id, { name: 'city', type: 'array', itemsType: 'string' });
        expect(fieldsToSchema(fields)).toEqual({ type: 'object', properties: { city: { type: 'array', items: { type: 'string' } } } });
        fields = updateField(fields, id, { type: 'string' });
        expect(fields[0].itemsType).toBeUndefined();
        fields = updateField(fields, id, { enumValues: ['a'] });
        fields = updateField(fields, id, { type: 'number' });
        expect(fields[0].enumValues).toBeUndefined();
        fields = removeField(fields, id);
        expect(fields).toEqual([]);
    });

    it('reports name, duplicate and enum errors', () => {
        let fields = addField(addField(addField([])));
        fields = updateField(fields, fields[0].id, { name: 'ok' });
        fields = updateField(fields, fields[1].id, { name: 'ok' });
        fields = updateField(fields, fields[2].id, { name: '1bad', enumValues: ['a', ' '] });
        const errors = fieldErrors(fields);
        expect(errors[fields[0].id]).toBeUndefined();
        expect(errors[fields[1].id]).toEqual(['nameDuplicate']);
        expect(errors[fields[2].id]).toEqual(['name', 'enum']);
        expect(fieldErrors(addField([]))[addField([])[0]?.id ?? '']).toBeUndefined();
        expect(Object.keys(fieldErrors(addField([])))).toHaveLength(1);
    });
});
