/**
 * Delegation tests with the REAL agent-sdk loop: scripted chat models (one per
 * model key), the replies a parent sends to delegate, and the SDK version gate.
 *
 * The gateway's part of an agent's bookkeeping (what a request cost, the run's
 * token tally) is played by `settlingModel` (fakeGatewayModel.ts), so a test can
 * compare what the console reports with what the "gateway" recorded.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

type AnyRecord = Record<string, unknown>;

/** The installed agent-sdk. The delegation hardening these tests rely on ships in 0.15.0. */
export const SDK_VERSION: string = JSON.parse(
  readFileSync(path.join(process.cwd(), 'node_modules/@cognipeer/agent-sdk/package.json'), 'utf8'),
).version;

export const SDK_HAS_DELEGATION_HARDENING = (() => {
  const [major, minor] = SDK_VERSION.split('.').map(Number);
  return major > 0 || minor >= 15;
})();

export type Reply = AnyRecord;
export type SeenMessage = { role: string; content: unknown; name?: string; tool_call_id?: string };

/** The SDK's own usage shape on a reply (the gateway reports it the same way). */
export const usageMeta = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output,
});

export const toolCall = (id: string, name: string, args: AnyRecord) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

export const answer = (content: string, usage?: { input: number; output: number }): Reply => ({
  role: 'assistant',
  content,
  ...(usage ? { usage_metadata: usageMeta(usage.input, usage.output) } : {}),
});

export const callTools = (calls: Array<ReturnType<typeof toolCall>>, usage?: { input: number; output: number }): Reply => ({
  role: 'assistant',
  content: '',
  tool_calls: calls,
  ...(usage ? { usage_metadata: usageMeta(usage.input, usage.output) } : {}),
});

/** A reply that delegates one task to a registry sub-agent. */
export const delegateTo = (callId: string, subagent: string, input: string, usage?: { input: number; output: number }): Reply =>
  callTools([toolCall(callId, 'delegate_to', { subagent, input })], usage);

/** Reply `n` of a script, as `(call, messages) => Reply`. */
export type Script = (call: number, messages: SeenMessage[]) => Reply;

/**
 * A chat model that replies from a script and remembers what it was shown.
 * With `streamChunks` it also streams: the chunks are yielded as the model's
 * text deltas, then the reply itself (tool calls, usage) is the last chunk.
 */
export class ScriptedModel {
  seen: SeenMessage[][] = [];
  /** Every reply the model gave (what its usage said is what a gateway would have recorded). */
  replies: Reply[] = [];
  constructor(
    readonly modelName: string,
    private readonly script: Script,
    private readonly streamChunks: (call: number) => unknown[] | undefined = () => undefined,
  ) {}

  bindTools() {
    return this;
  }

  async invoke(messages: SeenMessage[]): Promise<Reply> {
    const call = this.seen.length;
    this.seen.push(messages);
    const reply = this.script(call, messages);
    this.replies.push(reply);
    return reply;
  }

  async *stream(messages: SeenMessage[]): AsyncGenerator<unknown> {
    const call = this.seen.length;
    this.seen.push(messages);
    const reply = this.script(call, messages);
    this.replies.push(reply);
    for (const chunk of this.streamChunks(call) ?? []) yield chunk;
    yield { ...reply, content: this.streamChunks(call) ? '' : reply.content };
  }

  /** The tokens the model reported over all its calls. */
  reportedTokens(): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const reply of this.replies) {
      const usage = reply.usage_metadata as { input_tokens?: number; output_tokens?: number } | undefined;
      input += usage?.input_tokens ?? 0;
      output += usage?.output_tokens ?? 0;
    }
    return { input, output };
  }

  /** Every system message of every call, as plain text. */
  systemPrompts(): string[] {
    return this.seen.flatMap((messages) => messages
      .filter((message) => message.role === 'system')
      .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))));
  }
}

/** The text the model was shown, flattened (for "does the prompt mention X" checks). */
export function shownText(model: ScriptedModel): string {
  return model.seen
    .flat()
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n');
}
