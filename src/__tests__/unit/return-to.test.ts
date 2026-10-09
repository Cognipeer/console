import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignIfPortal,
  buildChangePasswordPath,
  buildLoginPath,
  isPortalPagePath,
  MAX_RETURN_TO_LENGTH,
  safeReturnTo,
} from '@/lib/security/returnTo';

describe('safeReturnTo', () => {
  it('accepts same-origin paths, with query and hash', () => {
    expect(safeReturnTo('/p/branch-assistant')).toBe('/p/branch-assistant');
    expect(safeReturnTo('/p/x?agent=a&b=%2Ffoo#top')).toBe('/p/x?agent=a&b=%2Ffoo#top');
    expect(safeReturnTo('/dashboard/agents')).toBe('/dashboard/agents');
    expect(safeReturnTo('/')).toBe('/');
  });

  it('falls back to /dashboard for missing or empty input', () => {
    expect(safeReturnTo(undefined)).toBe('/dashboard');
    expect(safeReturnTo(null)).toBe('/dashboard');
    expect(safeReturnTo('')).toBe('/dashboard');
  });

  it('honours a custom fallback', () => {
    expect(safeReturnTo('https://evil.example', '')).toBe('');
  });

  it.each([
    ['absolute URL', 'https://evil.example/p/x'],
    ['scheme-less host', 'evil.example/p/x'],
    ['relative path', 'p/x'],
    ['protocol-relative', '//evil.example'],
    ['protocol-relative with path', '//evil.example/p/x'],
    ['slash-backslash', '/\\evil.example'],
    ['backslash later in the path', '/p/..\\..\\evil'],
    ['embedded scheme', '/redirect?to=https://evil.example'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['tab hidden slash', '/\t/evil.example'],
    ['newline', '/p/x\n'],
    ['carriage return', '/p/x\r\nSet-Cookie: a=b'],
    ['NUL byte', '/p/x\u0000'],
    ['DEL', '/p/x\u007f'],
    ['dot-segment to protocol-relative', '/..//evil.example'],
    ['single-dot to protocol-relative', '/.//evil.example'],
    ['nested dot-segment', '/p/..//evil.example'],
    ['deep dot-segment', '/a/../..//evil.example'],
    ['encoded dot-segment', '/%2e%2e//evil.example'],
    ['encoded leading tab', '/%09/evil.example'],
    ['encoded leading backslash', '/%5Cevil.example'],
    ['encoded leading slash', '/%2Fevil.example'],
    ['empty segment in the middle', '/p//x/../..//evil.example'],
  ])('rejects %s', (_label, value) => {
    expect(safeReturnTo(value)).toBe('/dashboard');
  });

  it('enforces the length limit', () => {
    const atLimit = '/' + 'a'.repeat(MAX_RETURN_TO_LENGTH - 1);
    expect(atLimit.length).toBe(MAX_RETURN_TO_LENGTH);
    expect(safeReturnTo(atLimit)).toBe(atLimit);
    expect(safeReturnTo(atLimit + 'a')).toBe('/dashboard');
  });

  it('ignores non-string values', () => {
    expect(safeReturnTo(42 as unknown as string)).toBe('/dashboard');
    expect(safeReturnTo(['/p/x'] as unknown as string)).toBe('/dashboard');
  });
});

describe('buildLoginPath', () => {
  it('encodes the path and query into the login URL', () => {
    expect(buildLoginPath('/p/x?agent=a&b=1')).toBe('/login?returnTo=%2Fp%2Fx%3Fagent%3Da%26b%3D1');
  });

  it('drops a hostile value instead of echoing it', () => {
    expect(buildLoginPath('//evil.example')).toBe('/login');
    expect(buildLoginPath(null)).toBe('/login');
  });
});

describe('buildChangePasswordPath', () => {
  it('keeps the bare path for the default destination', () => {
    expect(buildChangePasswordPath('/dashboard')).toBe('/change-password');
    expect(buildChangePasswordPath('//evil.example')).toBe('/change-password');
  });

  it('carries a non-default destination', () => {
    expect(buildChangePasswordPath('/p/x')).toBe('/change-password?returnTo=%2Fp%2Fx');
  });
});

describe('isPortalPagePath', () => {
  it('matches the portal pages only', () => {
    expect(isPortalPagePath('/p')).toBe(true);
    expect(isPortalPagePath('/p/branch-assistant')).toBe(true);
    expect(isPortalPagePath('/pricing')).toBe(false);
    expect(isPortalPagePath('/dashboard/p/x')).toBe(false);
    expect(isPortalPagePath('/api/portal/x')).toBe(false);
  });
});

describe('assignIfPortal', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does a full page load for portal pages and leaves everything else to the router', () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    expect(assignIfPortal('/p/branch-assistant?agent=a')).toBe(true);
    expect(assign).toHaveBeenCalledWith('/p/branch-assistant?agent=a');
    assign.mockClear();
    expect(assignIfPortal('/dashboard')).toBe(false);
    expect(assignIfPortal('/pricing')).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it('does nothing outside a browser', () => {
    expect(assignIfPortal('/p/x')).toBe(false);
  });
});
