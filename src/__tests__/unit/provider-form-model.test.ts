/**
 * The generic provider form's view-model: which fields apply to the form as it stands (`visibleWhen`), what the form
 * submits (never a hidden field, never a blank one), which required fields are still empty, and where the stored-secret
 * cue shows. Pure functions.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderFormField, ProviderFormSchema } from '@/lib/providers';
import {
  allFields,
  isBlankValue,
  isFieldVisible,
  missingRequiredFields,
  partitionProviderValues,
  providerRequestError,
  ProviderRequestError,
  showsStoredSecretCue,
  storedCredentialFields,
  visibilitySourceNames,
  visibleSections,
} from '@/components/providers/providerFormModel';

/** An Azure Blob style form: the way to sign in decides which credential fields apply. */
const AZURE_LIKE: ProviderFormSchema = {
  sections: [
    {
      title: 'Location',
      fields: [
        { name: 'accountName', label: 'Account name', type: 'text', scope: 'settings', required: true },
        { name: 'container', label: 'Container', type: 'text', scope: 'settings', required: true },
        { name: 'prefix', label: 'Prefix', type: 'text', scope: 'settings' },
      ],
    },
    {
      title: 'Sign in',
      fields: [
        {
          name: 'authMethod',
          label: 'Method',
          type: 'select',
          scope: 'settings',
          required: true,
          defaultValue: 'accountKey',
          options: [
            { label: 'Account key', value: 'accountKey' },
            { label: 'SAS token', value: 'sas' },
            { label: 'Service principal', value: 'servicePrincipal' },
          ],
        },
        { name: 'accountKey', label: 'Account key', type: 'password', required: true, visibleWhen: { field: 'authMethod', equals: 'accountKey' } },
        { name: 'sasToken', label: 'SAS token', type: 'password', required: true, visibleWhen: { field: 'authMethod', equals: 'sas' } },
        { name: 'tenantId', label: 'Tenant ID', type: 'text', scope: 'settings', required: true, visibleWhen: { field: 'authMethod', equals: 'servicePrincipal' } },
        { name: 'clientId', label: 'Client ID', type: 'text', scope: 'settings', required: true, visibleWhen: { field: 'authMethod', equals: 'servicePrincipal' } },
        { name: 'clientSecret', label: 'Client secret', type: 'password', required: true, visibleWhen: { field: 'authMethod', equals: 'servicePrincipal' } },
      ],
    },
    {
      title: 'Service principal only',
      fields: [
        { name: 'authority', label: 'Authority', type: 'text', scope: 'settings', visibleWhen: { field: 'authMethod', equals: ['servicePrincipal'] } },
      ],
    },
  ],
};

const fieldsOf = (schema: ProviderFormSchema) => allFields(schema);
const named = (schema: ProviderFormSchema, name: string): ProviderFormField => fieldsOf(schema).find((f) => f.name === name)!;
const visible = (values: Record<string, unknown>, schema = AZURE_LIKE) =>
  visibleSections(schema, values).flatMap((entry) => entry.fields.map((f) => f.name));

describe('isBlankValue', () => {
  it('nothing, empty and whitespace-only strings, and NaN are blank; zero, false and any text are not', () => {
    for (const blank of [undefined, null, '', '   ', '\n\t', Number.NaN]) expect(isBlankValue(blank), String(blank)).toBe(true);
    for (const value of [0, false, 'x', ' x ', 5, [], {}]) expect(isBlankValue(value), String(value)).toBe(false);
  });
});

describe('isFieldVisible', () => {
  it('a field without a condition always applies', () => {
    expect(isFieldVisible(named(AZURE_LIKE, 'container'), {}, fieldsOf(AZURE_LIKE))).toBe(true);
  });

  it('compares the field the condition names to the wanted value, falling back to that field\'s default until something is entered', () => {
    const fields = fieldsOf(AZURE_LIKE);
    const accountKey = named(AZURE_LIKE, 'accountKey');
    const sasToken = named(AZURE_LIKE, 'sasToken');
    // nothing entered: the default (accountKey) stands
    expect(isFieldVisible(accountKey, {}, fields)).toBe(true);
    expect(isFieldVisible(sasToken, {}, fields)).toBe(false);
    // a blank entry is "nothing entered" too
    expect(isFieldVisible(accountKey, { authMethod: '' }, fields)).toBe(true);
    expect(isFieldVisible(accountKey, { authMethod: null }, fields)).toBe(true);
    // chosen
    expect(isFieldVisible(accountKey, { authMethod: 'sas' }, fields)).toBe(false);
    expect(isFieldVisible(sasToken, { authMethod: 'sas' }, fields)).toBe(true);
  });

  it('a list of wanted values matches any of them', () => {
    const field: ProviderFormField = { name: 'x', label: 'X', type: 'text', visibleWhen: { field: 'mode', equals: ['a', 'b'] } };
    const source: ProviderFormField = { name: 'mode', label: 'Mode', type: 'select' };
    const fields = [source, field];
    expect(isFieldVisible(field, { mode: 'a' }, fields)).toBe(true);
    expect(isFieldVisible(field, { mode: 'b' }, fields)).toBe(true);
    expect(isFieldVisible(field, { mode: 'c' }, fields)).toBe(false);
    // no value and no default: it does not match
    expect(isFieldVisible(field, {}, fields)).toBe(false);
  });

  it('compares a switch as "true" / "false", with its default standing in', () => {
    const toggle: ProviderFormField = { name: 'usePathStyle', label: 'Path style', type: 'switch', defaultValue: false };
    const dependent: ProviderFormField = { name: 'x', label: 'X', type: 'text', visibleWhen: { field: 'usePathStyle', equals: 'true' } };
    const fields = [toggle, dependent];
    expect(isFieldVisible(dependent, {}, fields)).toBe(false);
    expect(isFieldVisible(dependent, { usePathStyle: false }, fields)).toBe(false);
    expect(isFieldVisible(dependent, { usePathStyle: true }, fields)).toBe(true);
  });

  it('a field with nothing entered and no default compares as the empty text', () => {
    const source: ProviderFormField = { name: 'mode', label: 'Mode', type: 'select' };
    const whenEmpty: ProviderFormField = { name: 'x', label: 'X', type: 'text', visibleWhen: { field: 'mode', equals: '' } };
    const whenEmptyOrA: ProviderFormField = { name: 'y', label: 'Y', type: 'text', visibleWhen: { field: 'mode', equals: ['', 'a'] } };
    const whenUndefinedWord: ProviderFormField = { name: 'z', label: 'Z', type: 'text', visibleWhen: { field: 'mode', equals: 'undefined' } };
    const fields = [source, whenEmpty, whenEmptyOrA, whenUndefinedWord];

    for (const unset of [{}, { mode: '' }, { mode: null }, { mode: undefined }]) {
      expect(isFieldVisible(whenEmpty, unset, fields), JSON.stringify(unset)).toBe(true);
      expect(isFieldVisible(whenEmptyOrA, unset, fields), JSON.stringify(unset)).toBe(true);
      expect(isFieldVisible(whenUndefinedWord, unset, fields), JSON.stringify(unset)).toBe(false);
    }
    expect(isFieldVisible(whenEmpty, { mode: 'a' }, fields)).toBe(false);
    expect(isFieldVisible(whenEmptyOrA, { mode: 'a' }, fields)).toBe(true);
  });

  it('a switch that was never set is drawn off, so it compares as "false" - the same as one that was switched off', () => {
    // no default: the form opens the switch with nothing in it and draws it unchecked
    const toggle: ProviderFormField = { name: 'useProxy', label: 'Use proxy', type: 'switch', scope: 'settings' };
    const whenOff: ProviderFormField = { name: 'direct', label: 'Direct', type: 'text', visibleWhen: { field: 'useProxy', equals: 'false' } };
    const whenOn: ProviderFormField = { name: 'proxy', label: 'Proxy', type: 'text', visibleWhen: { field: 'useProxy', equals: 'true' } };
    const fields = [toggle, whenOff, whenOn];

    for (const unset of [{}, { useProxy: '' }, { useProxy: null }, { useProxy: undefined }]) {
      expect(isFieldVisible(whenOff, unset, fields), JSON.stringify(unset)).toBe(true);
      expect(isFieldVisible(whenOn, unset, fields), JSON.stringify(unset)).toBe(false);
    }
    // toggled on and off again: the same form as before it was touched
    expect(isFieldVisible(whenOff, { useProxy: false }, fields)).toBe(true);
    expect(isFieldVisible(whenOn, { useProxy: false }, fields)).toBe(false);
    expect(isFieldVisible(whenOff, { useProxy: true }, fields)).toBe(false);
    expect(isFieldVisible(whenOn, { useProxy: true }, fields)).toBe(true);
  });

  it('a switch with a default compares by what it shows until it is touched', () => {
    const toggle: ProviderFormField = { name: 'verify', label: 'Verify', type: 'switch', defaultValue: true };
    const dependent: ProviderFormField = { name: 'ca', label: 'CA', type: 'text', visibleWhen: { field: 'verify', equals: 'true' } };
    expect(isFieldVisible(dependent, {}, [toggle, dependent])).toBe(true);
    expect(isFieldVisible(dependent, { verify: '' }, [toggle, dependent])).toBe(true);
    expect(isFieldVisible(dependent, { verify: false }, [toggle, dependent])).toBe(false);
  });

  it('a field whose condition reads a hidden field is hidden too (its value belongs to a form no longer in play)', () => {
    const a: ProviderFormField = { name: 'a', label: 'A', type: 'select', defaultValue: 'off' };
    const b: ProviderFormField = { name: 'b', label: 'B', type: 'select', defaultValue: 'x', visibleWhen: { field: 'a', equals: 'on' } };
    const c: ProviderFormField = { name: 'c', label: 'C', type: 'text', visibleWhen: { field: 'b', equals: 'x' } };
    const fields = [a, b, c];
    expect(isFieldVisible(b, { a: 'off' }, fields)).toBe(false);
    expect(isFieldVisible(c, { a: 'off', b: 'x' }, fields)).toBe(false);
    expect(isFieldVisible(b, { a: 'on' }, fields)).toBe(true);
    expect(isFieldVisible(c, { a: 'on', b: 'x' }, fields)).toBe(true);
  });

  it('a condition on a field the form does not have, or one that chases itself, never hides anything', () => {
    const orphan: ProviderFormField = { name: 'o', label: 'O', type: 'text', visibleWhen: { field: 'missing', equals: 'x' } };
    expect(isFieldVisible(orphan, {}, [orphan])).toBe(true);

    const p: ProviderFormField = { name: 'p', label: 'P', type: 'text', visibleWhen: { field: 'q', equals: 'x' } };
    const q: ProviderFormField = { name: 'q', label: 'Q', type: 'text', visibleWhen: { field: 'p', equals: 'x' } };
    expect(isFieldVisible(p, {}, [p, q])).toBe(true);
    expect(isFieldVisible(q, {}, [p, q])).toBe(true);
  });
});

describe('visibleSections', () => {
  it('shows the fields of the chosen way to sign in, and leaves out a section left without fields', () => {
    expect(visible({})).toEqual(['accountName', 'container', 'prefix', 'authMethod', 'accountKey']);
    expect(visible({ authMethod: 'sas' })).toEqual(['accountName', 'container', 'prefix', 'authMethod', 'sasToken']);
    expect(visible({ authMethod: 'servicePrincipal' })).toEqual([
      'accountName', 'container', 'prefix', 'authMethod', 'tenantId', 'clientId', 'clientSecret', 'authority',
    ]);

    expect(visibleSections(AZURE_LIKE, {}).map((entry) => entry.section.title)).toEqual(['Location', 'Sign in']);
    expect(visibleSections(AZURE_LIKE, { authMethod: 'servicePrincipal' }).map((entry) => entry.section.title)).toEqual([
      'Location', 'Sign in', 'Service principal only',
    ]);
  });

  it('no schema is no sections', () => {
    expect(visibleSections(null, {})).toEqual([]);
    expect(visibleSections(undefined, {})).toEqual([]);
  });
});

describe('partitionProviderValues', () => {
  it('buckets the entered values by scope (credentials by default) and skips blank ones', () => {
    const buckets = partitionProviderValues(AZURE_LIKE, {
      accountName: 'acct',
      container: 'files',
      prefix: '   ',
      authMethod: 'accountKey',
      accountKey: 'KEY==',
    });
    expect(buckets).toEqual({
      credentials: { accountKey: 'KEY==' },
      settings: { accountName: 'acct', container: 'files', authMethod: 'accountKey' },
      metadata: {},
    });
  });

  it('a hidden credential is never submitted, whatever the form still holds', () => {
    // typed an account key, then switched to a SAS token: the account key is still in the form state
    const buckets = partitionProviderValues(AZURE_LIKE, {
      accountName: 'acct',
      container: 'files',
      authMethod: 'sas',
      accountKey: 'KEY==',
      sasToken: 'sv=2024&sig=abc',
      clientSecret: 'leftover',
      tenantId: 'leftover-tenant',
    });
    expect(buckets.credentials).toEqual({ sasToken: 'sv=2024&sig=abc' });
    expect(buckets.settings).toEqual({ accountName: 'acct', container: 'files', authMethod: 'sas' });
    expect(JSON.stringify(buckets)).not.toContain('KEY==');
    expect(JSON.stringify(buckets)).not.toContain('leftover');
  });

  it('with the method left on its default, the default method\'s fields are submitted', () => {
    const buckets = partitionProviderValues(AZURE_LIKE, { accountName: 'acct', container: 'files', accountKey: 'KEY==' });
    expect(buckets.credentials).toEqual({ accountKey: 'KEY==' });
  });

  it('keeps zero, false and metadata values; no schema submits nothing', () => {
    const schema: ProviderFormSchema = {
      sections: [{ fields: [
        { name: 'retries', label: 'Retries', type: 'number', scope: 'settings' },
        { name: 'verify', label: 'Verify', type: 'switch', scope: 'settings' },
        { name: 'note', label: 'Note', type: 'text', scope: 'metadata' },
      ] }],
    };
    expect(partitionProviderValues(schema, { retries: 0, verify: false, note: 'hi' })).toEqual({
      credentials: {},
      settings: { retries: 0, verify: false },
      metadata: { note: 'hi' },
    });
    expect(partitionProviderValues(null, { a: 1 })).toEqual({ credentials: {}, settings: {}, metadata: {} });
  });

  describe('editing a saved provider', () => {
    const SCHEMA: ProviderFormSchema = {
      sections: [{ fields: [
        { name: 'region', label: 'Region', type: 'text', scope: 'settings', required: true, defaultValue: 'us-east-1' },
        { name: 'endpoint', label: 'Endpoint', type: 'text', scope: 'settings' },
        { name: 'allowInsecureTls', label: 'Allow insecure TLS', type: 'switch', scope: 'settings', defaultValue: false },
        { name: 'retries', label: 'Retries', type: 'number', scope: 'settings', defaultValue: 3 },
        { name: 'tier', label: 'Tier', type: 'select', scope: 'metadata', defaultValue: 'standard' },
        { name: 'accessKeyId', label: 'Access key ID', type: 'text', defaultValue: 'AKIA-DEFAULT' },
      ] }],
    };
    /** The values the form opens with for a record that has these settings: the fields' defaults fill the gaps. */
    const opened = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      region: 'us-east-1', endpoint: '', allowInsecureTls: false, retries: 3, tier: 'standard', accessKeyId: '', ...settings, ...extra,
    });

    it('a setting that only shows the field\'s default, because the record has no such key, is not submitted', () => {
      // a record saved before the switch existed: the label is the only thing edited
      const legacy = { region: 'eu-west-1', endpoint: 'https://minio.internal:9000' };
      const buckets = partitionProviderValues(SCHEMA, opened(legacy), { settings: legacy, metadata: {} });

      expect(buckets.settings).toEqual({ region: 'eu-west-1', endpoint: 'https://minio.internal:9000' });
      expect(buckets.settings).not.toHaveProperty('allowInsecureTls');
      expect(buckets.settings).not.toHaveProperty('retries');
      expect(buckets.metadata).toEqual({});
    });

    it('a record that holds the key keeps submitting it, whatever it holds', () => {
      const saved = { region: 'us-east-1', allowInsecureTls: false, retries: 3 };
      const sent = partitionProviderValues(SCHEMA, opened(saved), { settings: saved, metadata: { tier: 'standard' } });

      expect(sent.settings).toEqual({ region: 'us-east-1', allowInsecureTls: false, retries: 3 });
      expect(sent.metadata).toEqual({ tier: 'standard' });
    });

    it('a value changed to something else is submitted - and so is one changed back to the default once the record holds the key', () => {
      const saved = { region: 'eu-west-1' };
      expect(partitionProviderValues(SCHEMA, opened(saved, { allowInsecureTls: true, retries: 5 }), { settings: saved }).settings)
        .toEqual({ region: 'eu-west-1', allowInsecureTls: true, retries: 5 });

      const holding = { region: 'eu-west-1', allowInsecureTls: true };
      expect(partitionProviderValues(SCHEMA, opened(holding, { allowInsecureTls: false }), { settings: holding }).settings)
        .toEqual({ region: 'eu-west-1', allowInsecureTls: false });
    });

    it('a default typed in again for a record that lacks the key is the same as not touching it', () => {
      const saved = { region: 'eu-west-1' };
      // the text of a number box and the number itself are the same default
      const sent = partitionProviderValues(SCHEMA, opened(saved, { retries: '3' }), { settings: saved });
      expect(sent.settings).toEqual({ region: 'eu-west-1' });
    });

    it('a record without settings (or without metadata) lacks every key', () => {
      const sent = partitionProviderValues(SCHEMA, opened({}), { settings: undefined, metadata: null });
      expect(sent.settings).toEqual({});
      expect(sent.metadata).toEqual({});
    });

    it('credentials are not affected: a default is still submitted, and nothing is read back from the record', () => {
      const sent = partitionProviderValues(SCHEMA, opened({}, { accessKeyId: 'AKIA-DEFAULT' }), { settings: {}, metadata: {} });
      expect(sent.credentials).toEqual({ accessKeyId: 'AKIA-DEFAULT' });
    });

    it('a new provider (nothing stored) submits every value it holds, defaults included', () => {
      const sent = partitionProviderValues(SCHEMA, opened({}));
      expect(sent.settings).toEqual({ region: 'us-east-1', allowInsecureTls: false, retries: 3 });
      expect(sent.metadata).toEqual({ tier: 'standard' });
    });
  });
});

describe('missingRequiredFields', () => {
  it('lists the required fields that apply and are still empty', () => {
    expect(missingRequiredFields(AZURE_LIKE, { authMethod: 'accountKey' }).map((f) => f.name)).toEqual([
      'accountName', 'container', 'accountKey',
    ]);
    expect(missingRequiredFields(AZURE_LIKE, { accountName: 'a', container: 'c', authMethod: 'accountKey', accountKey: 'k' })).toEqual([]);
    // a required field that holds nothing is missing, a default only stands in for a condition (the form loads defaults into its values)
    expect(missingRequiredFields(AZURE_LIKE, { accountName: 'a', container: 'c', accountKey: 'k' }).map((f) => f.name)).toEqual(['authMethod']);
  });

  it('a hidden required field is not asked for', () => {
    // SAS token chosen: the account key and the service principal fields do not apply
    const missing = missingRequiredFields(AZURE_LIKE, { accountName: 'a', container: 'c', authMethod: 'sas' });
    expect(missing.map((f) => f.name)).toEqual(['sasToken']);
    // service principal chosen
    expect(missingRequiredFields(AZURE_LIKE, { accountName: 'a', container: 'c', authMethod: 'servicePrincipal' }).map((f) => f.name))
      .toEqual(['tenantId', 'clientId', 'clientSecret']);
  });

  it('whitespace counts as empty; the label travels with the name', () => {
    expect(missingRequiredFields(AZURE_LIKE, { accountName: '   ', container: 'c', authMethod: 'accountKey', accountKey: 'k' })).toEqual([
      { name: 'accountName', label: 'Account name' },
    ]);
  });

  it('a required credential field the record stores may stay blank - a required setting may not', () => {
    const values = { accountName: '', container: 'c', authMethod: 'accountKey', accountKey: '' };
    expect(missingRequiredFields(AZURE_LIKE, values).map((f) => f.name)).toEqual(['accountName', 'accountKey']);
    expect(missingRequiredFields(AZURE_LIKE, values, { storedCredentialFields: new Set() }).map((f) => f.name)).toEqual(['accountName', 'accountKey']);
    expect(missingRequiredFields(AZURE_LIKE, values, { storedCredentialFields: new Set(['accountKey']) }).map((f) => f.name)).toEqual(['accountName']);
    // a required choice (a setting) is still asked for
    expect(
      missingRequiredFields(AZURE_LIKE, { accountName: 'a', container: 'c', authMethod: '', accountKey: '' }, { storedCredentialFields: new Set(['accountKey']) })
        .map((f) => f.name),
    ).toEqual(['authMethod']);
  });

  it('a required credential the record does not store is asked for, wherever the stored one sits', () => {
    const stored = { storedCredentialFields: new Set(['accountKey']) };
    // switched to a way to sign in the record never used: its secret has to be given
    expect(missingRequiredFields(AZURE_LIKE, { accountName: 'a', container: 'c', authMethod: 'sas' }, stored).map((f) => f.name)).toEqual(['sasToken']);
    expect(missingRequiredFields(AZURE_LIKE, { accountName: 'a', container: 'c', authMethod: 'sas', sasToken: 'sv=2024&sig=abc' }, stored)).toEqual([]);
    expect(missingRequiredFields(AZURE_LIKE, { accountName: 'a', container: 'c', authMethod: 'servicePrincipal', tenantId: 't', clientId: 'c' }, stored).map((f) => f.name))
      .toEqual(['clientSecret']);
    // back on the method it stored: the stored key stands
    expect(missingRequiredFields(AZURE_LIKE, { accountName: 'a', container: 'c', authMethod: 'accountKey' }, stored)).toEqual([]);
  });

  it('the stored set only excuses credentials: a setting of the same name is still required', () => {
    const schema: ProviderFormSchema = { sections: [{ fields: [{ name: 'token', label: 'Token', type: 'text', scope: 'settings', required: true }] }] };
    expect(missingRequiredFields(schema, {}, { storedCredentialFields: new Set(['token']) }).map((f) => f.name)).toEqual(['token']);
  });

  it('a switch always holds a value and is never missing', () => {
    const schema: ProviderFormSchema = { sections: [{ fields: [{ name: 's', label: 'S', type: 'switch', required: true, scope: 'settings' }] }] };
    expect(missingRequiredFields(schema, {})).toEqual([]);
  });

  it('no schema misses nothing', () => {
    expect(missingRequiredFields(null, {})).toEqual([]);
  });
});

describe('storedCredentialFields', () => {
  it('a read that names the stored fields decides: only those credential fields of the schema', () => {
    expect([...storedCredentialFields(AZURE_LIKE, { hasCredentials: true, credentialFields: ['accountKey'] })]).toEqual(['accountKey']);
    // a stored name the form has no field for, and a setting of the same name, are not credential fields of the form
    expect([...storedCredentialFields(AZURE_LIKE, { hasCredentials: true, credentialFields: ['accountKey', 'legacyToken', 'container'] })]).toEqual(['accountKey']);
    expect([...storedCredentialFields(AZURE_LIKE, { hasCredentials: true, credentialFields: ['sasToken', 'accountKey'] })].sort()).toEqual(['accountKey', 'sasToken']);
  });

  it('a provider whose stored set is empty stores nothing, whatever else it says', () => {
    expect(storedCredentialFields(AZURE_LIKE, { hasCredentials: true, credentialFields: [] }).size).toBe(0);
    expect(storedCredentialFields(AZURE_LIKE, { hasCredentials: false, credentialFields: [] }).size).toBe(0);
  });

  it('a read that only says credentials are stored counts every credential field as stored; no credentials, none', () => {
    expect([...storedCredentialFields(AZURE_LIKE, { hasCredentials: true })].sort()).toEqual(['accountKey', 'clientSecret', 'sasToken']);
    expect(storedCredentialFields(AZURE_LIKE, { hasCredentials: false }).size).toBe(0);
    expect(storedCredentialFields(AZURE_LIKE, {}).size).toBe(0);
  });

  it('no provider, no schema', () => {
    expect(storedCredentialFields(AZURE_LIKE, null).size).toBe(0);
    expect(storedCredentialFields(AZURE_LIKE, undefined).size).toBe(0);
    expect(storedCredentialFields(null, { hasCredentials: true }).size).toBe(0);
  });
});

describe('showsStoredSecretCue', () => {
  const password: ProviderFormField = { name: 'secretAccessKey', label: 'Secret', type: 'password' };
  const stored = new Set(['secretAccessKey', 'accessKeyId', 'serviceAccountKey']);

  it('a credential field the record stores says so, whatever its input type', () => {
    expect(showsStoredSecretCue(password, stored)).toBe(true);
    expect(showsStoredSecretCue({ ...password, scope: 'credentials' }, stored)).toBe(true);
    expect(showsStoredSecretCue({ name: 'accessKeyId', label: 'Access key ID', type: 'text' }, stored)).toBe(true);
    expect(showsStoredSecretCue({ name: 'serviceAccountKey', label: 'Service account key', type: 'textarea' }, stored)).toBe(true);
  });

  it('a field without an input type is drawn as a text box, so it says so too', () => {
    expect(showsStoredSecretCue({ name: 'accessKeyId', label: 'Access key ID' } as ProviderFormField, stored)).toBe(true);
    expect(showsStoredSecretCue({ name: 'sessionToken', label: 'Session token' } as ProviderFormField, stored)).toBe(false);
  });

  it('one the record does not store never claims to, even a password', () => {
    expect(showsStoredSecretCue({ ...password, name: 'sessionToken' }, stored)).toBe(false);
    expect(showsStoredSecretCue(password, new Set())).toBe(false);
    expect(showsStoredSecretCue(password, undefined)).toBe(false);
  });

  it('a setting is not a stored credential, and an input without a placeholder has no cue', () => {
    expect(showsStoredSecretCue({ ...password, scope: 'settings' }, stored)).toBe(false);
    expect(showsStoredSecretCue({ ...password, scope: 'metadata' }, stored)).toBe(false);
    expect(showsStoredSecretCue({ ...password, type: 'select' }, stored)).toBe(false);
    expect(showsStoredSecretCue({ ...password, type: 'number' }, stored)).toBe(false);
    expect(showsStoredSecretCue({ ...password, type: 'switch' }, stored)).toBe(false);
  });
});

describe('providerRequestError', () => {
  it('carries the text of a refusal and the field it is about', () => {
    const error = providerRequestError({ error: 'Enter the SAS token.', code: 'provider_settings_invalid', field: 'sasToken' }, 'Failed to update provider');
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Enter the SAS token.');
    expect(error.field).toBe('sasToken');
  });

  it('falls back to the caller\'s sentence, and names no field the reply did not name', () => {
    for (const reply of [null, undefined, 'nope', 42, {}, { error: '' }, { error: '   ' }, { error: { nested: true } }]) {
      const error = providerRequestError(reply, 'Failed to update provider');
      expect(error.message, JSON.stringify(reply)).toBe('Failed to update provider');
      expect(error.field, JSON.stringify(reply)).toBeUndefined();
    }
    expect(providerRequestError({ error: 'Nope.', field: '' }, 'x').field).toBeUndefined();
    expect(providerRequestError({ error: 'Nope.', field: 7 }, 'x').field).toBeUndefined();
  });
});

describe('visibilitySourceNames', () => {
  it('names the fields other fields\' conditions read', () => {
    expect([...visibilitySourceNames(fieldsOf(AZURE_LIKE))]).toEqual(['authMethod']);
    expect(visibilitySourceNames([]).size).toBe(0);
  });
});
