/**
 * The server runs as `node --import tsx` (npm start, the Docker CMD), where
 * modules resolve by Node's own rules, stricter than the test runner's. A mail
 * must render and go out there: a child process in that runtime sends one to a
 * local SMTP sink, and the test reads what arrived.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { JSDOM } from 'jsdom';

const run = promisify(execFile);

// Takes one message over plain SMTP and resolves with its DATA section.
async function startSmtpSink() {
  let deliver!: (data: string) => void;
  const message = new Promise<string>((resolve) => { deliver = resolve; });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let inData = false;
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end === -1) return;
        deliver(buffer.slice(0, end));
        buffer = buffer.slice(end + 5);
        inData = false;
        socket.write('250 OK\r\n');
      }
      let lineEnd = buffer.indexOf('\r\n');
      while (!inData && lineEnd !== -1) {
        const verb = buffer.slice(0, 4).toUpperCase();
        buffer = buffer.slice(lineEnd + 2);
        if (verb === 'EHLO') socket.write('250-sink\r\n250 AUTH PLAIN\r\n');
        else if (verb === 'AUTH') socket.write('235 OK\r\n');
        else if (verb === 'DATA') { inData = true; socket.write('354 go on\r\n'); }
        else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
        lineEnd = buffer.indexOf('\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    message,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

// The HTML part of a single-part quoted-printable message.
function htmlOf(data: string) {
  const body = data.slice(data.indexOf('\r\n\r\n') + 4);
  return body
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

describe('mailer under the server runtime', () => {
  it('renders the password reset template and sends it', async () => {
    const sink = await startSmtpSink();
    try {
      const script = `
        const { sendEmail } = await import('./src/lib/email/mailer.ts');
        const sent = await sendEmail('jane@example.com', 'password-reset', {
          expiryTime: '1 hour',
          name: 'Jane',
          organizations: [{ name: 'Acme', resetUrl: 'https://console.example.com/reset-password?token=for-acme' }],
        });
        process.exit(sent ? 0 : 1);
      `;
      await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          SMTP_HOST: '127.0.0.1',
          SMTP_PORT: String(sink.port),
          SMTP_USER: 'mailer',
          SMTP_PASS: 'not-a-real-secret',
          SMTP_FROM: 'console@example.com',
        },
        timeout: 60_000,
      });

      const { document } = new JSDOM(htmlOf(await sink.message)).window;
      expect([...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
        'https://console.example.com/reset-password?token=for-acme',
      ]);
      expect(document.body.textContent).toContain('Acme');
    } finally {
      sink.close();
    }
  }, 90_000);
});
