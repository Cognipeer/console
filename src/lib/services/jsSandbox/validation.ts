import { z } from 'zod';
import { JS_SANDBOX_LIBRARY_DESCRIPTORS } from './libraries';

const allowedLibraries = JS_SANDBOX_LIBRARY_DESCRIPTORS.map((library) => library.key);

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

const limitsSchema = z.object({
  defaultTimeoutMs: z.number().int().min(100).max(120_000).optional(),
  maxTimeoutMs: z.number().int().min(100).max(120_000).optional(),
  memoryLimitMb: z.number().int().min(8).max(512).optional(),
  maxCodeSizeBytes: z.number().int().min(1_024).max(1024 * 1024).optional(),
  maxResultSizeBytes: z.number().int().min(1_024).max(5 * 1024 * 1024).optional(),
  maxLogEntries: z.number().int().min(0).max(1_000).optional(),
}).strict();

const networkSchema = z.object({
  enabled: z.boolean().optional(),
  allowList: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
}).strict();

const librariesSchema = z
  .array(z.enum(allowedLibraries as [string, ...string[]]))
  .max(allowedLibraries.length)
  .optional();

export const createJsSandboxRuntimeInputSchema = z.object({
  key: slugSchema.optional(),
  name: z.string().trim().min(2).max(120),
  description: optionalTrimmedString(1_000),
  status: z.enum(['active', 'disabled']).optional(),
  libraries: librariesSchema,
  limits: limitsSchema.optional(),
  network: networkSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const updateJsSandboxRuntimeInputSchema = createJsSandboxRuntimeInputSchema
  .omit({ name: true, key: true })
  .extend({
    name: z.string().trim().min(2).max(120).optional(),
  })
  .partial()
  .strict();

export const executeJsSandboxInputSchema = z.object({
  jsRuntimeId: z.string().trim().min(1).max(128),
  code: z.string().min(1).max(1024 * 1024),
  input: z.unknown().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
}).strict();

export function formatJsSandboxValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request payload';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

export type CreateJsSandboxRuntimePayload = z.infer<typeof createJsSandboxRuntimeInputSchema>;
export type UpdateJsSandboxRuntimePayload = z.infer<typeof updateJsSandboxRuntimeInputSchema>;
export type ExecuteJsSandboxPayload = z.infer<typeof executeJsSandboxInputSchema>;
