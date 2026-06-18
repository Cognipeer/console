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
  idleTimeoutMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1_000).optional(),
  maxLifetimeMs: z.number().int().min(1_000).max(7 * 24 * 60 * 60 * 1_000).optional(),
  actionTimeoutMs: z.number().int().min(1).max(120_000).optional(),
  navigationTimeoutMs: z.number().int().min(1).max(300_000).optional(),
  access: accessRulesSchema.optional(),
}).strict();

function selectorOrRefRefinement<T extends { selector?: string; ref?: string }>(value: T) {
  return Boolean(value.selector?.trim() || value.ref?.trim());
}

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
    selector: optionalTrimmedString(2_000),
    ref: optionalTrimmedString(512),
    button: z.enum(['left', 'right', 'middle']).optional(),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('hover'),
    selector: optionalTrimmedString(2_000),
    ref: optionalTrimmedString(512),
    timeout: actionTimeoutSchema,
  }).strict(),
  z.object({
    type: z.literal('type'),
    selector: optionalTrimmedString(2_000),
    ref: optionalTrimmedString(512),
    text: z.string().max(10_000),
    delay: z.number().int().min(0).max(5_000).optional(),
    clear: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal('press'),
    selector: optionalTrimmedString(2_000),
    ref: optionalTrimmedString(512),
    key: z.string().trim().min(1).max(64),
  }).strict(),
  z.object({
    type: z.literal('wait'),
    selector: optionalTrimmedString(2_000),
    ms: z.number().int().min(1).max(60_000).optional(),
    state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
  }).strict(),
  z.object({
    type: z.literal('scroll'),
    selector: optionalTrimmedString(2_000),
    ref: optionalTrimmedString(512),
    x: z.number().int().min(-100_000).max(100_000).optional(),
    y: z.number().int().min(-100_000).max(100_000).optional(),
  }).strict(),
]);

export const browserActionSchema: z.ZodType<BrowserAction> = browserActionBaseSchema.superRefine((value, ctx) => {
  switch (value.type) {
    case 'click':
    case 'hover':
    case 'type':
    case 'press':
      if (!selectorOrRefRefinement(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Either selector or ref is required',
        });
      }
      return;
    case 'wait':
      if (value.ms === undefined && !value.selector?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Either ms or selector is required',
        });
      }
      return;
    case 'scroll':
      if (!selectorOrRefRefinement(value) && value.x === undefined && value.y === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Provide selector/ref or x/y scroll coordinates',
        });
      }
      return;
    default:
      return;
  }
});

export const browserExtractInputSchema = z.object({
  selector: optionalTrimmedString(2_000),
  ref: optionalTrimmedString(512),
  mode: z.enum(['text', 'html', 'attr']).optional(),
  attribute: optionalTrimmedString(128),
  multiple: z.boolean().optional(),
}).strict()
  .refine(selectorOrRefRefinement, 'Either selector or ref is required')
  .refine((value) => value.mode !== 'attr' || Boolean(value.attribute?.trim()), 'attribute is required when mode="attr"');

export const browserScreenshotInputSchema = z.object({
  fullPage: z.boolean().optional(),
  selector: optionalTrimmedString(2_000),
  ref: optionalTrimmedString(512),
  type: z.enum(['png', 'jpeg']).optional(),
  quality: z.number().int().min(1).max(100).optional(),
}).strict();

export const browserPdfInputSchema = z.object({
  format: z.enum(['A4', 'Letter', 'Legal', 'A3', 'A5']).optional(),
  landscape: z.boolean().optional(),
  printBackground: z.boolean().optional(),
}).strict();

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
