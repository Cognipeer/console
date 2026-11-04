import { describe, it, expect } from 'vitest';
import { ATTACHMENTS_MAX_FILES, attachmentPaths, stageSessionFiles } from '@/lib/services/agents/agentSandboxAttachments';

const file = (id: string, name: string, size = 3, at = 1) => ({ id, name, size, createdAt: new Date(at) });

describe('attachmentPaths', () => {
    it('keeps a name inside the folder and renames a repeated one', () => {
        const paths = attachmentPaths([file('a1', '../etc/passwd'), file('a2', 'x.zip'), file('a3', 'x.zip'), file('a4', '..')]);
        expect(paths.map((p) => p.path)).toEqual([
            '/inputs/.._etc_passwd',
            '/inputs/x.zip',
            '/inputs/a3_x.zip',
            '/inputs/_',
        ]);
    });
});

describe('stageSessionFiles', () => {
    const runner = (stat: (command: string) => { exitCode: number; stdout?: string }) => {
        const commands: string[] = [];
        return { commands, exec: async ({ command }: { command: string }) => { commands.push(command); return command.startsWith('stat') ? stat(command) : { exitCode: 0 }; } };
    };

    it('writes binary bytes through base64 and moves them into place', async () => {
        const r = runner(() => ({ exitCode: 1 }));
        const bytes = Buffer.from([0, 255, 1, 2]);
        const out = await stageSessionFiles({ files: [file('a1', 'p.zip', 4)], runner: r, readBytes: async () => bytes });
        expect(out.written).toEqual(['/inputs/p.zip']);
        expect(r.commands.some((c) => c.includes(bytes.toString('base64')))).toBe(true);
        expect(r.commands.at(-1)).toContain("mv -f '/inputs/p.zip.seed-tmp' '/inputs/p.zip'");
    });

    it('skips a file already there with the same size', async () => {
        const out = await stageSessionFiles({ files: [file('a1', 'p.zip', 4)], runner: runner(() => ({ exitCode: 0, stdout: '4\n' })), readBytes: async () => { throw new Error('should not read'); } });
        expect(out.skipped).toEqual(['/inputs/p.zip']);
    });

    it('reports a failing or oversized file and goes on with the rest', async () => {
        const out = await stageSessionFiles({
            files: [file('a1', 'bad.zip', 3, 1), file('a2', 'huge.zip', 26 * 1024 * 1024, 2), file('a3', 'ok.zip', 3, 3)],
            runner: runner(() => ({ exitCode: 1 })),
            readBytes: async (f) => { if (f.id === 'a1') throw new Error('gone'); return Buffer.from('abc'); },
        });
        expect(out.failed.map((f) => [f.name, f.reason])).toEqual([['bad.zip', 'gone'], ['huge.zip', 'larger than 25 MB']]);
        expect(out.written).toEqual(['/inputs/ok.zip']);
    });

    it('keeps only the newest files when there are more than the limit', async () => {
        const files = Array.from({ length: ATTACHMENTS_MAX_FILES + 2 }, (_, i) => file(`i${i}`, `f${i}.txt`, 1, i));
        const out = await stageSessionFiles({ files, runner: runner(() => ({ exitCode: 1 })), readBytes: async () => Buffer.from('x') });
        expect(out.written).toHaveLength(ATTACHMENTS_MAX_FILES);
        expect(out.written).not.toContain('/inputs/f0.txt');
        expect(out.written).toContain(`/inputs/f${ATTACHMENTS_MAX_FILES + 1}.txt`);
    });
});
