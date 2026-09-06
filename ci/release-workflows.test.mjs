import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const digest = `sha256:${'a'.repeat(64)}`;
const mock = `
sleep() { :; }
gh() {
  [[ "\${GH_FAILURE:-0}" != 1 && "$*" == *'contents/COMPAT.json?ref=main'* ]] || return 1
  printf '{"communityRef":"%s"}' "$PIN" | base64
}
docker() {
  local image="\${@: -1}" digest
  if [[ "\${REGISTRY_FAILURE:-0}" == 1 ]]; then echo 'ERROR: 403 Forbidden' >&2; return 1; fi
  if [[ "\${REGISTRY_MISSING:-0}" == 1 ]]; then echo "ERROR: $image: not found" >&2; return 1; fi
  digest="$MOCK_DIGEST"
  if [[ "$image" == *':sha-'* ]]; then digest="$SHA_DIGEST"; fi
  printf '{"digest":"%s"}' "$digest"
}
curl() {
  local destination=''
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == --output ]]; then shift; destination="$1"; fi
    shift
  done
  printf '%s' "$RECEIPT" > "$destination"
}
`;

function execute(script, overrides = {}) {
  const path = mkdtempSync(join(tmpdir(), 'community-release-test-'));
  try {
    const outputs = join(path, 'outputs');
    const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail'], {
      input: `${mock}\nsource "$SCRIPT_FILE"\n`, encoding: 'utf8', timeout: 30_000,
      env: {
        ...process.env, SCRIPT_FILE: join(directory, script), GITHUB_OUTPUT: outputs,
        COMMUNITY_TAG: 'v1.2.54-community', PIN: 'v1.2.54-community', CONSOLE_EE_REPOSITORY: 'Cognipeer/console-ee',
        IMAGE_REF: 'ghcr.io/cognipeer/console:v1.2.54-community', SOURCE_SHA_REF: `ghcr.io/cognipeer/console:sha-${'b'.repeat(40)}`,
        MOCK_DIGEST: digest, SHA_DIGEST: digest, WEBHOOK_URL: 'https://crm.invalid', WEBHOOK_SECRET: 'test-only', COMMIT_SHA: 'b'.repeat(40),
        RELEASE_VERSION: 'v1.2.54-community', RELEASE_STATUS: 'succeeded', IMAGE_DIGEST: digest, GITHUB_REPOSITORY: 'Cognipeer/console',
        RUN_URL: 'https://github.com/Cognipeer/console/actions/runs/42',
        RECEIPT: JSON.stringify({ contractVersion: 2, status: 'recorded', releaseId: 'release-1', executionId: 'execution-1', targetKey: 'community', environmentKey: 'artifacts' }),
        ...overrides,
      },
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr, outputs: existsSync(outputs) ? readFileSync(outputs, 'utf8') : '' };
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

test('an already correct pin needs no new PR', () => {
  const result = execute('wait-community-compat.sh');
  assert.equal(result.status, 0, result.output);
});

test('wrong pins and API failures never complete the wait', () => {
  for (const overrides of [{ PIN: 'v1.2.53-community' }, { GH_FAILURE: '1' }]) {
    assert.notEqual(execute('wait-community-compat.sh', overrides).status, 0);
  }
});

test('reuses SHA-owned images and builds only when explicitly absent', () => {
  const reuse = execute('resolve-image.sh');
  assert.equal(reuse.status, 0, reuse.output);
  assert.match(reuse.outputs, /reuse=true/);
  assert.ok(reuse.outputs.includes(digest));
  const absent = execute('resolve-image.sh', { REGISTRY_MISSING: '1' });
  assert.equal(absent.status, 0, absent.output);
  assert.match(absent.outputs, /reuse=false/);
});

test('registry errors and incorrect ownership cannot allow a rebuild', () => {
  for (const overrides of [{ REGISTRY_FAILURE: '1' }, { SHA_DIGEST: `sha256:${'c'.repeat(64)}` }]) {
    const result = execute('resolve-image.sh', overrides);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.outputs, /reuse=false/);
  }
});

test('callbacks require a current linked receipt', () => {
  assert.equal(execute('notify-release-crm.sh').status, 0);
  for (const receipt of ['{"status":"ignored"}', '{"status":"recorded","releaseId":null}', 'not json']) {
    assert.notEqual(execute('notify-release-crm.sh', { RECEIPT: receipt }).status, 0);
  }
});

test('workflow gates publishing and every embedded shell block parses', () => {
  const parsed = spawnSync('yq', ['-o=json', '.', join(directory, '../.github/workflows/build-community.yml')], { encoding: 'utf8' });
  assert.ifError(parsed.error);
  assert.equal(parsed.status, 0, parsed.stderr);
  const workflow = JSON.parse(parsed.stdout);
  const steps = workflow.jobs.build.steps;
  const names = steps.map((step) => step.name);
  assert.ok(names.indexOf('Verify managed release with CRM') < names.indexOf('Build & Push to GHCR'));
  assert.equal(steps.find((step) => step.id === 'image').if, "steps.existing.outputs.reuse != 'true'");
  assert.deepEqual(workflow.jobs['notify-crm'].needs, ['build', 'sync-console-ee']);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.run) continue;
      const result = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
  }
});