/**
 * The thin request wrappers of the access screens, now over the shared API client: they keep their own error classes
 * (status, code, problems) and their return shapes, so the screens that call them see no difference.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IamApiError, iamApi } from '@/components/iam/api';
import { IamApiError as PrincipalsApiError, iamRequest } from '@/components/iam/principals/client';
import { DelegationApiError, delegationApi } from '@/components/iam/tokens/delegationApi';
import { tokenCallError } from '@/components/iam/tokens/tokenErrors';
import { ApiError } from '@/lib/api/client';
import { resolvePickerOption, searchPickerOptions, searchTargetOptions } from '@/components/quota/pickerSources';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return responder(url, init);
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the IAM center client', () => {
  it('a body that is not JSON on a success is an invalid_response error, and an empty one is no content', async () => {
    stubFetch(() => new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    const error = await iamApi.getCatalog().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IamApiError);
    expect(error).toMatchObject({ code: 'invalid_response', message: 'Invalid JSON in response' });

    stubFetch(() => new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(iamApi.getCatalog()).rejects.toMatchObject({ code: 'invalid_response' });

    stubFetch(() => new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    await expect(iamApi.deletePolicy('p1')).resolves.toBeUndefined();
  });

  it('iamRequest: a success that is not JSON is an invalid_response error, an empty one is null, a JSON text still parses', async () => {
    stubFetch(() => new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    const error = await iamRequest('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrincipalsApiError);
    expect(error).toMatchObject({ code: 'invalid_response', message: 'Invalid JSON in response' });

    stubFetch(() => new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    await expect(iamRequest('/x')).resolves.toBeNull();

    stubFetch(() => new Response('{"items":[]}', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    await expect(iamRequest('/x')).resolves.toEqual({ items: [] });

    stubFetch(() => json({ items: [1] }));
    await expect(iamRequest('/x')).resolves.toEqual({ items: [1] });
  });

  it('keeps the message, the code and the details of a refusal, and falls back to the message field', async () => {
    stubFetch(() => json({ message: 'Slow down', code: 'rate_limited' }, 429));
    const error = (await iamApi.getCatalog().catch((e: unknown) => e)) as IamApiError;
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', message: 'Slow down', details: [] });
  });

  it('a lost connection stays what it is (not an IamApiError)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const error = await iamApi.getCatalog().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    await expect(iamRequest('/x')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('the delegation calls', () => {
  it('reads and saves the delegation of a token (a JSON PUT) and removes it', async () => {
    const calls = stubFetch((_url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ delegation: { mode: 'selected' }, tokenScoped: false });
    });
    await expect(delegationApi.get('t/1')).resolves.toEqual({ delegation: { mode: 'selected' }, tokenScoped: false });
    await expect(delegationApi.save('t/1', { mode: 'all' })).resolves.toMatchObject({ tokenScoped: false });
    await expect(delegationApi.remove('t/1')).resolves.toBeUndefined();
    expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET /api/tokens/t%2F1/delegation',
      'PUT /api/tokens/t%2F1/delegation',
      'DELETE /api/tokens/t%2F1/delegation',
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ mode: 'all' });
  });

  it('a refusal carries the status, the code and the problems the server found', async () => {
    stubFetch(() => json({ error: 'Not valid', code: 'invalid_delegation', problems: [{ field: 'users', message: 'Unknown user' }, { message: 'Too many' }, { field: 'x' }] }, 400));
    const error = await delegationApi.save('t1', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DelegationApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'invalid_delegation',
      message: 'Not valid',
      problems: [{ field: 'users', message: 'Unknown user' }, { field: '', message: 'Too many' }],
    });
  });

  it('a refusal without a body says the status; a read that is not an object is an empty state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubFetch(() => new Response('', { status: 503 }));
    await expect(delegationApi.get('t1')).rejects.toMatchObject({ status: 503, message: 'HTTP 503', code: null, problems: [] });
    stubFetch(() => json([1, 2]));
    await expect(delegationApi.get('t1')).resolves.toEqual({ delegation: null, tokenScoped: true });
  });
});

describe('the token errors', () => {
  const t = (key: string) => `[${key}]`;

  it('turns the answer of the server into a message in the UI language, or the server text', () => {
    const known = new ApiError('Too long', 400, { code: 'token_expiry_too_long', details: { maxLifetimeDays: 30 } });
    expect(tokenCallError(known, t, 'fallback').message).toBe('[errors.token_expiry_too_long]');
    expect(tokenCallError(new ApiError('Boom', 500, { error: 'Boom' }), t, 'fallback').message).toBe('Boom');
    expect(tokenCallError(new ApiError('', 500), t, 'fallback').message).toBe('fallback');
  });

  it('keeps a lost connection as it is', () => {
    const lost = new TypeError('Failed to fetch');
    expect(tokenCallError(lost, t, 'fallback')).toBe(lost);
    expect(tokenCallError('weird', t, 'fallback').message).toBe('fallback');
  });
});

describe('the quota pickers over the shared client', () => {
  it('search the principals through GET and read the options', async () => {
    const calls = stubFetch(() => json({ items: [{ id: 'u1', label: 'Ann', sublabel: 'ann@example.com' }] }));
    await expect(searchPickerOptions('user', ' an ')).resolves.toEqual([{ value: 'u1', label: 'Ann', description: 'ann@example.com' }]);
    expect(calls[0]?.url).toBe('/api/iam/principals?type=user&limit=20&q=an');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('fall back to the plain list when the principals route is refused', async () => {
    stubFetch((url) =>
      url.startsWith('/api/iam/principals') ? json({ error: 'Forbidden' }, 403) : json({ users: [{ _id: 'u1', name: 'Ann', email: 'ann@example.com' }, { _id: 'u2', name: 'Bob' }] }),
    );
    await expect(searchPickerOptions('user', 'ann')).resolves.toEqual([{ value: 'u1', label: 'Ann', description: 'ann@example.com' }]);
  });

  it('resolve one stored id from its principal', async () => {
    stubFetch(() => json({ principal: { label: 'Ann', sublabel: 'ann@example.com' } }));
    await expect(resolvePickerOption('user', 'u/1')).resolves.toEqual({ value: 'u/1', label: 'Ann', description: 'ann@example.com' });
  });

  it('tell a refused registry search from a failed one, and an unreadable answer is a failure', async () => {
    const source = { types: ['model'] } as never;
    for (const status of [401, 403, 404]) {
      stubFetch(() => json({ error: 'no' }, status));
      await expect(searchTargetOptions(source, 'x')).resolves.toEqual({ status: 'unavailable' });
    }
    stubFetch(() => json({ error: 'boom' }, 500));
    await expect(searchTargetOptions(source, 'x')).resolves.toEqual({ status: 'failed' });
    stubFetch(() => new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    await expect(searchTargetOptions(source, 'x')).resolves.toEqual({ status: 'failed' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(searchTargetOptions(source, 'x')).resolves.toEqual({ status: 'failed' });
  });

  it('read the registry answer and pass the abort signal on', async () => {
    const calls = stubFetch(() => json({ items: [{ type: 'model', id: 'm1', key: 'gpt', name: 'GPT' }], total: 1 }));
    const controller = new AbortController();
    const result = await searchTargetOptions({ types: ['model'], valueField: 'key' } as never, 'gp', undefined, controller.signal);
    expect(result).toMatchObject({ status: 'ok', total: 1, complete: true, options: [{ id: 'model:m1', value: 'gpt', label: 'GPT' }] });
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });
});
