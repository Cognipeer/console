import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const digest = `sha256:${'a'.repeat(64)}`;
const sha = 'b'.repeat(40);
const labels = {
  'org.opencontainers.image.revision': sha,
  'org.opencontainers.image.version': 'v1.2.60-community',
  'org.opencontainers.image.source': 'https://github.com/Cognipeer/console',
};
const receipt = { contractVersion: 2, status: 'recorded', releaseId: 'release-1', executionId: 'execution-1', targetKey: 'community', environmentKey: 'artifacts' };
const mock = `
docker() {
  printf '%s\\n' "$*" >> "$CALLS"
  if [[ "$REGISTRY_ERROR" != '' ]]; then echo "$REGISTRY_ERROR" >&2; return 1; fi
  if [[ "$*" == *'.Manifest'* ]]; then printf '%s' "$MANIFEST"; else printf '%s' "$IMAGE_CONFIG"; fi
}
curl() {
  [[ "$HTTP_FAILURE" == 0 ]] || return 22
  local output='' payload=''
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --output) shift; output="$1" ;;
      --data-binary) shift; payload="\${1#@}" ;;
    esac
    shift
  done
  cp "$payload" "$PAYLOAD"
  printf '%s' "$RECEIPT" > "$output"
}
`;

function execute(script, overrides = {}) {
  const path = mkdtempSync(join(tmpdir(), 'community-artifact-test-'));
  const output = join(path, 'output');
  const payload = join(path, 'payload');
  const calls = join(path, 'calls');
  try {
    const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail'], {
      input: `${mock}\nsource "$SCRIPT_FILE"\n`, encoding: 'utf8', timeout: 10_000,
      env: {
        ...process.env, SCRIPT_FILE: join(directory, script), GITHUB_OUTPUT: output, PAYLOAD: payload, CALLS: calls,
        GITHUB_REPOSITORY: 'Cognipeer/console', GITHUB_SERVER_URL: 'https://github.com',
        IMAGE_REF: 'ghcr.io/cognipeer/console:v1.2.60-community', SOURCE_COMMIT_SHA: sha,
        REGISTRY_ERROR: '', MANIFEST: JSON.stringify({ digest }), IMAGE_CONFIG: JSON.stringify({ config: { Labels: labels } }),
        WEBHOOK_URL: 'https://crm.invalid', WEBHOOK_SECRET: 'test-only', COMMIT_SHA: sha,
        RELEASE_VERSION: 'v1.2.60-community', RELEASE_STATUS: 'succeeded', IMAGE_DIGEST: digest,
        RUN_URL: 'https://github.com/Cognipeer/console/actions/runs/42', RECEIPT: JSON.stringify(receipt), HTTP_FAILURE: '0',
        ...overrides,
      },
    });
    assert.ifError(result.error);
    return {
      status: result.status, output: result.stdout + result.stderr,
      outputs: existsSync(output) ? readFileSync(output, 'utf8') : '',
      calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
      payload: existsSync(payload) ? JSON.parse(readFileSync(payload, 'utf8')) : null,
    };
  } finally { rmSync(path, { recursive: true, force: true }); }
}

test('reuses only metadata-verified version images, without a SHA tag', () => {
  const result = execute('resolve-image.sh');
  assert.equal(result.status, 0, result.output);
  assert.match(result.outputs, /reuse=true/);
  assert.ok(result.calls.includes(`ghcr.io/cognipeer/console@${digest}`));
  assert.doesNotMatch(result.calls, /:sha-/);
});

test('only explicit registry absence allows a build', () => {
  const absent = execute('resolve-image.sh', { REGISTRY_ERROR: 'ERROR: manifest unknown' });
  assert.equal(absent.status, 0, absent.output);
  assert.equal(absent.outputs, 'reuse=false\n');
  for (const overrides of [{ REGISTRY_ERROR: 'ERROR: 403 Forbidden' }, { REGISTRY_ERROR: 'network timeout' }, { MANIFEST: '{}' }]) {
    const result = execute('resolve-image.sh', overrides);
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, '');
  }
});

test('rejects missing or mismatched identity on every platform', () => {
  const correct = { config: { Labels: labels } };
  const wrong = { config: { Labels: { ...labels, 'org.opencontainers.image.revision': 'c'.repeat(40) } } };
  for (const config of [{}, wrong, { 'linux/amd64': correct, 'linux/arm64': wrong }]) {
    assert.notEqual(execute('resolve-image.sh', { IMAGE_CONFIG: JSON.stringify(config) }).status, 0);
  }
  assert.equal(execute('resolve-image.sh', { IMAGE_CONFIG: JSON.stringify({ 'linux/amd64': correct, 'linux/arm64': correct }) }).status, 0);
});

test('callbacks require an exact linked v2 receipt', () => {
  const result = execute('notify-release-crm.sh');
  assert.equal(result.status, 0, result.output);
  assert.equal(result.payload.requireExecution, true);
  assert.equal(result.payload.immutableRef, `ghcr.io/cognipeer/console@${digest}`);
  for (const response of [
    { status: 'ignored' }, { ...receipt, releaseId: null }, { ...receipt, executionId: null },
    { ...receipt, contractVersion: 1 }, { ...receipt, targetKey: 'saas' }, { ...receipt, environmentKey: 'production' },
  ]) assert.notEqual(execute('notify-release-crm.sh', { RECEIPT: JSON.stringify(response) }).status, 0);
});

test('never reports HTTP failure or missing success digest as success', () => {
  for (const overrides of [{ HTTP_FAILURE: '1' }, { RECEIPT: 'not-json' }, { IMAGE_DIGEST: '' }]) {
    assert.notEqual(execute('notify-release-crm.sh', overrides).status, 0);
  }
  for (const status of ['pending', 'failed']) {
    assert.equal(execute('notify-release-crm.sh', { IMAGE_DIGEST: '', RELEASE_STATUS: status }).status, 0);
  }
});