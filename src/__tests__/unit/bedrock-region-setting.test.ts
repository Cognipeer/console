/**
 * Unit tests — the Bedrock region is typed in, and checked when the provider is saved
 *
 * The form offered four regions in a dropdown (us-east-1, us-west-2, eu-central-1, ap-southeast-1), so a Bedrock
 * account in any other region (eu-west-1, ap-northeast-1, ca-central-1, us-gov-west-1, ...) could not be connected. The
 * field is free text now; `validateSettings` keeps anything that is not an AWS region id out of the hostname the client
 * builds from it, and a provider that is already stored keeps working (`createRuntime` stays lenient).
 */

import { describe, expect, it } from 'vitest';
import { BedrockModelProviderContract } from '@/lib/providers/contracts/modelContracts';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import { PROVIDER_SETTINGS_INVALID, ProviderSettingsError } from '@/lib/providers/errors';

const KEYS = { accessKeyId: 'AKIATEST', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

type Validate = (input: { credentials: Record<string, unknown>; settings: Record<string, unknown>; isOnPrem: boolean }) => void | Promise<void>;
const validate = BedrockModelProviderContract.validateSettings as unknown as Validate;

const check = (settings: Record<string, unknown>) => () => validate({ credentials: KEYS, settings, isOnPrem: false });

function problem(run: () => unknown): ProviderSettingsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderSettingsError);
    return error as ProviderSettingsError;
  }
  throw new Error('expected a ProviderSettingsError, nothing was thrown');
}

const regionField = BedrockModelProviderContract.form.sections
  .flatMap((section) => section.fields)
  .find((field) => field.name === 'region');

describe('the Bedrock region field', () => {
  it('is a required text input in the settings, with an example in it', () => {
    expect(regionField).toMatchObject({ type: 'text', required: true, scope: 'settings', placeholder: 'us-east-1' });
  });

  it('is no longer a list of four regions, which are named as examples instead', () => {
    expect(regionField).not.toHaveProperty('options');
    for (const region of ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-southeast-1']) {
      expect(regionField?.description).toContain(region);
    }
  });
});

describe('the Bedrock region check', () => {
  it.each([
    // The four the dropdown used to hold stay valid.
    'us-east-1', 'us-west-2', 'eu-central-1', 'ap-southeast-1',
    // Everything else Bedrock is offered in.
    'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'eu-south-1',
    'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1', 'ap-southeast-2', 'ap-southeast-4',
    'ca-central-1', 'sa-east-1', 'me-south-1', 'me-central-1', 'af-south-1', 'il-central-1',
    'us-gov-west-1', 'us-gov-east-1',
  ])('accepts %s', (region) => {
    expect(check({ region })).not.toThrow();
  });

  it('accepts a region with spaces around it, which the runtime trims', () => {
    expect(check({ region: '  eu-west-1 ' })).not.toThrow();
  });

  it.each([
    ['upper case', 'US-EAST-1'],
    ['a word', 'bedrock'],
    ['a region without its number', 'us-east'],
    ['an availability zone', 'us-east-1a'],
    ['an endpoint', 'https://bedrock-runtime.us-east-1.amazonaws.com'],
    ['a host name', 'bedrock-runtime.us-east-1.amazonaws.com'],
    ['a region followed by a host', 'us-east-1.evil.example'],
    ['underscores', 'us_east_1'],
    ['no dashes', 'useast1'],
    ['a trailing slash', 'us-east-1/'],
    ['an injected line', 'us-east-1\n.evil.example'],
    ['a country-code style name', 'germany'],
  ])('rejects %s (%s)', (_what, region) => {
    const error = problem(check({ region }));
    expect(error.field).toBe('region');
    expect(error.code).toBe(PROVIDER_SETTINGS_INVALID);
    expect(error.message).toMatch(/AWS region id/);
    // It says what to type, and never echoes the credentials.
    expect(error.message).toContain('us-east-1');
    expect(error.message).not.toContain(KEYS.secretAccessKey);
  });

  it.each([
    ['missing', {}],
    ['empty', { region: '' }],
    ['blank', { region: '   ' }],
    ['not a string', { region: 12 }],
    ['null', { region: null }],
  ])('asks for the region when it is %s', (_what, settings) => {
    const error = problem(check(settings as Record<string, unknown>));
    expect(error.field).toBe('region');
    expect(error.message).toMatch(/required/i);
  });
});

describe('a Bedrock provider that is already stored', () => {
  const runtimeFor = (settings: Record<string, unknown>) =>
    BedrockModelProviderContract.createRuntime({
      tenantId: 't',
      projectId: 'p',
      providerKey: 'prov',
      credentials: KEYS,
      settings,
      metadata: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as never) as unknown as ModelProviderRuntime;

  const providerOf = (settings: Record<string, unknown>) =>
    runtimeFor(settings).createNativeProviderSpec!({ modelId: 'anthropic.claude-3', category: 'llm' }).provider;

  it('keeps working: the runtime does not apply the save-time check', () => {
    // Whatever an earlier version of the form saved (and whatever a hand-edited row holds) is read as it is.
    expect(() => runtimeFor({ region: 'Legacy_Region' })).not.toThrow();
    expect(providerOf({ region: 'Legacy_Region' })).toMatchObject({ provider: 'bedrock', region: 'Legacy_Region' });
  });

  it('uses the region it was given, trimmed', () => {
    expect(providerOf({ region: ' ap-northeast-1 ' })).toMatchObject({ provider: 'bedrock', region: 'ap-northeast-1' });
    expect(providerOf({ region: 'us-west-2' })).toMatchObject({ region: 'us-west-2' });
  });

  it('still refuses to build a runtime without any region', () => {
    expect(() => runtimeFor({})).toThrow('AWS region is required.');
  });
});
