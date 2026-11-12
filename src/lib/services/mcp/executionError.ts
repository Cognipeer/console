import { getConfig } from '@/lib/core/config';
import { maskSecretValues } from '@/lib/services/logRedaction';

/**
 * Mask secret values in an error an executor is about to throw, in place (the
 * class and any structured fields survive), and bound its length. The text of
 * an upstream failure — a response body, a stderr tail, a remote client error —
 * is not ours to vouch for, and it travels to whoever made the call.
 */
export function sanitizeExecutionError(error: unknown, secretValues: string[]): Error {
  const original = error instanceof Error
    ? error
    : new Error(typeof error === 'string' ? error : 'Tool execution failed');
  const originalMessage = original.message;
  const message = maskSecretValues(originalMessage, secretValues, {
    maxChars: getConfig().mcp.errorMessageMaxChars,
  });
  if (message === originalMessage) return original;
  try {
    const stack = original.stack;
    original.message = message;
    if (typeof stack === 'string') {
      // The stack opens with the message text: swap in the safe one, keep the frames.
      const at = stack.indexOf(originalMessage);
      original.stack = maskSecretValues(
        at >= 0 ? `${stack.slice(0, at)}${message}${stack.slice(at + originalMessage.length)}` : stack,
        secretValues,
      );
    }
    return original;
  } catch {
    // A frozen error cannot be edited: hand back a copy that carries the safe text.
    const copy = new Error(message);
    copy.name = original.name;
    return copy;
  }
}
