import { ZodError } from 'zod';
import { formatBrowserValidationError } from './validation';

export function getBrowserErrorStatus(error: unknown): number {
  if (error instanceof SyntaxError || error instanceof ZodError) return 400;

  if (!(error instanceof Error)) return 500;

  if (error.message === 'Unauthorized') return 401;
  if (error.message.includes('not found')) return 404;
  if (error.message.includes('Cannot delete browser with existing sessions')) return 409;
  if (
    error.message.includes('blocked by egress policy')
    || error.message.includes('private-network egress is blocked')
    || error.message.includes('host is blocked by session policy')
    || error.message.includes('host is not allowed by session policy')
  ) {
    return 403;
  }
  if (
    error.message.includes('No artifact bucket configured')
    || error.message.includes('is not active')
    || error.message.includes('Unsupported action type')
  ) {
    return 400;
  }

  return 500;
}

export function getBrowserErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ZodError) {
    return formatBrowserValidationError(error);
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
