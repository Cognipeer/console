import { textSubject, toolCallSubject, toolResultSubject } from '@/lib/services/guardrail/hooks/contract';
import type { HookSubject, HookVerdict } from '@/lib/services/guardrail/hooks/contract';
import type { AIMessage, HookMap, Message } from '@cognipeer/agent-sdk';
import { isRecord } from './sdkLoader';
import { contentSubject, messageText, rewriteContent, sliceMessages } from './subject';
import type { RunScanState } from './subject';
import type { PluginRewrite } from './types';

/** Per-plugin-hook payload plumbing: what to scan, and where a rewrite goes. */
interface PayloadAdapter {
  subject: (payload: Record<string, unknown>, state: RunScanState) => {
    subject: HookSubject | null;
    roles?: string[];
  };
  /**
   * Build the rewritten payload field(s) from the verdict's rewritten subject,
   * under the hook's own writable key. `undefined` when the rewrite has nowhere
   * to land, which the handler reports rather than treating as a pass.
   */
  rewrite?: (
    payload: Record<string, unknown>,
    rewritten: HookSubject,
    verdict: HookVerdict,
  ) => PluginRewrite | undefined;
}

/** First present string among several plausible payload spellings. */
function pickString(payload: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickRecord(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (isRecord(value)) return value;
  }
  return undefined;
}

function pickAny(payload: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined) return payload[key];
  }
  return undefined;
}

/**
 * READ-side field names are tolerant, WRITE-side names are not.
 *
 * The rewrite key is fixed by the SDK team's own list (`preToolUse.args`,
 * `postToolUse.output`, `postModelCall.message`, `userPromptSubmit.text`) — a
 * rewrite returned under a name the host does not read is a redaction that
 * silently does not happen. The names a payload is READ under are guessed
 * generously in the other direction, because failing to find the arguments only
 * costs a scan, and the alternative is a handler that silently sees nothing on a
 * build that spells the field `input` rather than `args`.
 */
export const PAYLOAD_ADAPTERS: Readonly<Record<string, PayloadAdapter>> = {
  userPromptSubmit: {
    subject: (payload) => {
      const text = pickString(payload, ['text', 'prompt']);
      if (text !== undefined) return { subject: textSubject(text, '/text'), roles: ['user'] };
      return { subject: contentSubject(payload.content, '/content'), roles: ['user'] };
    },
    rewrite: (payload, rewritten) => {
      if (typeof payload.text === 'string') return { text: rewritten.text };
      const content = rewriteContent(payload.content, rewritten, '/content');
      if (content === undefined) return undefined;
      // `rewriteContent` preserves the parts array's shape (non-text parts are
      // returned untouched, text parts get a new `text`), so this is the same
      // `ContentPart[]` the host handed in.
      return { content: content as HookMap['userPromptSubmit']['output']['content'] };
    },
  },

  // PER-MESSAGE REWRITE. The slice's segments are addressed by message index
  // (`/messages/<i>/content[...]`), so each rewritten segment goes back to the
  // message it came from and every other message — and every non-text part —
  // is returned by identity. The host sends the result to the provider as the
  // wire transcript; see `PLUGIN_REWRITE_FIELD` for why that is not the same as
  // the persisted one.
  preModelCall: {
    subject: (payload, state) => {
      const messages = Array.isArray(payload.messages)
        ? (payload.messages as (Message | undefined)[])
        : [];
      const slice = sliceMessages(messages, `preModelCall:${messages.length}`, state);
      return {
        subject: slice.segments.length > 0
          ? { kind: 'text', text: slice.text, segments: slice.segments }
          : null,
        roles: slice.roles,
      };
    },
    rewrite: (payload, rewritten) => {
      if (!Array.isArray(payload.messages)) return undefined;
      const messages = payload.messages as (Message | undefined)[];
      let landed = false;
      const next = messages.map((message, index) => {
        if (!message) return message;
        const base = `/messages/${index}/content`;
        const touched = rewritten.segments.some(
          (segment) => segment.path === base || segment.path.startsWith(`${base}/`),
        );
        if (!touched) return message;
        const content = rewriteContent(message.content, rewritten, base);
        if (content === undefined) return message;
        const candidate = { ...message, content } as Message;
        // Identity for an untouched message: the host's `mutated` flag and the
        // rewrite ledger both key on "did this entry change".
        if (messageText(candidate) === messageText(message)) return message;
        landed = true;
        return candidate;
      });
      return landed ? { messages: next.filter((message): message is Message => message !== undefined) } : undefined;
    },
  },

  postModelCall: {
    subject: (payload) => {
      const message = pickRecord(payload, ['message', 'assistantMessage', 'response']);
      const content = message ? message.content : payload.content;
      return {
        subject: contentSubject(content, '/content'),
        roles: [String(message?.role ?? 'assistant')],
      };
    },
    rewrite: (payload, rewritten) => {
      const message = pickRecord(payload, ['message', 'assistantMessage', 'response']);
      if (!message) return undefined;
      const content = rewriteContent(message.content, rewritten, '/content');
      // Same record the host handed in, with only `content` replaced — which is
      // what makes it still the `AIMessage` the host expects back.
      return content === undefined ? undefined : { message: { ...message, content } as AIMessage };
    },
  },

  preToolUse: {
    subject: (payload) => {
      const args = pickRecord(payload, ['args', 'input', 'arguments', 'parameters']) ?? {};
      const subject = toolCallSubject({
        toolName: pickString(payload, ['toolName', 'tool_name', 'name', 'tool']) ?? 'unknown',
        args,
        providerRef: pickString(payload, ['providerRef', 'provider_ref', 'server']) ?? 'agent:plugin',
      });
      return { subject, roles: ['tool'] };
    },
    // `verdict.subject.args` is the CLONE `applyMutations` rewrote; returning it
    // is what makes the tool execute against the redacted arguments.
    rewrite: (_payload, rewritten) =>
      rewritten.kind === 'tool_call' ? { args: rewritten.args } : undefined,
  },

  postToolUse: {
    subject: (payload) => {
      const result = pickAny(payload, ['output', 'result', 'toolResult', 'tool_result']);
      const subject = toolResultSubject({
        toolName: pickString(payload, ['toolName', 'tool_name', 'name', 'tool']) ?? 'unknown',
        args: pickRecord(payload, ['args', 'input', 'arguments']) ?? {},
        result,
        providerRef: pickString(payload, ['providerRef', 'provider_ref', 'server']) ?? 'agent:plugin',
      });
      return { subject, roles: ['tool'] };
    },
    rewrite: (_payload, rewritten) =>
      rewritten.kind === 'tool_result' ? { output: rewritten.result } : undefined,
  },
};
