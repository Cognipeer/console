/**
 * The `usageLimits` namespace: what a person sees when a plan limit refuses or delays an action
 * (chat, browser sessions, uploads). Turkish counterpart lives in usageLimits.tr.ts and must keep
 * the same keys and {placeholders}. Neutral wording: no prices, no plan names.
 */

export const usageLimitsEn = {
  codes: {
    tenant_rate_limited: {
      title: 'Request limit reached',
      message: 'Your workspace reached its request limit. Try again in {seconds} seconds.',
      messageNoWait: 'Your workspace reached its request limit. Try again shortly.',
    },
    tenant_concurrency_limited: {
      title: 'No free slot',
      message: 'Your workspace is already running as many {dimension} as its plan allows ({limit}). Try again in {seconds} seconds.',
      messageNoWait: 'Your workspace is already running as many {dimension} as its plan allows ({limit}). Try again shortly.',
    },
    monthly_allowance_exhausted: {
      title: 'Monthly allowance used',
      message: 'Your workspace has used its monthly allowance of {dimension} ({used} of {limit}). It resets on {date}.',
      messageNoDate: 'Your workspace has used its monthly allowance of {dimension} ({used} of {limit}). It resets next month.',
    },
    storage_quota_exceeded: {
      title: 'Storage is full',
      message: 'This would take your workspace over its storage allowance. Remove some files or vectors and try again.',
    },
    seat_limit_reached: {
      title: 'Seat limit reached',
      message: 'Your workspace has used all of its seats ({limit}). Free a seat before adding another person.',
    },
    insufficient_credits: {
      title: 'Not enough credits',
      message: 'Your workspace does not have enough credits for this request.',
    },
    credits_unavailable: {
      title: 'Credits unavailable',
      message: 'The credit balance cannot be read right now, so managed services are paused. Try again in {seconds} seconds.',
      messageNoWait: 'The credit balance cannot be read right now, so managed services are paused. Try again shortly.',
    },
    context_over_credit_cap: {
      title: 'Request too large',
      message: 'This request is larger than a managed model call may be. Shorten it and try again.',
    },
    plan_feature_unavailable: {
      title: 'Not available',
      message: 'This feature is not included in your workspace plan.',
    },
  },
  dimensions: {
    apiRpm: 'API requests',
    agent: 'agent sessions',
    flow: 'flows',
    job: 'jobs',
    crawler: 'crawler jobs',
    browser: 'browser sessions',
    realtime: 'realtime sessions',
    sandbox: 'sandboxes',
    searches: 'searches',
    flowRuns: 'flow runs',
    crawlerPages: 'crawler pages',
    sandboxHours: 'sandbox hours',
    sandboxSeconds: 'sandbox hours',
    unknown: 'items',
  },
  queued: 'Waiting for a free agent slot (up to {seconds}s).',
  adminLink: 'View plan and usage',
  nonAdminHint: 'Ask a workspace admin',
};
