import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const sha = 'b'.repeat(40);
const compat = { communityRepo: 'Cognipeer/console', communityRef: 'v1.2.60-community', communitySha: sha };

function waitForPin(pin = compat, overrides = {}) {
  const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail'], {
    input: `
      gh() { echo 'gh must not be required' >&2; return 127; }
      sleep() { printf 'compat-poll-wait\\n'; }
      curl() {
        [[ "$HTTP_FAILURE" == 0 ]] || return 22
        if [[ "$attempt" -lt "$PIN_READY_ATTEMPT" ]]; then
          printf '%s' "$INITIAL_PIN"
        else
          printf '%s' "$PIN"
        fi
      }
      source "$SCRIPT_FILE"
    `,
    encoding: 'utf8', timeout: 30_000,
    env: {
      ...process.env, SCRIPT_FILE: join(directory, 'wait-community-compat.sh'),
      GH_TOKEN: 'test-token', GITHUB_REPOSITORY: 'Cognipeer/console',
      CONSOLE_EE_REPOSITORY: 'Cognipeer/console-ee', COMMUNITY_TAG: compat.communityRef,
      COMMUNITY_SHA: sha, PIN: JSON.stringify(pin), HTTP_FAILURE: '0',
      INITIAL_PIN: JSON.stringify(pin), PIN_READY_ATTEMPT: '1', ...overrides,
    },
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('accepts an exact already-merged pin without gh or a new PR', () => {
  const result = waitForPin();
  assert.equal(result.status, 0, result.output);
});

test('waits for the exact pin to appear after compatibility sync', () => {
  for (const initialPin of [
    { ...compat, communityRef: 'v1.2.59-community' },
    { ...compat, communitySha: 'c'.repeat(40) },
  ]) {
    const result = waitForPin(compat, {
      INITIAL_PIN: JSON.stringify(initialPin), PIN_READY_ATTEMPT: '3',
    });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output, 'compat-poll-wait\ncompat-poll-wait\n');
  }
});

test('does not accept a moved tag, missing SHA, wrong repo or older pin', () => {
  for (const pin of [
    { ...compat, communitySha: 'c'.repeat(40) },
    { ...compat, communitySha: undefined },
    { ...compat, communityRepo: 'other/console' },
    { ...compat, communityRef: 'v1.2.59-community' },
  ]) {
    const result = waitForPin(pin);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /did not pin the exact Community/);
  }
});

test('rejects transport errors, malformed responses and invalid source identity', () => {
  for (const [pin, overrides] of [
    [compat, { HTTP_FAILURE: '1' }],
    [compat, { PIN: 'not-json' }],
    [null, {}],
    [compat, { COMMUNITY_SHA: '' }],
  ]) {
    assert.notEqual(waitForPin(pin, overrides).status, 0);
  }
});

test('workflow preserves self-hosted runners and gates publishing on identity and receipts', () => {
  const parsed = spawnSync(process.env.YQ_BINARY || 'yq', ['-o=json', '.', join(directory, '../.github/workflows/build-community.yml')], { encoding: 'utf8' });
  assert.ifError(parsed.error);
  assert.equal(parsed.status, 0, parsed.stderr);
  const workflow = JSON.parse(parsed.stdout);
  const steps = workflow.jobs.build.steps;
  const names = steps.map((step) => step.name);
  assert.ok(names.indexOf('Verify managed release with CRM') < names.indexOf('Build & Push to GHCR'));
  assert.ok(names.indexOf('Resolve existing image') < names.indexOf('Build & Push to GHCR'));
  assert.equal(steps.find((step) => step.id === 'image').if, "steps.existing.outputs.reuse != 'true'");
  assert.match(steps.find((step) => step.id === 'image').with.labels, /org.opencontainers.image.revision/);
  assert.deepEqual(workflow.jobs['notify-crm'].needs, ['build', 'sync-console-ee']);
  assert.ok(workflow.jobs['sync-console-ee'].steps.find((step) => step.run === 'bash ci/wait-community-compat.sh').env.COMMUNITY_SHA);
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'], 'self-hosted-runner-cgate-azure');
    for (const step of job.steps ?? []) {
      if (!step.run) continue;
      assert.doesNotMatch(step.run, /\bgh (api|pr)\b/);
      const syntax = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
});