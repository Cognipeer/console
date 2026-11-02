import { describe, expect, it } from 'vitest';
import { investigateWindow, modelLogsHref, sessionsHref } from '@/components/alerts/incident/investigateLinks';

const MIN = 60_000;

describe('investigateWindow', () => {
  it('spans one detection window before the fire until just after it resolved', () => {
    const w = investigateWindow({ firedAt: '2026-11-02T10:00:00.000Z', resolvedAt: '2026-11-02T10:20:00.000Z' }, 15)!;
    expect(w.from.toISOString()).toBe('2026-11-02T09:45:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-02T10:25:00.000Z');
  });

  it('runs to now while the incident is open, and defaults the lead-in', () => {
    const now = new Date('2026-11-02T12:00:00.000Z');
    const w = investigateWindow({ firedAt: '2026-11-02T10:00:00.000Z' }, undefined, now)!;
    expect(w.from.getTime()).toBe(Date.parse('2026-11-02T10:00:00.000Z') - 30 * MIN);
    expect(w.to.getTime()).toBe(now.getTime() + 5 * MIN);
  });

  it('returns null for an unparseable fire time', () => {
    expect(investigateWindow({ firedAt: 'nope' }, 5)).toBeNull();
  });
});

describe('links', () => {
  const w = { from: new Date('2026-11-02T09:45:00.000Z'), to: new Date('2026-11-02T10:25:00.000Z') };

  it('filters sessions by agent, status and instant range', () => {
    const url = new URL(sessionsHref(w, { agent: 'support-bot', failedOnly: true }), 'http://x');
    expect(url.pathname).toBe('/dashboard/tracing/sessions');
    expect(url.searchParams.get('agent')).toBe('support-bot');
    expect(url.searchParams.get('status')).toBe('error');
    expect(url.searchParams.get('from')).toBe(w.from.toISOString());
    expect(url.searchParams.get('to')).toBe(w.to.toISOString());
  });

  it('omits agent and status when not asked', () => {
    const url = new URL(sessionsHref(w), 'http://x');
    expect(url.searchParams.has('agent')).toBe(false);
    expect(url.searchParams.has('status')).toBe(false);
  });

  it('opens the model Logs tab with a custom day range', () => {
    const url = new URL(modelLogsHref('/dashboard/models/abc123', w), 'http://x');
    expect(url.pathname).toBe('/dashboard/models/abc123');
    expect(url.searchParams.get('tab')).toBe('logs');
    expect(url.searchParams.get('period')).toBe('custom');
    expect(url.searchParams.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(url.searchParams.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
