/**
 * The forms the provider contracts really declare, held against the rules of the generic form
 * (`components/providers/providerFormModel`): a condition (`visibleWhen`) must be one the form can evaluate, and the
 * Azure Blob form must show exactly the fields of the sign-in method that is chosen. The model has its own tests on
 * synthetic forms; this keeps a contract from drifting away from it.
 */
import { describe, expect, it } from 'vitest';
import { providerRegistry, type ProviderFormField, type ProviderFormSchema } from '@/lib/providers';
import { CORE_PROVIDER_CONTRACTS } from '@/lib/providers/contracts';
import {
  allFields,
  isFieldVisible,
  partitionProviderValues,
  visibleSections,
} from '@/components/providers/providerFormModel';

const forms = CORE_PROVIDER_CONTRACTS.flatMap((contract) => (contract.form ? [{ id: contract.id, form: contract.form }] : []));

function visibleNames(form: ProviderFormSchema, values: Record<string, unknown>): string[] {
  return visibleSections(form, values).flatMap((entry) => entry.fields.map((field) => field.name));
}

describe('provider forms: conditions on fields', () => {
  it('has forms to check', () => {
    expect(forms.length).toBeGreaterThan(10);
    expect(forms.some(({ form }) => allFields(form).some((field) => field.visibleWhen))).toBe(true);
  });

  it.each(forms.map(({ id, form }) => [id, form] as const))(
    '%s: every condition names another field of the same form, with values that field can hold',
    (_id, form) => {
      const fields = allFields(form);
      const byName = new Map(fields.map((field) => [field.name, field]));
      expect(byName.size).toBe(fields.length);

      for (const field of fields) {
        const rule = field.visibleWhen;
        if (!rule) continue;
        const source = byName.get(rule.field);
        expect(source, `${field.name} depends on ${rule.field}`).toBeDefined();
        expect(source!.name).not.toBe(field.name);

        const wanted = Array.isArray(rule.equals) ? rule.equals : [rule.equals];
        expect(wanted.length).toBeGreaterThan(0);
        if (source!.type === 'select') {
          const held = (source!.options ?? []).map((option) => option.value);
          for (const value of wanted) expect(held, `${field.name} waits for ${value}`).toContain(value);
        } else if (source!.type === 'switch') {
          for (const value of wanted) expect(['true', 'false']).toContain(value);
        }
        // The dropdown a condition reads must always hold a value: the form needs it to decide.
        if (source!.type === 'select') expect(source!.defaultValue).toBeDefined();

        // A condition never chains back to the field itself.
        const seen = new Set<string>([field.name]);
        for (let at: ProviderFormField | undefined = source; at?.visibleWhen; at = byName.get(at.visibleWhen.field)) {
          expect(seen.has(at.name), `${field.name} loops through ${at.name}`).toBe(false);
          seen.add(at.name);
        }
      }
    },
  );
});

/** The values the edit form opens with for a record that holds `settings`: a field the record lacks shows its default. */
function openedWith(form: ProviderFormSchema, settings: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of allFields(form)) {
    values[field.name] = field.scope === 'settings' || field.scope === 'metadata' ? (settings[field.name] ?? field.defaultValue ?? '') : (field.defaultValue ?? '');
  }
  return values;
}

describe('provider forms: editing a record that was saved without the optional settings', () => {
  const withDefaults = forms.filter(({ form }) => allFields(form).some((field) => field.scope !== 'credentials' && field.defaultValue !== undefined));

  it('has forms with defaults to check', () => {
    expect(withDefaults.map(({ id }) => id)).toEqual(expect.arrayContaining(['aws-s3-files', 's3-compatible-files', 'azure-blob-files']));
  });

  it.each(withDefaults.map(({ id, form }) => [id, form] as const))(
    '%s: saving it with nothing changed writes none of the defaults the form only showed',
    (_id, form) => {
      const opened = openedWith(form, {});

      // a new provider is created with them ...
      const created = partitionProviderValues(form, opened);
      expect(Object.keys(created.settings).length + Object.keys(created.metadata).length).toBeGreaterThan(0);
      // ... an existing one that holds none of them is not given them by an edit
      const edited = partitionProviderValues(form, opened, { settings: {}, metadata: {} });
      expect(edited.settings).toEqual({});
      expect(edited.metadata).toEqual({});
    },
  );

  it('a record of the S3 form saved before the TLS switch existed keeps exactly the settings it holds', () => {
    const form = providerRegistry.getFormSchema('aws-s3-files') as ProviderFormSchema;
    const saved = { region: 'us-east-1', bucket: 'files', endpoint: 'https://minio.internal:9000' };

    const edited = partitionProviderValues(form, openedWith(form, saved), { settings: saved, metadata: {} });

    expect(edited.settings).toEqual(saved);
    expect(edited.settings).not.toHaveProperty('allowInsecureTls');
  });

  it('a record that does hold the switch sends it, and so does one where it was turned on', () => {
    const form = providerRegistry.getFormSchema('aws-s3-files') as ProviderFormSchema;
    const saved = { region: 'us-east-1', bucket: 'files', allowInsecureTls: false };
    expect(partitionProviderValues(form, openedWith(form, saved), { settings: saved }).settings).toEqual(saved);

    const open = { ...openedWith(form, { region: 'us-east-1', bucket: 'files' }), allowInsecureTls: true };
    expect(partitionProviderValues(form, open, { settings: { region: 'us-east-1', bucket: 'files' } }).settings)
      .toEqual({ region: 'us-east-1', bucket: 'files', allowInsecureTls: true });
  });
});

describe('the Azure Blob Storage form', () => {
  const form = providerRegistry.getFormSchema('azure-blob-files') as ProviderFormSchema;
  const common = ['accountName', 'container', 'prefix', 'createContainer', 'authMethod', 'endpoint', 'apiVersion', 'caCertificate', 'allowInsecureTls'];

  it('shows the account key fields until another method is chosen', () => {
    const shown = visibleNames(form, {});
    expect(shown).toEqual(expect.arrayContaining([...common, 'accountKey']));
    expect(shown).not.toEqual(expect.arrayContaining(['sasToken']));
    expect(shown.filter((name) => !common.includes(name))).toEqual(['accountKey']);
  });

  it.each([
    ['accountKey', ['accountKey']],
    ['sas', ['sasToken']],
    ['connectionString', ['connectionString']],
    ['entra', ['entraTenantId', 'clientId', 'clientSecret', 'authorityHost']],
  ])('shows only the fields of %s', (authMethod, own) => {
    const shown = visibleNames(form, { authMethod });
    expect(shown.filter((name) => !common.includes(name)).sort()).toEqual([...own].sort());
    for (const name of common) expect(shown).toContain(name);
  });

  it('submits only the secrets of the chosen method, however many the form still holds', () => {
    const values = {
      authMethod: 'sas',
      accountName: 'acct',
      container: 'files',
      accountKey: 'key-left-over-from-another-method',
      connectionString: 'string-left-over',
      clientSecret: 'secret-left-over',
      sasToken: 'sv=2023&sig=abc',
    };
    const sent = partitionProviderValues(form, values);
    expect(Object.keys(sent.credentials)).toEqual(['sasToken']);
    expect(sent.settings).toMatchObject({ authMethod: 'sas', accountName: 'acct', container: 'files' });
    expect(Object.keys(sent.settings)).not.toContain('clientSecret');
  });

  it('keeps the Entra settings out of the other methods', () => {
    const fields = allFields(form);
    const authority = fields.find((field) => field.name === 'authorityHost')!;
    expect(isFieldVisible(authority, { authMethod: 'entra' }, fields)).toBe(true);
    expect(isFieldVisible(authority, { authMethod: 'sas' }, fields)).toBe(false);
    expect(isFieldVisible(authority, {}, fields)).toBe(false);
  });

  it('puts every secret in the credentials and every other field in the settings', () => {
    const fields = allFields(form);
    for (const field of fields) {
      if (field.type === 'password') expect(field.scope, field.name).toBe('credentials');
      else expect(field.scope, field.name).toBe('settings');
    }
  });
});

describe('file provider contracts', () => {
  const fileIds = providerRegistry.listDescriptors('file').map((descriptor) => descriptor.id);

  it('lists the five file drivers', () => {
    expect(fileIds.sort()).toEqual(['aws-s3-files', 'azure-blob-files', 'local-filesystem', 'mongodb-gridfs-files', 's3-compatible-files']);
  });

  it.each(['aws-s3-files', 'azure-blob-files', 'local-filesystem', 'mongodb-gridfs-files', 's3-compatible-files'])(
    '%s says where its files are (or that it does not show it)',
    (id) => {
      const contract = providerRegistry.getContract(id);
      expect(typeof contract.describeStorageLocation).toBe('function');
    },
  );
});
