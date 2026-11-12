/**
 * Shared route helpers for the guardrail, MCP and automation plugin pairs.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildUserMessage,
  findRegexRuleError,
  guardrailWriteErrorBody,
  parseGuardrailCreateBody,
  parseGuardrailPatchBody,
} from '@/server/api/plugins/guardrail-write';
import { readMcpCreateHead, readMcpUpstreamBody } from '@/server/api/plugins/mcp-shared';
import { automationHandlers } from '@/server/api/plugins/automations-shared';

describe('guardrail-write parsers', () => {
  it('validates the create body before anything else', () => {
    expect(parseGuardrailCreateBody({})).toMatchObject({ ok: false, status: 400, error: 'name is required' });
    expect(parseGuardrailCreateBody({ name: 'g', action: 'nope' })).toMatchObject({ ok: false });
    expect(parseGuardrailCreateBody({ name: 'g', failMode: 'x' })).toMatchObject({
      error: 'failMode must be "open" or "closed"',
    });
  });

  it('refuses the retired fields with a 400 on create and patch', () => {
    for (const parse of [parseGuardrailCreateBody, parseGuardrailPatchBody]) {
      const base = parse === parseGuardrailCreateBody ? { name: 'g' } : {};
      expect(parse({ ...base, policy: { pii: { enabled: true } } })).toMatchObject({
        ok: false,
        status: 400,
        error: expect.stringContaining('policy is no longer supported'),
      });
      expect(parse({ ...base, customPrompt: 'judge this' })).toMatchObject({
        ok: false,
        status: 400,
        error: expect.stringContaining('customPrompt is no longer supported'),
      });
      expect(parse({ ...base, type: 'custom' })).toMatchObject({
        ok: false,
        status: 400,
        error: expect.stringContaining('type is no longer supported'),
      });
    }
  });

  it('still accepts `type: "preset"` from an older client', () => {
    expect(parseGuardrailCreateBody({ name: 'g', type: 'preset' })).toMatchObject({ ok: true });
    expect(parseGuardrailPatchBody({ type: 'preset' })).toMatchObject({ ok: true });
  });

  it('defaults action and enabled and trims the name', () => {
    const parsed = parseGuardrailCreateBody({ name: '  g  ' });
    expect(parsed).toMatchObject({ ok: true, value: { name: 'g', action: 'block', enabled: true } });
  });

  it('reports the first hook error and the full list', () => {
    const parsed = parseGuardrailCreateBody({ name: 'g', hooks: 'nope' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(guardrailWriteErrorBody(parsed)).toEqual({
        error: 'hooks must be an object',
        errors: ['hooks must be an object'],
      });
    }
  });

  it('explains an invalid regex rule on both create and patch', () => {
    const body = () => ({
      name: 'g',
      hooks: { policies: [{ id: 'p', family: 'regex', enabled: true, rules: [{ id: 'r', pattern: '(' }] }] },
    });
    expect(findRegexRuleError(body())).toMatch(/^Regex rule "r": /);
    const created = parseGuardrailCreateBody(body());
    expect(created.ok).toBe(false);
    const patched = parseGuardrailPatchBody(body());
    expect(patched.ok).toBe(false);
    if (!created.ok && !patched.ok) expect(created.error).toBe(patched.error);
  });

  it('ignores a rule inside a disabled policy', () => {
    expect(
      findRegexRuleError({
        hooks: { policies: [{ id: 'p', family: 'regex', enabled: false, rules: [{ pattern: '(' }] }] },
      }),
    ).toBeNull();
  });

  it('accepts an empty patch', () => {
    expect(parseGuardrailPatchBody({})).toMatchObject({ ok: true });
    expect(parseGuardrailPatchBody({ mode: 'bogus' })).toMatchObject({ ok: false, status: 400 });
  });

  it('summarizes blocking findings', () => {
    expect(buildUserMessage([])).toBe('Content flagged by guardrail.');
    expect(buildUserMessage([{ block: true, category: 'prompt_injection', message: 'm' }])).toBe(
      'Content blocked by guardrail:\n• Prompt Injection: m',
    );
  });
});

describe('mcp-shared create parsing', () => {
  const all = ['openapi', 'remote', 'stdio', 'internal', 'composite'] as const;
  const narrow = ['openapi', 'remote', 'stdio'] as const;

  it('words the source type error from the surface list', () => {
    expect(readMcpCreateHead({ name: 'n', sourceType: 'internal' }, { allowedSourceTypes: narrow })).toEqual({
      ok: false,
      status: 400,
      error: 'sourceType must be "openapi", "remote", or "stdio"',
    });
    expect(readMcpCreateHead({ name: 'n', sourceType: 'x' }, { allowedSourceTypes: all })).toMatchObject({
      error: 'sourceType must be "openapi", "remote", "stdio", "internal", or "composite"',
    });
  });

  it('validates the per-source required fields', () => {
    expect(readMcpCreateHead({}, { allowedSourceTypes: all })).toMatchObject({ error: 'name is required' });
    expect(readMcpCreateHead({ name: 'n' }, { allowedSourceTypes: all })).toMatchObject({
      error: 'openApiSpec is required',
    });
    expect(readMcpCreateHead({ name: 'n', sourceType: 'remote' }, { allowedSourceTypes: all })).toMatchObject({
      error: 'remoteConfig.url is required',
    });
    expect(readMcpCreateHead({ name: 'n', sourceType: 'stdio' }, { allowedSourceTypes: all })).toMatchObject({
      error: 'stdioConfig.packageName is required',
    });
    expect(
      readMcpCreateHead(
        { name: ' n ', sourceType: 'remote', remoteConfig: { url: ' https://x ' } },
        { allowedSourceTypes: all },
      ),
    ).toMatchObject({ ok: true, value: { name: 'n', remoteConfig: { url: 'https://x', transport: 'streamable-http' } } });
  });

  it('defaults a remote server to no upstream auth', () => {
    const body: Record<string, unknown> = {};
    expect(readMcpUpstreamBody(body, 'remote')).toEqual({ ok: true, upstreamAuth: { type: 'none' } });
    expect(readMcpUpstreamBody({}, 'openapi')).toMatchObject({ ok: false, error: 'upstreamAuth with type is required' });
    expect(readMcpUpstreamBody({ upstreamAuth: { type: 'weird' } }, 'openapi')).toMatchObject({ ok: false });
  });
});

describe('automationHandlers', () => {
  function makeReply() {
    const reply = {
      statusCode: 0,
      payload: undefined as unknown,
      code(status: number) {
        reply.statusCode = status;
        return reply;
      },
      send(payload: unknown) {
        reply.payload = payload;
        return reply;
      },
    };
    return reply;
  }

  it('answers 500 and logs when authentication throws', async () => {
    const logger = { error: vi.fn() };
    const handlers = automationHandlers({
      authenticate: () => {
        throw new Error('nope');
      },
      logger,
      subject: 'client automation',
    });
    const reply = makeReply();
    await handlers.list({} as never, reply as never);
    expect(reply.statusCode).toBe(500);
    expect(reply.payload).toEqual({ error: 'Internal server error' });
    expect(logger.error).toHaveBeenCalledWith('List client automations failed', expect.anything());
  });

  it('rejects an unknown automation key with 400 after authenticating', async () => {
    const authenticate = vi.fn();
    const handlers = automationHandlers({ authenticate, logger: { error: vi.fn() }, subject: 'automation' });
    for (const name of ['get', 'run', 'pause', 'resume'] as const) {
      const reply = makeReply();
      await handlers[name]({ params: { key: 'not-a-key' } } as never, reply as never);
      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toEqual({ error: 'Invalid automation key' });
    }
    expect(authenticate).toHaveBeenCalledTimes(4);
  });
});
