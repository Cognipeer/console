/**
 * The dashboard's licence toast must only fire for a licence refusal. A 403 of the
 * authorization engine carries structured fields (`code`, `service`, `decisionId`)
 * and a sentence in `error`; none of those may be mistaken for a licence refusal -
 * least of all a denial on the service that happens to be called `license`.
 */

// @vitest-environment jsdom
import { createElement, Fragment } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Notifications, notifications } from '@mantine/notifications';
import LicenseErrorHandler, {
  isAuthorizationUnavailablePayload,
  isLicenseErrorPayload,
} from '@/components/providers/LicenseErrorHandler';
import { installDomStubs, mount, settle, text, wait, type Mounted } from '../helpers/iamCenterUi';

describe('isLicenseErrorPayload', () => {
  it('recognises the licence gate\'s refusal', () => {
    expect(isLicenseErrorPayload({ error: 'Forbidden', message: 'Your license does not include Guardrails', requiredLicense: 'ENTERPRISE' })).toBe(true);
    expect(isLicenseErrorPayload({ error: 'Forbidden', message: 'This feature needs a License upgrade' })).toBe(true);
  });

  it('does not take an access denial of the engine for a licence refusal', () => {
    const denial = {
      error: 'Forbidden: license requires write permission',
      code: 'forbidden',
      message: 'Forbidden: license requires write permission',
      service: 'license',
      required: 'write',
      decisionId: '0b0c5f1a-3f0a-4a52-9c1d-8a6a1f9d2f77',
    };
    expect(isLicenseErrorPayload(denial)).toBe(false);
    expect(isLicenseErrorPayload({ ...denial, error: 'Forbidden: agents requires write permission', message: 'x', service: 'agents' })).toBe(false);
  });

  it('does not take a refusal because authorization was unavailable, or an undeclared route, for one either', () => {
    expect(isLicenseErrorPayload({ error: 'Authorization is temporarily unavailable', code: 'authorization_unavailable', decisionId: 'd' })).toBe(false);
    expect(isLicenseErrorPayload({ error: 'Forbidden', code: 'route_not_declared', message: 'This route has no authorization declaration' })).toBe(false);
  });

  it('ignores anything that is not a record', () => {
    for (const value of [null, undefined, 'license', 42, []]) expect(isLicenseErrorPayload(value)).toBe(false);
  });
});

describe('isAuthorizationUnavailablePayload', () => {
  it('recognises the answer of a request the engine could not decide', () => {
    expect(isAuthorizationUnavailablePayload({ error: 'Authorization is temporarily unavailable', code: 'authorization_unavailable', decisionId: 'd' })).toBe(true);
  });

  it('is not any other refusal', () => {
    expect(isAuthorizationUnavailablePayload({ error: 'Forbidden: agents requires write permission', code: 'forbidden' })).toBe(false);
    expect(isAuthorizationUnavailablePayload({ error: 'Service unavailable' })).toBe(false);
    for (const value of [null, undefined, 'x', 3]) expect(isAuthorizationUnavailablePayload(value)).toBe(false);
  });
});

describe('the dashboard\'s notice when the engine could not decide', () => {
  let mounted: Mounted;
  const realFetch = window.fetch;

  beforeAll(() => installDomStubs());
  afterEach(async () => {
    notifications.clean();
    await mounted?.unmount();
    window.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function install(answer: () => Response) {
    window.fetch = vi.fn(async () => answer()) as unknown as typeof fetch;
    mounted = await mount(createElement(Fragment, null, createElement(Notifications, null), createElement(LicenseErrorHandler)));
  }

  it('says so once, in words, however many requests fail at the same time', async () => {
    await install(() => json({ error: 'Authorization is temporarily unavailable', code: 'authorization_unavailable', decisionId: 'd1' }, 503));
    await Promise.all([window.fetch('/api/a'), window.fetch('/api/b'), window.fetch('/api/c')]);
    await settle(100);
    const t = text();
    expect(t).toContain('Authorization unavailable');
    expect(t).toContain('Authorization is temporarily unavailable, so this request was not decided. Try again in a moment.');
    expect(t.match(/Authorization unavailable/g)).toHaveLength(1);
  });

  it('leaves the response to the caller untouched', async () => {
    await install(() => json({ error: 'Authorization is temporarily unavailable', code: 'authorization_unavailable', decisionId: 'd1' }, 503));
    const res = await window.fetch('/api/a');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'authorization_unavailable', decisionId: 'd1' });
  });

  it('says nothing for an ordinary 503, a denial or a success', async () => {
    for (const [body, status] of [[{ error: 'Service unavailable' }, 503], [{ error: 'Forbidden: agents requires write permission', code: 'forbidden' }, 403], [{ ok: true }, 200]] as const) {
      await install(() => json(body, status));
      await window.fetch('/api/a');
      await settle(60);
      expect(text()).not.toContain('Authorization unavailable');
      expect(text()).not.toContain('License required');
      await mounted.unmount();
      window.fetch = realFetch;
    }
  });

  it('still raises the licence notice for a licence refusal', async () => {
    await install(() => json({ error: 'Forbidden', message: 'Your license does not include Guardrails', requiredLicense: 'ENTERPRISE' }, 403));
    await window.fetch('/api/a');
    await settle(60);
    expect(text()).toContain('License required');
    await wait(0);
  });
});
