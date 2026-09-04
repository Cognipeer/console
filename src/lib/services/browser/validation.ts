import { z } from 'zod';
import type { BrowserAction } from './types';

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Key must be lowercase kebab-case');

const optionalTrimmedString = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional();

const metadataSchema = z.record(z.string(), z.unknown()).optional();

const accessRulesSchema = z.object({
  allowList: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
  blockList: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
}).strict();

const sessionConfigSchema = z.object({
  headless: z.boolean().optional(),
  viewport: z.object({
    width: z.number().int().min(320).max(8192),
    height: z.number().int().min(240).max(8192),
  }).strict().optional(),
  userAgent: optionalTrimmedString(512),
  locale: optionalTrimmedString(64),
  timezoneId: optionalTrimmedString(64),
  idleTimeoutMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1_000).optional(),
  maxLifetimeMs: z.number().int().min(1_000).max(7 * 24 * 60 * 60 * 1_000).optional(),
  actionTimeoutMs: z.number().int().min(1).max(120_000).optional(),
  navigationTimeoutMs: z.number().int().min(1).max(300_000).optional(),
  access: accessRulesSchema.optional(),
  proxy: z.object({
    server: z.string().trim().min(1).max(255),
    username: optionalTrimmedString(255),
    password: z.string().max(512).optional(),
    bypass: optionalTrimmedString(1_000),
  }).strict().optional(),
  extraHTTPHeaders: z.record(z.string().max(128), z.string().max(2_000)).optional(),
  httpCredentials: z.object({
    username: z.string().trim().min(1).max(255),
    password: z.string().max(512),
  }).strict().optional(),
  acceptDownloads: z.boolean().optional(),
  ignoreHTTPSErrors: z.boolean().optional(),
  dialogPolicy: z.enum(['accept', 'dismiss']).optional(),
  // Accepted on a session (a caller replaying an export) but never on a
  // profile's stored defaults — cookies belong on the browser record's
  // encrypted slot, not in a request body that lands in an event log.
  storageState: z.record(z.string(), z.unknown()).optional(),
}).strict();

/**
 * The element-addressing fields every targeted action shares.
 *
 * `ref` is here for a LIVE caller that just took a snapshot. Everything else
 * is durable and is what a recorded flow step keeps; see `BrowserTarget`.
 */
const targetShape = {
  ref: optionalTrimmedString(512),
  role: optionalTrimmedString(64),
  name: optionalTrimmedString(1_000),
  nameContains: z.boolean().optional(),
  testId: optionalTrimmedString(255),
  label: optionalTrimmedString(1_000),
  placeholder: optionalTrimmedString(1_000),
  text: optionalTrimmedString(1_000),
  selector: optionalTrimmedString(2_000),
  nth: z.number().int().min(0).max(1_000).optional(),
  frame: z.union([
    z.string().trim().min(1).max(2_000),
    z.array(z.string().trim().min(1).max(2_000)).max(5),
  ]).optional(),
};

const targetSchema = z.object(targetShape).strict();

function hasTarget(value: {
  ref?: string;
  role?: string;
  testId?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  selector?: string;
}) {
  return Boolean(
    value.ref?.trim() || value.role?.trim() || value.testId?.trim()
    || value.label?.trim() || value.placeholder?.trim()
    || value.text?.trim() || value.selector?.trim(),
  );
}

const TARGET_REQUIRED =
  'Give the element as `ref` (from a snapshot), `role` + `name`, `testId`, `label`, `placeholder`, `text` or `selector`.';

const actionTimeoutSchema = z.number().int().min(1).max(120_000).optional();

export const createBrowserInputSchema = z.object({
  key: slugSchema.optional(),
  name: z.string().trim().min(2).max(120),
  description: optionalTrimmedString(1_000),
  status: z.enum(['active', 'disabled']).optional(),
  artifactBucketKey: optionalTrimmedString(120),
  defaultSessionConfig: sessionConfigSchema.optional(),
  defaultModelKey: optionalTrimmedString(120),
  defaultRunOptions: z.object({
    maxSteps: z.number().int().min(1).max(500).optional(),
    temperature: z.number().min(0).max(2).optional(),
    runtimeProfile: optionalTrimmedString(64),
  }).strict().optional(),
  metadata: metadataSchema,
}).strict();

export const updateBrowserInputSchema = createBrowserInputSchema
  .omit({ name: true })
  .extend({
    name: z.string().trim().min(2).max(120).optional(),
  })
  .partial()
  .strict();

export const createBrowserSessionInputSchema = z.object({
  browserId: z.string().trim().min(1).max(128),
  name: optionalTrimmedString(120),
  agentKey: optionalTrimmedString(120),
  agentId: optionalTrimmedString(128),
  artifactBucketKey: optionalTrimmedString(120),
  config: sessionConfigSchema.optional(),
  metadata: metadataSchema,
}).strict();

const browserActionBaseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('goto'),
    url: z.string().url('Must be a valid URL including scheme'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('click'),
    ...targetShape,
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('hover'),
    ...targetShape,
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('type'),
    ...targetShape,
    text: z.string().max(10_000),
    delay: z.number().int().min(0).max(5_000).optional(),
    clear: z.boolean().optional(),
    submit: z.boolean().optional(),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('press'),
    ...targetShape,
    key: z.string().trim().min(1).max(64),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('select'),
    ...targetShape,
    values: z.array(z.string().max(1_000)).max(50).optional(),
    labels: z.array(z.string().max(1_000)).max(50).optional(),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('check'),
    ...targetShape,
    checked: z.boolean().optional(),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('upload'),
    ...targetShape,
    fileIds: z.array(z.string().trim().min(1).max(128)).min(1).max(10),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('drag'),
    from: targetSchema,
    to: targetSchema,
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.enum(['back', 'forward', 'reload']),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('wait'),
    selector: optionalTrimmedString(2_000),
    text: optionalTrimmedString(1_000),
    ms: z.number().int().min(1).max(60_000).optional(),
    state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
    loadState: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('scroll'),
    ...targetShape,
    x: z.number().int().min(-100_000).max(100_000).optional(),
    y: z.number().int().min(-100_000).max(100_000).optional(),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('tab'),
    op: z.enum(['new', 'switch', 'close', 'list']),
    index: z.number().int().min(0).max(100).optional(),
    url: z.string().url('Must be a valid URL including scheme').optional(),
  }).strict(),
]);

export const browserActionSchema: z.ZodType<BrowserAction> = browserActionBaseSchema.superRefine((value, ctx) => {
  switch (value.type) {
    case 'click':
    case 'hover':
    case 'type':
    case 'press':
    case 'check':
    case 'upload':
      if (!hasTarget(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: TARGET_REQUIRED });
      }
      return;
    case 'select':
      if (!hasTarget(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: TARGET_REQUIRED });
      }
      if (!value.values?.length && !value.labels?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Provide `values` or `labels` to select',
        });
      }
      return;
    case 'drag':
      if (!hasTarget(value.from) || !hasTarget(value.to)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: TARGET_REQUIRED });
      }
      return;
    case 'wait':
      if (
        value.ms === undefined
        && !value.selector?.trim()
        && !value.text?.trim()
        && !value.loadState
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A wait needs one of ms, selector, text or loadState',
        });
      }
      return;
    case 'scroll':
      if (!hasTarget(value) && value.x === undefined && value.y === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Provide an element target or x/y scroll coordinates',
        });
      }
      return;
    case 'tab':
      if ((value.op === 'switch' || value.op === 'close') && value.index === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '`index` is required to switch or close a tab',
        });
      }
      return;
    default:
      return;
  }
});

export const browserExtractInputSchema = z.object({
  ...targetShape,
  mode: z.enum(['text', 'html', 'attr', 'value']).optional(),
  attribute: optionalTrimmedString(128),
  multiple: z.boolean().optional(),
}).strict()
  .refine(hasTarget, TARGET_REQUIRED)
  .refine((value) => value.mode !== 'attr' || Boolean(value.attribute?.trim()), 'attribute is required when mode="attr"');

export const browserScreenshotInputSchema = z.object({
  ...targetShape,
  fullPage: z.boolean().optional(),
  type: z.enum(['png', 'jpeg']).optional(),
  quality: z.number().int().min(1).max(100).optional(),
}).strict();

export const browserPdfInputSchema = z.object({
  format: z.enum(['A4', 'Letter', 'Legal', 'A3', 'A5']).optional(),
  landscape: z.boolean().optional(),
  printBackground: z.boolean().optional(),
}).strict();

// ── Flows ───────────────────────────────────────────────────────────────

const flowInputSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'Input name must be a valid identifier',
  ),
  label: optionalTrimmedString(120),
  type: z.enum(['string', 'number', 'boolean', 'secret']),
  required: z.boolean().optional(),
  default: z.union([z.string().max(2_000), z.number(), z.boolean()]).optional(),
  description: optionalTrimmedString(500),
}).strict()
  // A default on a secret would be a credential sitting in the flow document,
  // readable by anyone who can view the flow. There is no safe version of it.
  .refine(
    (value) => value.type !== 'secret' || value.default === undefined,
    'A secret input cannot carry a default value',
  );

const flowStepPolicySchema = z.object({
  retries: z.number().int().min(0).max(10).optional(),
  retryDelayMs: z.number().int().min(0).max(60_000).optional(),
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
  optional: z.boolean().optional(),
}).strict();

/**
 * A step's action, validated against the same union the live API accepts —
 * plus `extract`, and with one extra rule: a stored `ref` is rejected.
 *
 * `extract` is not a `BrowserAction` (it reads the page rather than changing
 * it, and has its own endpoint) but it IS a step: reading a value out is how
 * a flow produces an output at all, and `runBrowserFlow` executes it. Leaving
 * it out of this schema made every recorded flow that reads something fail to
 * save, while the same step worked when built in TypeScript.
 *
 * A ref is a marker from ONE snapshot. Persisted into a flow it looks like a
 * working target, resolves to nothing on the next run, and spends the step's
 * whole timeout discovering that. Catching it here means a bad recorder or a
 * hand-written step fails at save time with a message, instead of at 3am with
 * a timeout.
 */
const flowStepActionSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const payload = value as { type?: unknown; ref?: unknown };

  if (payload.type === 'extract') {
    const { type: _type, ...rest } = value as Record<string, unknown>;
    const parsed = browserExtractInputSchema.safeParse(rest);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: formatBrowserValidationError(parsed.error),
      });
    }
  } else {
    const parsed = browserActionSchema.safeParse(value);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: formatBrowserValidationError(parsed.error),
      });
      return;
    }
  }

  if (typeof payload.ref === 'string') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'A flow step cannot store `ref` — it is valid only for the snapshot that produced it. Use role + name, testId, label, placeholder, text or selector.',
    });
  }
});

const flowStepSchema = z.object({
  id: optionalTrimmedString(64),
  label: optionalTrimmedString(200),
  action: flowStepActionSchema,
  captureAs: z.string().trim().min(1).max(64).regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'captureAs must be a valid identifier',
  ).optional(),
  policy: flowStepPolicySchema.optional(),
  when: optionalTrimmedString(500),
}).strict();

export const createBrowserFlowInputSchema = z.object({
  key: slugSchema.optional(),
  name: z.string().trim().min(2).max(120),
  description: optionalTrimmedString(1_000),
  status: z.enum(['draft', 'active', 'disabled']).optional(),
  browserId: z.string().trim().min(1).max(128),
  inputs: z.array(flowInputSchema).max(50).optional(),
  steps: z.array(flowStepSchema).max(500).default([]),
  sessionConfig: sessionConfigSchema.omit({ storageState: true }).optional(),
  recordedFromSessionId: optionalTrimmedString(128),
  metadata: metadataSchema,
}).strict();

export const updateBrowserFlowInputSchema = createBrowserFlowInputSchema
  .omit({ name: true, steps: true })
  .extend({
    name: z.string().trim().min(2).max(120).optional(),
    steps: z.array(flowStepSchema).max(500).optional(),
  })
  .partial()
  .strict();

export const recordBrowserFlowInputSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(2).max(120),
  key: slugSchema.optional(),
  description: optionalTrimmedString(1_000),
  /** Persist as `draft` (the default) so a recording is reviewed before it runs. */
  status: z.enum(['draft', 'active']).optional(),
  /** Event types to leave out. Defaults to the read-only ones. */
  excludeTypes: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
}).strict();

export const runBrowserFlowInputSchema = z.object({
  inputs: z.record(z.string().max(64), z.unknown()).optional(),
  /** Keep the session open when the run ends, for debugging a failure. */
  keepSessionOpen: z.boolean().optional(),
  /** Stop after this many steps. For dry-running a long flow. */
  maxSteps: z.number().int().min(1).max(500).optional(),
}).strict();

export type CreateBrowserFlowPayload = z.infer<typeof createBrowserFlowInputSchema>;
export type UpdateBrowserFlowPayload = z.infer<typeof updateBrowserFlowInputSchema>;
export type RecordBrowserFlowPayload = z.infer<typeof recordBrowserFlowInputSchema>;
export type RunBrowserFlowPayload = z.infer<typeof runBrowserFlowInputSchema>;

export type CreateBrowserPayload = z.infer<typeof createBrowserInputSchema>;
export type UpdateBrowserPayload = z.infer<typeof updateBrowserInputSchema>;
export type CreateBrowserSessionPayload = z.infer<typeof createBrowserSessionInputSchema>;
export type BrowserActionPayload = z.infer<typeof browserActionSchema>;
export type BrowserExtractPayload = z.infer<typeof browserExtractInputSchema>;
export type BrowserScreenshotPayload = z.infer<typeof browserScreenshotInputSchema>;
export type BrowserPdfPayload = z.infer<typeof browserPdfInputSchema>;

export function formatBrowserValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request payload';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}
