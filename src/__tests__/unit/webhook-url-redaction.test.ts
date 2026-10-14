/**
 * What a reader of `webhooks` sees of a receiver address: its scheme and host, and a MASKED path - the query
 * string, the fragment and the userinfo are not shown, and neither is any path segment longer than eight
 * characters. Receivers hand out their secret in the path as often as in the query string (a chat tool's
 * incoming-webhook address ends in its token; an automation tool's catch-hook address is one).
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

  it.each([
    // a chat tool's incoming webhook: the identifiers stay, the token goes
    ['https://hooks.slack.com/services/T0000/B0000/XXXXXXXXSECRETXXXX', 'https://hooks.slack.com/services/T0000/B0000/…'],
    ['https://discord.com/api/webhooks/123/TOKENTOKEN', 'https://discord.com/api/webhooks/123/…'],
    // an automation tool's catch hook IS the secret, even as the first segment
    ['https://hook.eu1.make.com/abcdefghijklmnopqrstuvwxyz', 'https://hook.eu1.make.com/…'],
    ['https://n8n.example.com/webhook/0a1b2c3d-1111-2222-3333-444455556666', 'https://n8n.example.com/webhook/…'],
    // a trailing slash and a query string survive as what they are
    ['https://hooks.example.com/in/abcdefghijkl/', 'https://hooks.example.com/in/…/'],
    ['https://hooks.example.com/in/abcdefghijkl?sig=1', 'https://hooks.example.com/in/…?…'],
    ['https://user:pw@hooks.example.com:8443/a/b/ZZZZZZZZZZZZ#f', 'https://hooks.example.com:8443/a/b/…?…'],
  ])('masks the path of %s', (url, shown) => {
    expect(redactWebhookUrl(url)).toBe(shown);
  });

  it('keeps a segment of up to eight characters and hides one of nine', () => {
    expect(redactWebhookUrl('https://h.example.com/12345678/123456789')).toBe('https://h.example.com/12345678/…');
  });

  it('never shows the token of a path, however it is written', () => {
    for (const url of [
      'https://hooks.slack.com/services/T0000/B0000/XXXXXXXXSECRETXXXX',
      'https://hook.eu1.make.com/SECRETSECRETSECRET',
      'https://discord.com/api/webhooks/123/SECRETSECRET?wait=true',
      '//u:p@host/a/SECRETSECRETSECRET',
      'not a url/SECRETSECRETSECRET',
    ]) {
      expect(redactWebhookUrl(url)).not.toContain('SECRET');
    }
  });

  it('never throws and never lets the query string or userinfo through, whatever it is given', () => {
    expect(redactWebhookUrl('not a url?token=abc')).toBe('…?…');
    expect(redactWebhookUrl('//user:pw@host/path?token=abc')).toBe('//host/path?…');
    expect(redactWebhookUrl('')).toBe('');
    for (const url of ['https://h/p?a=secret', 'https://u:secret@h/p', 'x?secret', 'y#secret']) {
      expect(redactWebhookUrl(url)).not.toContain('secret');
    }
  });
});
