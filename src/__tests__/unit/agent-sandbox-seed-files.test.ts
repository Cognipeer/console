import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IAgentSandboxSeedFile } from '@/lib/database';
import {
    applySeedFiles,
    buildSeedPromptNote,
    defaultSeedPath,
    validateSeedFiles,
    validateSeedPath,
} from '@/lib/services/agents/agentSandboxSeedFiles';

const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const file = (over: Partial<IAgentSandboxSeedFile> = {}): IAgentSandboxSeedFile => ({
    id: 'a',
    name: 'deck.pptx',
    path: '/workspace/templates/deck.pptx',
    fileRef: { bucketKey: 'b', objectKey: 'agent-assets/bot/deck-1.pptx' },
    size: 10,
    ...over,
});

describe('validateSeedPath', () => {
    it('accepts a normal absolute path', () => expect(validateSeedPath('/workspace/templates/a.pptx')).toBeNull());
    it.each([
        ['', 'empty'], ['rel/a', 'relative'], ['/workspace/', 'dir'], ['/a/../b', 'dotdot'],
        ['/a//b', 'double slash'], ['/a/./b', 'dot'], ['/a\0b', 'nul'],
        ['/etc/passwd', 'etc'], ['/usr/bin/x', 'usr'], ['/proc/1', 'proc'], ['/dev/null', 'dev'], ['/lib/x', 'lib'], ['/sys/x', 'sys'], ['/bin/x', 'bin'], ['/sbin/x', 'sbin'],
    ])('rejects %j (%s)', (path) => expect(validateSeedPath(path)).not.toBeNull());
    it('does not confuse /etcetera with /etc', () => expect(validateSeedPath('/etcetera/a')).toBeNull());
    it('suggests a default under /workspace/templates', () => expect(defaultSeedPath('a b.pptx')).toBe('/workspace/templates/a b.pptx'));
});

describe('validateSeedFiles', () => {
    it('flags duplicate paths and foreign object keys', () => {
        const issues = validateSeedFiles([file(), file({ id: 'b' }), file({ id: 'c', path: '/x/y', fileRef: { bucketKey: 'b', objectKey: 'other/k' } })]);
        expect(issues.map((i) => i.field)).toEqual(expect.arrayContaining(['sandbox.seedFiles[1].path', 'sandbox.seedFiles[2].fileRef']));
    });
    it('enforces size limits and count', () => {
        expect(validateSeedFiles([file({ size: 26 * 1024 * 1024 })]).length).toBe(1);
        expect(validateSeedFiles(Array.from({ length: 26 }, (_, i) => file({ id: String(i), path: `/w/${i}` }))).length).toBeGreaterThan(0);
    });
    it('accepts a valid list and undefined', () => {
        expect(validateSeedFiles([file()])).toEqual([]);
        expect(validateSeedFiles(undefined)).toEqual([]);
    });
});

/** Fake sandbox: a map of path -> bytes, driven by the commands the helper issues. */
function fakeRunner(opts: { failMkdirFor?: string } = {}) {
    const fs = new Map<string, Buffer>();
    const modes = new Map<string, string>();
    const commands: string[] = [];
    return {
        fs, modes, commands,
        async exec({ command }: { command: string }) {
            commands.push(command);
            let m: RegExpMatchArray | null;
            if (opts.failMkdirFor && command.startsWith('mkdir') && command.includes(opts.failMkdirFor)) return { exitCode: 1, stderr: 'read-only file system' };
            if ((m = command.match(/^test -f '(.+)' && sha256sum/))) {
                const bytes = fs.get(m[1]!);
                return bytes ? { exitCode: 0, stdout: `${sha256Hex(bytes)}\n` } : { exitCode: 1 };
            }
            if ((m = command.match(/^mkdir -p '.*' && : > '(.+)'$/))) { fs.set(m[1]!, Buffer.alloc(0)); return { exitCode: 0 }; }
            if ((m = command.match(/^printf %s '(.*)' \| base64 -d >> '(.+)'$/))) {
                fs.set(m[2]!, Buffer.concat([fs.get(m[2]!) ?? Buffer.alloc(0), Buffer.from(m[1]!, 'base64')]));
                return { exitCode: 0 };
            }
            if ((m = command.match(/^mv -f '([^']+)' '([^']+)'(?: && chmod (\d+) '[^']+')?$/))) {
                fs.set(m[2]!, fs.get(m[1]!)!); fs.delete(m[1]!);
                if (m[3]) modes.set(m[2]!, m[3]);
                return { exitCode: 0 };
            }
            return { exitCode: 127, stderr: `unexpected ${command}` };
        },
    };
}

describe('applySeedFiles', () => {
    const big = Buffer.from(Array.from({ length: 130_000 }, (_, i) => i % 251)); // 3 chunks, binary
    const store: Record<string, Buffer> = { 'agent-assets/bot/deck-1.pptx': big, 'agent-assets/bot/two': Buffer.from('hi') };
    const read = async (f: IAgentSandboxSeedFile) => {
        const bytes = store[f.fileRef.objectKey];
        if (!bytes) throw new Error('missing object');
        return bytes;
    };

    it('writes binary-safe in chunks, sets mode, then skips unchanged on a second apply', async () => {
        const runner = fakeRunner();
        const files = [file({ sha256: sha256Hex(big), mode: '0755' })];
        const first = await applySeedFiles({ files, agentKey: 'bot', runner, readBytes: read });
        expect(first.written).toEqual(['/workspace/templates/deck.pptx']);
        expect(runner.fs.get('/workspace/templates/deck.pptx')!.equals(big)).toBe(true);
        expect(runner.modes.get('/workspace/templates/deck.pptx')).toBe('0755');
        expect(runner.commands.filter((c) => c.startsWith('printf')).length).toBe(3);
        const before = runner.commands.length;
        const second = await applySeedFiles({ files, agentKey: 'bot', runner, readBytes: read });
        expect(second.skipped).toEqual(['/workspace/templates/deck.pptx']);
        expect(runner.commands.length).toBe(before + 1); // only the checksum probe
    });

    it('rewrites a file whose checksum changed', async () => {
        const runner = fakeRunner();
        runner.fs.set('/workspace/templates/deck.pptx', Buffer.from('old'));
        const res = await applySeedFiles({ files: [file({ sha256: sha256Hex(big) })], agentKey: 'bot', runner, readBytes: read });
        expect(res.written.length).toBe(1);
    });

    it('isolates one failure: others are still written and the failure is reported', async () => {
        const runner = fakeRunner({ failMkdirFor: '/ro/' });
        const warnings: string[] = [];
        const res = await applySeedFiles({
            files: [
                file({ id: '1', path: '/ro/x.bin' }),
                file({ id: '2', path: '/workspace/two', fileRef: { bucketKey: 'b', objectKey: 'agent-assets/bot/two' } }),
                file({ id: '3', path: '/etc/evil' }),
                file({ id: '4', path: '/workspace/gone', fileRef: { bucketKey: 'b', objectKey: 'agent-assets/bot/gone' } }),
                file({ id: '5', path: '/workspace/foreign', fileRef: { bucketKey: 'b', objectKey: 'agent-assets/other/two' } }),
            ],
            agentKey: 'bot', runner, readBytes: read, onWarn: (m) => warnings.push(m),
        });
        expect(res.written).toEqual(['/workspace/two']);
        expect(res.failed.map((f) => f.path)).toEqual(['/ro/x.bin', '/etc/evil', '/workspace/gone', '/workspace/foreign']);
        expect(warnings.length).toBe(4);
    });
});

describe('buildSeedPromptNote', () => {
    it('is empty without files', () => expect(buildSeedPromptNote(undefined)).toBe(''));
    it('lists available files and flags failed ones', () => {
        const a = file(); const b = file({ id: 'b', name: 'x.csv', path: '/workspace/x.csv' });
        const note = buildSeedPromptNote([a, b], [{ path: b.path, name: b.name, reason: 'boom' }]);
        expect(note).toContain('- /workspace/templates/deck.pptx — deck.pptx');
        expect(note).toMatch(/could NOT be written[\s\S]*\/workspace\/x\.csv — x\.csv \(boom\)/);
    });
});
