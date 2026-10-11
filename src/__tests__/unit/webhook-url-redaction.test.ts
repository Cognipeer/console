/**
 * What a reader of `webhooks` sees of a receiver address: its scheme, host and path - the query string, the
 * fragment and the userinfo (the places a token goes) are not shown.
 */
import { describe, expect, it } from 'vitest';
import { redactWebhookUrl } from '@/lib/services/webhooks/webhookEndpointService';

describe('redactWebhookUrl', () => {
  it.each([
    ['https://hooks.example.com/in', 'https://hooks.example.com/in'],
    ['https://hooks.example.com/in?token=abc', 'https://hooks.example.com/in?…'],
    ['https://hooks.example.com/in?token=abc#frag', 'https://hooks.example.com/in?…'],
    ['https://hooks.example.com/in#frag', 'https://hooks.example.com/in?…'],
    ['https://user:pw@hooks.example.com:8443/a/b?x=1', 'https://hooks.example.com:8443/a/b?…'],
    ['http://user@hooks.example.com/', 'http://hooks.example.com/'],
    ['https://hooks.example.com', 'https://hooks.example.com/'],
  ])('%s -> %s', (url, shown) => {
    expect(redactWebhookUrl(url)).toBe(shown);
  });

  it('never throws and never lets the query string or userinfo through, whatever it is given', () => {
    expect(redactWebhookUrl('not a url?token=abc')).toBe('not a url?…');
    expect(redactWebhookUrl('//user:pw@host/path?token=abc')).toBe('//host/path?…');
    expect(redactWebhookUrl('')).toBe('');
    for (const url of ['https://h/p?a=secret', 'https://u:secret@h/p', 'x?secret', 'y#secret']) {
      expect(redactWebhookUrl(url)).not.toContain('secret');
    }
  });
});
