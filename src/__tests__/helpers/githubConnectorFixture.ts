/**
 * What the `cognipeer.github` connector package (1.1.0) declares for the two
 * triggers the agent templates listen to, copied from its built manifest
 * (`connectors/github/dist/package/connector.json`): the trigger's parameters,
 * the event types it reports, the properties of the event data
 * (`eventSchema`) and the manifest's own `sample` event.
 *
 * The package does not forward GitHub's webhook body: its parse hook emits this
 * flat data (`repository` is the text "owner/name", `draft`, `number`,
 * `headBranch` ...), and the connectors module hands it to the trigger engine
 * unchanged as `payload`. Core cannot load the package, so tests that check a
 * template, a docs example or a fake host against the event read this copy.
 * When the package's events change, update it from the manifest.
 */

export const GITHUB_PACKAGE_ID = 'cognipeer.github';

export interface PackageTriggerFixture {
  /** Parameters the trigger takes (all of the GitHub ones are required). */
  params: Record<string, { kind: 'select'; required: boolean }>;
  /** The event types the trigger reports, in the manifest's order. */
  events: string[];
  /** Property names of the event data (`eventSchema.properties`). */
  properties: string[];
  /** The manifest's `sample` event. */
  sample: { type: string; data: Record<string, unknown> };
}

export const GITHUB_TRIGGERS: Record<'pull_request' | 'workflow_run', PackageTriggerFixture> = {
  pull_request: {
    params: { repository: { kind: 'select', required: true } },
    events: [
      'pull_request.opened',
      'pull_request.edited',
      'pull_request.closed',
      'pull_request.reopened',
      'pull_request.synchronize',
      'pull_request.ready_for_review',
      'pull_request.converted_to_draft',
      'pull_request.labeled',
      'pull_request.unlabeled',
      'pull_request.assigned',
      'pull_request.unassigned',
      'pull_request.review_requested',
      'pull_request.review_request_removed',
    ],
    properties: [
      'action', 'repository', 'number', 'title', 'body', 'state', 'draft', 'merged', 'url', 'author', 'sender',
      'baseBranch', 'headBranch', 'headSha', 'labels', 'assignees', 'label',
    ],
    sample: {
      type: 'pull_request.opened',
      data: {
        action: 'opened',
        repository: 'octocat/Hello-World',
        number: 1347,
        title: 'Amazing new feature',
        body: 'Please pull these awesome changes in!',
        state: 'open',
        draft: false,
        merged: false,
        url: 'https://github.com/octocat/Hello-World/pull/1347',
        author: 'octocat',
        sender: 'octocat',
        baseBranch: 'master',
        headBranch: 'new-topic',
        headSha: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
        labels: ['bug'],
        assignees: ['octocat'],
        label: null,
      },
    },
  },
  workflow_run: {
    params: { repository: { kind: 'select', required: true } },
    events: ['workflow_run.requested', 'workflow_run.in_progress', 'workflow_run.completed'],
    properties: [
      'action', 'repository', 'runId', 'runNumber', 'runAttempt', 'name', 'event', 'status', 'conclusion', 'branch', 'headSha', 'url', 'actor',
    ],
    sample: {
      type: 'workflow_run.completed',
      data: {
        action: 'completed',
        repository: 'octocat/Hello-World',
        runId: 30433642,
        runNumber: 562,
        runAttempt: 1,
        name: 'Build',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        branch: 'main',
        headSha: 'acb5820ced9479c074f688cc328bf03f341a511d',
        url: 'https://github.com/octocat/Hello-World/actions/runs/30433642',
        actor: 'octocat',
      },
    },
  },
};
