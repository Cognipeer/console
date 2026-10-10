/**
 * The `iamTokens` namespace (token expiry, IP allowlist, token access, the
 * tenant token policy settings): English and Turkish carry the same keys with
 * the same placeholders, and every key the components ask for exists.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';

const ROOT = path.resolve(__dirname, '../../..');

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[full] = value;
    else Object.assign(out, flatten(value, full));
  }
  return out;
}

const en = flatten((messages.en as unknown as { iamTokens: Tree }).iamTokens);
const tr = flatten((messages.tr as unknown as { iamTokens: Tree }).iamTokens);

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('iamTokens translations', () => {
  it('English and Turkish have exactly the same keys', () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
  });

  it('no value is empty', () => {
    for (const [key, value] of Object.entries(en)) expect(value.trim(), `en ${key}`).not.toBe('');
    for (const [key, value] of Object.entries(tr)) expect(value.trim(), `tr ${key}`).not.toBe('');
  });

  it('both languages use the same {placeholders} for every key', () => {
    for (const key of Object.keys(en)) {
      expect(placeholders(tr[key]), key).toEqual(placeholders(en[key]));
    }
  });
});

// Components whose `t` is bound to the iamTokens namespace.
const ALL_T_FILES = [
  'src/components/iam/tokens/ExpiryField.tsx',
  'src/components/iam/tokens/IpAllowlistField.tsx',
  'src/components/iam/tokens/TokenAccessSection.tsx',
  'src/components/iam/tokens/TokenDetailModal.tsx',
  'src/components/iam/tokens/TokenStatusBadges.tsx',
  'src/components/iam/tokens/tokenErrors.ts',
  'src/components/iam/settings/IamSettingsTab.tsx',
];
// Components that also use another namespace as `t`; there only `tIam(...)` is ours.
const TIAM_ONLY_FILES = [
  'src/components/settings/CreateTokenModal.tsx',
  'src/components/settings/TokenManagement.tsx',
  'src/app/dashboard/members/[userId]/page.tsx',
];

function staticKeys(file: string, translator: 't' | 'tIam'): string[] {
  const source = readFileSync(path.join(ROOT, file), 'utf8');
  const pattern = new RegExp(`\\b${translator}\\(\\s*'([^']+)'`, 'g');
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

function templateKeys(file: string, translator: 't' | 'tIam'): string[] {
  const source = readFileSync(path.join(ROOT, file), 'utf8');
  const pattern = new RegExp(`\\b${translator}\\(\\s*\`([^\`]+)\``, 'g');
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

// Keys the components build from a closed set of values.
const DYNAMIC_FAMILIES: Record<string, string[]> = {
  'levels.${row.level}': ['levels.read', 'levels.write', 'levels.admin'],
  'levels.${level}': ['levels.read', 'levels.write', 'levels.admin'],
  'status.${kind}': ['status.expired', 'status.exceedsPolicy', 'status.unused', 'status.ipRestricted'],
  'statusHint.${kind}': ['statusHint.expired', 'statusHint.exceedsPolicy', 'statusHint.unused', 'statusHint.ipRestricted'],
  'network.issue.${issue.reason}': ['network.issue.empty', 'network.issue.tooLong', 'network.issue.address', 'network.issue.prefix'],
  'expiry.problem.${problem}': ['expiry.problem.required', 'expiry.problem.tooLong', 'expiry.problem.invalidDate', 'expiry.problem.notFuture'],
  'access.sourceKind.${source.kind}': [
    'access.sourceKind.role', 'access.sourceKind.direct', 'access.sourceKind.group',
    'access.sourceKind.token-scope', 'access.sourceKind.project', 'access.sourceKind.policy',
  ],
  'access.effect.${policy.effect}': ['access.effect.permit', 'access.effect.forbid', 'access.effect.mixed'],
  'errors.${code}': [
    'errors.token_expiry_required', 'errors.token_expiry_too_long', 'errors.token_expiry_invalid',
    'errors.invalid_ip_ranges', 'errors.invalid_label', 'errors.invalid_body',
    'errors.policy_unavailable', 'errors.ip_ranges_exceed_minter',
  ],
};

describe('keys used by the token components', () => {
  it('every static key exists', () => {
    const missing: string[] = [];
    for (const file of ALL_T_FILES) {
      for (const key of staticKeys(file, 't')) if (!(key in en)) missing.push(`${file}: ${key}`);
    }
    for (const file of [...ALL_T_FILES, ...TIAM_ONLY_FILES]) {
      for (const key of staticKeys(file, 'tIam')) if (!(key in en)) missing.push(`${file}: ${key}`);
    }
    // The pluralised keys are chosen with a ternary, so they are not caught above.
    for (const key of ['expiry.dayOne', 'expiry.dayMany', 'network.countOne', 'network.countMany']) {
      if (!(key in en)) missing.push(key);
    }
    expect(missing).toEqual([]);
  });

  it('every computed key belongs to a known, fully translated family', () => {
    const unknown: string[] = [];
    for (const file of ALL_T_FILES) {
      for (const key of templateKeys(file, 't')) {
        if (!(key in DYNAMIC_FAMILIES)) unknown.push(`${file}: ${key}`);
      }
    }
    for (const file of [...ALL_T_FILES, ...TIAM_ONLY_FILES]) {
      for (const key of templateKeys(file, 'tIam')) {
        if (!(key in DYNAMIC_FAMILIES)) unknown.push(`${file}: ${key}`);
      }
    }
    expect(unknown).toEqual([]);
    for (const keys of Object.values(DYNAMIC_FAMILIES)) {
      for (const key of keys) expect(key in en, key).toBe(true);
    }
  });

  it('the error codes the API can answer with are all translated', () => {
    const codes = [
      'token_expiry_required', 'token_expiry_too_long', 'token_expiry_invalid', 'invalid_ip_ranges',
      'invalid_label', 'invalid_body', 'policy_unavailable', 'ip_ranges_exceed_minter',
    ];
    for (const code of codes) expect(`errors.${code}` in en, code).toBe(true);
  });
});
