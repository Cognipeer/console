/**
 * Pure request-body parsing shared by the dashboard and client prompt routes.
 * No request, reply or auth access: callers pass the decoded JSON body and
 * map the typed result onto their own response envelope.
 */

export interface PromptCreateRequest {
  description?: string;
  key?: string;
  metadata?: Record<string, unknown>;
  name: string;
  template: string;
  versionComment?: string;
}

export interface PromptUpdateRequest {
  description?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  template?: string;
  versionComment?: string;
}

export type PromptCreateParseResult =
  | { ok: true; value: PromptCreateRequest }
  | { ok: false; status: 400; error: string };

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function versionCommentOf(body: Record<string, unknown>): string | undefined {
  return optionalString(body.versionComment ?? body.comment);
}

export function parseCreatePromptBody(body: Record<string, unknown>): PromptCreateParseResult {
  for (const field of ['name', 'template'] as const) {
    const value = body[field];
    if (!value || (typeof value === 'string' && value.trim() === '')) {
      return { ok: false, status: 400, error: `${field} is required` };
    }
    if (typeof value !== 'string') {
      return { ok: false, status: 400, error: `${field} must be a string` };
    }
  }

  return {
    ok: true,
    value: {
      description: optionalString(body.description),
      key: optionalString(body.key),
      metadata: optionalRecord(body.metadata),
      name: body.name as string,
      template: body.template as string,
      versionComment: versionCommentOf(body),
    },
  };
}

export function parseUpdatePromptBody(body: Record<string, unknown>): PromptUpdateRequest {
  return {
    description: optionalString(body.description),
    metadata: optionalRecord(body.metadata),
    name: optionalString(body.name),
    template: optionalString(body.template),
    versionComment: versionCommentOf(body),
  };
}
