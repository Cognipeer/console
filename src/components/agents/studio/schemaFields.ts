/**
 * Pure helpers behind the "Form" tab of a client tool's input schema: a flat
 * list of arguments that maps to and from a JSON Schema object. Anything the
 * form cannot represent faithfully is refused (`ok: false`), so switching
 * between Form and JSON never loses information.
 */

export type SchemaFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
export type SchemaItemsType = 'string' | 'number' | 'integer' | 'boolean';

export const SCHEMA_FIELD_TYPES: SchemaFieldType[] = ['string', 'number', 'integer', 'boolean', 'array', 'object'];
export const SCHEMA_ITEMS_TYPES: SchemaItemsType[] = ['string', 'number', 'integer', 'boolean'];

export interface SchemaField {
    id: string;
    name: string;
    type: SchemaFieldType;
    description: string;
    required: boolean;
    /** Only for type string. */
    enumValues?: string[];
    /** Only for type array. */
    itemsType?: SchemaItemsType;
    /** Only for type object: everything but type/description, edited in the JSON tab. */
    rawSchema?: Record<string, unknown>;
    /** Hidden constraints (default, minimum, ...) kept so the round trip is lossless. */
    extra?: Record<string, unknown>;
}

/** Top-level schema keys the field list does not hold. */
export interface SchemaMeta {
    description?: string;
    additionalProperties?: boolean;
}

export type SchemaToFieldsResult =
    | { ok: true; fields: SchemaField[]; meta: SchemaMeta }
    | { ok: false; reason: string };

export type SchemaFieldError = 'name' | 'nameDuplicate' | 'enum';

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOP_KEYS = new Set(['type', 'properties', 'required', 'description', 'additionalProperties']);
const PROP_KEYS = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'default', 'minimum', 'maximum', 'minLength', 'maxLength']);
const EXTRA_KEYS = ['default', 'minimum', 'maximum', 'minLength', 'maxLength'];

let idCounter = 0;
const newId = () => `sf-${++idCounter}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export function schemaToFields(schema: Record<string, unknown> | undefined): SchemaToFieldsResult {
    if (schema === undefined || schema === null) return { ok: true, fields: [], meta: {} };
    if (!isRecord(schema)) return no('The schema must be an object.');
    const keys = Object.keys(schema);
    if (keys.length === 0) return { ok: true, fields: [], meta: {} };

    for (const key of keys) {
        if (!TOP_KEYS.has(key)) return no(`"${key}" is not supported by the form.`);
    }
    if (schema.type !== 'object') return no('The top-level type must be "object".');

    const meta: SchemaMeta = {};
    if (schema.description !== undefined) {
        if (typeof schema.description !== 'string') return no('The schema description must be text.');
        meta.description = schema.description;
    }
    if (schema.additionalProperties !== undefined) {
        if (typeof schema.additionalProperties !== 'boolean') return no('"additionalProperties" must be true or false.');
        meta.additionalProperties = schema.additionalProperties;
    }

    const properties = schema.properties;
    if (properties !== undefined && !isRecord(properties)) return no('"properties" must be an object.');
    let requiredList: string[] = [];
    if (schema.required !== undefined) {
        if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== 'string')) {
            return no('"required" must be a list of names.');
        }
        requiredList = schema.required as string[];
        if (new Set(requiredList).size !== requiredList.length) return no('"required" has duplicate names.');
    }
    const names = Object.keys(properties ?? {});
    if (requiredList.some((name) => !names.includes(name))) return no('"required" names an argument that is not declared.');
    const fields: SchemaField[] = [];
    for (const name of names) {
        const prop = (properties as Record<string, unknown>)[name];
        if (!isRecord(prop)) return no(`Argument "${name}" must be an object schema.`);
        for (const key of Object.keys(prop)) {
            if (!PROP_KEYS.has(key)) return no(`"${key}" (argument "${name}") is not supported by the form.`);
        }
        const type = prop.type;
        if (typeof type !== 'string' || !SCHEMA_FIELD_TYPES.includes(type as SchemaFieldType)) {
            return no(`Argument "${name}" needs a single supported type.`);
        }
        let description = '';
        if (prop.description !== undefined) {
            if (typeof prop.description !== 'string' || prop.description === '') return no(`Argument "${name}" has an unsupported description.`);
            description = prop.description;
        }
        const field: SchemaField = {
            id: newId(), name, type: type as SchemaFieldType, description, required: requiredList.includes(name),
        };
        if (type === 'object') {
            const raw: Record<string, unknown> = {};
            for (const key of Object.keys(prop)) {
                if (key === 'type' || key === 'description') continue;
                if (key === 'enum' || key === 'items') return no(`Argument "${name}" mixes object with "${key}".`);
                raw[key] = prop[key];
            }
            field.rawSchema = raw;
        } else {
            if (prop.properties !== undefined || prop.required !== undefined) return no(`Argument "${name}" has nested properties but is not an object.`);
            if (prop.enum !== undefined) {
                if (type !== 'string') return no(`Argument "${name}": enum is only supported for text.`);
                if (!Array.isArray(prop.enum) || prop.enum.length === 0 || prop.enum.some((v) => typeof v !== 'string')) {
                    return no(`Argument "${name}" has an unsupported enum.`);
                }
                field.enumValues = [...(prop.enum as string[])];
            }
            if (prop.items !== undefined) {
                if (type !== 'array') return no(`Argument "${name}": items is only supported for lists.`);
                const items = prop.items;
                if (!isRecord(items) || Object.keys(items).length !== 1 || !SCHEMA_ITEMS_TYPES.includes(items.type as SchemaItemsType)) {
                    return no(`Argument "${name}" has unsupported items.`);
                }
                field.itemsType = items.type as SchemaItemsType;
            }
            const extra: Record<string, unknown> = {};
            for (const key of EXTRA_KEYS) if (prop[key] !== undefined) extra[key] = prop[key];
            if (Object.keys(extra).length > 0) field.extra = extra;
        }
        fields.push(field);
    }
    return { ok: true, fields, meta };
}

export function fieldsToSchema(fields: SchemaField[], meta: SchemaMeta = {}): Record<string, unknown> | undefined {
    if (fields.length === 0) {
        if (meta.description === undefined && meta.additionalProperties === undefined) return undefined;
        const bare: Record<string, unknown> = { type: 'object' };
        if (meta.description !== undefined) bare.description = meta.description;
        if (meta.additionalProperties !== undefined) bare.additionalProperties = meta.additionalProperties;
        return bare;
    }
    const entries: Array<[string, Record<string, unknown>]> = [];
    const required: string[] = [];
    for (const field of fields) {
        const prop: Record<string, unknown> = { type: field.type };
        if (field.description) prop.description = field.description;
        if (field.type === 'string' && field.enumValues && field.enumValues.length > 0) prop.enum = [...field.enumValues];
        if (field.type === 'array' && field.itemsType) prop.items = { type: field.itemsType };
        if (field.type === 'object' && field.rawSchema) Object.assign(prop, field.rawSchema);
        if (field.type !== 'object' && field.extra) Object.assign(prop, field.extra);
        entries.push([field.name, prop]);
        if (field.required) required.push(field.name);
    }
    // fromEntries defines own properties, so a name like "__proto__" is safe.
    const schema: Record<string, unknown> = { type: 'object', properties: Object.fromEntries(entries) };
    if (required.length > 0) schema.required = required;
    if (meta.description !== undefined) schema.description = meta.description;
    if (meta.additionalProperties !== undefined) schema.additionalProperties = meta.additionalProperties;
    return schema;
}

export function addField(fields: SchemaField[]): SchemaField[] {
    return [...fields, { id: newId(), name: '', type: 'string', description: '', required: false }];
}

export function updateField(fields: SchemaField[], id: string, patch: Partial<Omit<SchemaField, 'id'>>): SchemaField[] {
    return fields.map((field) => {
        if (field.id !== id) return field;
        const base: SchemaField = { ...field };
        if (patch.type && patch.type !== field.type) {
            delete base.enumValues;
            delete base.itemsType;
            delete base.rawSchema;
            delete base.extra;
            if (patch.type === 'object') base.rawSchema = {};
        }
        const next: SchemaField = { ...base, ...patch };
        if (next.type !== 'string' || !next.enumValues || next.enumValues.length === 0) delete next.enumValues;
        return next;
    });
}

export function removeField(fields: SchemaField[], id: string): SchemaField[] {
    return fields.filter((field) => field.id !== id);
}

/** Problems per field id; an empty object means the list would save. */
export function fieldErrors(fields: SchemaField[]): Record<string, SchemaFieldError[]> {
    const result: Record<string, SchemaFieldError[]> = {};
    const seen = new Set<string>();
    for (const field of fields) {
        const errors: SchemaFieldError[] = [];
        if (!NAME.test(field.name)) errors.push('name');
        else if (seen.has(field.name)) errors.push('nameDuplicate');
        else seen.add(field.name);
        if (field.enumValues && field.enumValues.some((v) => typeof v !== 'string' || v.trim() === '')) errors.push('enum');
        if (errors.length > 0) result[field.id] = errors;
    }
    return result;
}
