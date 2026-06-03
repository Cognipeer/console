'use client';

/**
 * Structured-output schema editor with two modes:
 *  - Builder: define fields visually (name, type, required, description),
 *    incl. enums, arrays of primitives, and one level of nested objects.
 *  - JSON: raw JSON Schema textarea.
 * Emits the resulting JSON Schema object via onChange (or undefined when empty).
 */

import { useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Button,
  Group,
  Select,
  Stack,
  Switch,
  Tabs,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';

type Primitive = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'enum';
type FieldType = Primitive | 'array' | 'object';

interface SubField {
  id: string;
  name: string;
  type: Primitive;
  required: boolean;
  description?: string;
  enumValues?: string;
}
interface Field {
  id: string;
  name: string;
  type: FieldType;
  required: boolean;
  description?: string;
  enumValues?: string;
  itemType?: Exclude<Primitive, 'enum'>;
  fields?: SubField[];
}

const PRIMITIVE_OPTIONS = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Integer' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'enum', label: 'Enum' },
];
const FIELD_OPTIONS = [...PRIMITIVE_OPTIONS, { value: 'array', label: 'Array' }, { value: 'object', label: 'Object' }];

function primitiveSchema(type: Primitive, description?: string, enumValues?: string): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (description) base.description = description;
  switch (type) {
    case 'number': return { type: 'number', ...base };
    case 'integer': return { type: 'integer', ...base };
    case 'boolean': return { type: 'boolean', ...base };
    case 'date': return { type: 'string', format: 'date', ...base };
    case 'enum': return { type: 'string', enum: (enumValues ?? '').split(',').map((s) => s.trim()).filter(Boolean), ...base };
    default: return { type: 'string', ...base };
  }
}

function buildSchema(fields: Field[]): Record<string, unknown> | undefined {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of fields) {
    if (!f.name.trim()) continue;
    let schema: Record<string, unknown>;
    if (f.type === 'array') {
      schema = { type: 'array', items: primitiveSchema((f.itemType ?? 'string') as Primitive) };
      if (f.description) schema.description = f.description;
    } else if (f.type === 'object') {
      const props: Record<string, unknown> = {};
      const req: string[] = [];
      for (const sf of f.fields ?? []) {
        if (!sf.name.trim()) continue;
        props[sf.name.trim()] = primitiveSchema(sf.type, sf.description, sf.enumValues);
        if (sf.required) req.push(sf.name.trim());
      }
      schema = { type: 'object', properties: props };
      if (req.length) schema.required = req;
      if (f.description) schema.description = f.description;
    } else {
      schema = primitiveSchema(f.type, f.description, f.enumValues);
    }
    properties[f.name.trim()] = schema;
    if (f.required) required.push(f.name.trim());
  }
  if (Object.keys(properties).length === 0) return undefined;
  const result: Record<string, unknown> = { type: 'object', properties };
  if (required.length) result.required = required;
  return result;
}

export default function SchemaBuilder({
  value,
  onChange,
}: {
  value?: Record<string, unknown>;
  onChange: (schema: Record<string, unknown> | undefined) => void;
}) {
  const counter = useRef(0);
  const newId = () => `f${counter.current++}`;
  const [mode, setMode] = useState<string>('builder');
  const [fields, setFields] = useState<Field[]>([]);
  const [jsonText, setJsonText] = useState<string>(value ? JSON.stringify(value, null, 2) : '');

  // Re-emit whenever builder fields change (builder is source of truth in builder mode).
  useEffect(() => {
    if (mode === 'builder') onChange(buildSchema(fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, mode]);

  const addField = () =>
    setFields((prev) => [...prev, { id: newId(), name: '', type: 'string', required: false }]);
  const updateField = (id: string, patch: Partial<Field>) =>
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const removeField = (id: string) => setFields((prev) => prev.filter((f) => f.id !== id));
  const addSub = (fid: string) =>
    updateFieldFn(fid, (f) => ({ ...f, fields: [...(f.fields ?? []), { id: newId(), name: '', type: 'string', required: false }] }));
  const updateFieldFn = (id: string, fn: (f: Field) => Field) =>
    setFields((prev) => prev.map((f) => (f.id === id ? fn(f) : f)));

  return (
    <Tabs
      value={mode}
      onChange={(v) => {
        if (!v) return;
        if (v === 'json') setJsonText(JSON.stringify(buildSchema(fields) ?? {}, null, 2));
        setMode(v);
      }}
    >
      <Tabs.List>
        <Tabs.Tab value="builder">Builder</Tabs.Tab>
        <Tabs.Tab value="json">JSON</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="builder" pt="sm">
        <Stack gap="xs">
          {fields.map((f) => (
            <div key={f.id} style={{ border: '1px solid var(--ds-border)', borderRadius: 8, padding: 8 }}>
              <Group gap="xs" align="flex-end" wrap="nowrap">
                <TextInput label="Field" placeholder="name" value={f.name} onChange={(e) => updateField(f.id, { name: e.currentTarget.value })} style={{ flex: 1 }} />
                <Select label="Type" data={FIELD_OPTIONS} value={f.type} onChange={(v) => updateField(f.id, { type: (v as FieldType) ?? 'string' })} w={120} />
                {f.type === 'array' && (
                  <Select label="Items" data={PRIMITIVE_OPTIONS.filter((o) => o.value !== 'enum')} value={f.itemType ?? 'string'} onChange={(v) => updateField(f.id, { itemType: (v as Field['itemType']) ?? 'string' })} w={110} />
                )}
                <Switch label="Required" checked={f.required} onChange={(e) => updateField(f.id, { required: e.currentTarget.checked })} mb={6} />
                <ActionIcon color="red" variant="subtle" onClick={() => removeField(f.id)} mb={6}><IconTrash size={16} /></ActionIcon>
              </Group>
              {f.type === 'enum' && (
                <TextInput mt={6} label="Enum values (comma separated)" value={f.enumValues ?? ''} onChange={(e) => updateField(f.id, { enumValues: e.currentTarget.value })} />
              )}
              <TextInput mt={6} label="Description" value={f.description ?? ''} onChange={(e) => updateField(f.id, { description: e.currentTarget.value })} />
              {f.type === 'object' && (
                <Stack gap={6} mt={8} pl="md">
                  {(f.fields ?? []).map((sf) => (
                    <Group key={sf.id} gap="xs" align="flex-end" wrap="nowrap">
                      <TextInput label="Sub-field" placeholder="name" value={sf.name} onChange={(e) => updateFieldFn(f.id, (cur) => ({ ...cur, fields: (cur.fields ?? []).map((x) => x.id === sf.id ? { ...x, name: e.target.value } : x) }))} style={{ flex: 1 }} />
                      <Select label="Type" data={PRIMITIVE_OPTIONS} value={sf.type} onChange={(v) => updateFieldFn(f.id, (cur) => ({ ...cur, fields: (cur.fields ?? []).map((x) => x.id === sf.id ? { ...x, type: (v as Primitive) ?? 'string' } : x) }))} w={120} />
                      <Switch label="Req" checked={sf.required} onChange={(e) => updateFieldFn(f.id, (cur) => ({ ...cur, fields: (cur.fields ?? []).map((x) => x.id === sf.id ? { ...x, required: e.target.checked } : x) }))} mb={6} />
                      <ActionIcon color="red" variant="subtle" mb={6} onClick={() => updateFieldFn(f.id, (cur) => ({ ...cur, fields: (cur.fields ?? []).filter((x) => x.id !== sf.id) }))}><IconTrash size={14} /></ActionIcon>
                    </Group>
                  ))}
                  <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => addSub(f.id)} style={{ alignSelf: 'flex-start' }}>Sub-field</Button>
                </Stack>
              )}
            </div>
          ))}
          <Button variant="light" leftSection={<IconPlus size={14} />} onClick={addField} style={{ alignSelf: 'flex-start' }}>Add field</Button>
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="json" pt="sm">
        <Textarea
          autosize
          minRows={8}
          placeholder='{"type":"object","properties":{...}}'
          value={jsonText}
          onChange={(e) => {
            setJsonText(e.currentTarget.value);
            try {
              const parsed = e.currentTarget.value.trim() ? (JSON.parse(e.currentTarget.value) as Record<string, unknown>) : undefined;
              onChange(parsed);
            } catch {
              /* keep last valid until parseable */
            }
          }}
        />
      </Tabs.Panel>
    </Tabs>
  );
}
