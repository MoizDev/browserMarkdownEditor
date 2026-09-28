import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_MIRROR_FILE_BYTES, MAX_MIRROR_TOTAL_BYTES } from '../../shared/vaultAgentProtocol.ts';
import { checkMirrorPath, syncMirror } from '../src/mirror.ts';
import { BadRequest } from '../src/paths.ts';

const VAULT = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
let root: string;
let outside: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bme-mirror-'));
    outside = mkdtempSync(join(tmpdir(), 'bme-outside-'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

function listAll(dir: string, prefix = ''): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? listAll(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
}

describe('whitelist', () => {
    test('accepts the instruction files and skills', () => {
        for (const p of ['CLAUDE.md', 'AGENTS.md', '.claude/skills/x/SKILL.md', '.agents/skills/x/ref/a.md', '.claude/skills/x/settings.json']) {
            expect(() => checkMirrorPath(p)).not.toThrow();
        }
    });

    test('refuses every CLI config and anything else', () => {
        for (const p of [
            'opencode.json', 'opencode.jsonc', '.opencode/plugin/x.ts', '.claude/settings.json', '.claude/settings.local.json',
            '.mcp.json', '.codex/config.toml', '.claude/agents/x.md', '.claude/commands/x.md', '.claude/skills',
            'Notes/a.md', 'claude.md', '.Claude/skills/x/SKILL.md', '.claude/skills/x/.opencode/y', '.agents/skills/x/opencode.json',
            '../CLAUDE.md', '.claude/skills/../../x', '.claude/skills/./x/y', '/etc/passwd', 'C:/x', '.claude\\skills\\x\\y',
            '.claude/skills/x/SKILL.md.', '.claude/skills/x/a:b', '.claude//skills/x/y', '', 'CLAUDE.md\0',
        ]) {
            expect(() => checkMirrorPath(p)).toThrow(BadRequest);
        }
    });
});

describe('syncMirror', () => {
    test('writes into <root>/<vaultId>/ and tracks what it wrote', () => {
        const r = syncMirror(root, VAULT, [
            { path: 'CLAUDE.md', text: '# hi' },
            { path: '.claude/skills/a/SKILL.md', text: 'skill' },
        ]);
        expect(r).toEqual({ written: 2, removed: 0 });
        const dir = join(root, VAULT);
        expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# hi');
        expect(listAll(dir).sort()).toEqual(['.bme/mirror.json', '.claude/skills/a/SKILL.md', 'CLAUDE.md']);
    });

    test('unchanged files are not rewritten; stale ones it wrote are removed, with empty folders', () => {
        syncMirror(root, VAULT, [{ path: 'CLAUDE.md', text: 'a' }, { path: '.agents/skills/s/SKILL.md', text: 'b' }]);
        const r = syncMirror(root, VAULT, [{ path: 'CLAUDE.md', text: 'a' }]);
        expect(r).toEqual({ written: 0, removed: 1 });
        const dir = join(root, VAULT);
        expect(existsSync(join(dir, '.agents/skills/s'))).toBe(false);
        expect(existsSync(join(dir, '.agents/skills'))).toBe(true); // never climbs above the skill root
    });

    test('never deletes files it did not write (CLI state lives here too)', () => {
        const dir = join(root, VAULT);
        mkdirSync(join(dir, '.claude/skills/user'), { recursive: true });
        writeFileSync(join(dir, '.claude/skills/user/SKILL.md'), 'mine');
        writeFileSync(join(dir, 'notes.txt'), 'mine');
        syncMirror(root, VAULT, [{ path: 'AGENTS.md', text: 'x' }]);
        syncMirror(root, VAULT, []);
        expect(readFileSync(join(dir, '.claude/skills/user/SKILL.md'), 'utf8')).toBe('mine');
        expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('mine');
        expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    });

    test('a tampered manifest cannot make it delete outside the whitelist', () => {
        const dir = join(root, VAULT);
        mkdirSync(join(dir, '.bme'), { recursive: true });
        writeFileSync(join(outside, 'victim'), 'keep');
        writeFileSync(join(dir, 'victim.md'), 'keep');
        writeFileSync(join(dir, '.bme/mirror.json'), JSON.stringify({ files: ['../../victim', join(outside, 'victim'), 'victim.md', '.claude/skills/../../victim.md'] }));
        syncMirror(root, VAULT, []);
        expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('keep');
        expect(readFileSync(join(dir, 'victim.md'), 'utf8')).toBe('keep');
    });

    test('refuses to write through a symlink', () => {
        const dir = join(root, VAULT);
        mkdirSync(dir, { recursive: true });
        symlinkSync(outside, join(dir, '.claude'));
        expect(() => syncMirror(root, VAULT, [{ path: '.claude/skills/x/SKILL.md', text: 'x' }])).toThrow(BadRequest);
        expect(listAll(outside)).toEqual([]);
        symlinkSync(join(outside, 'target.md'), join(dir, 'CLAUDE.md'));
        expect(() => syncMirror(root, VAULT, [{ path: 'CLAUDE.md', text: 'x' }])).toThrow(BadRequest);
        expect(existsSync(join(outside, 'target.md'))).toBe(false);
    });

    test('a bad entry leaves the previous mirror untouched', () => {
        syncMirror(root, VAULT, [{ path: 'CLAUDE.md', text: 'old' }]);
        expect(() => syncMirror(root, VAULT, [{ path: 'CLAUDE.md', text: 'new' }, { path: 'opencode.json', text: '{}' }])).toThrow(BadRequest);
        expect(readFileSync(join(root, VAULT, 'CLAUDE.md'), 'utf8')).toBe('old');
    });

    test('size caps and text only', () => {
        expect(() => syncMirror(root, VAULT, [{ path: 'CLAUDE.md', text: 'x'.repeat(MAX_MIRROR_FILE_BYTES + 1) }])).toThrow(BadRequest);
        const many = Array.from({ length: Math.ceil(MAX_MIRROR_TOTAL_BYTES / MAX_MIRROR_FILE_BYTES) + 1 }, (_, i) => ({ path: `.claude/skills/s${i}/SKILL.md`, text: 'x'.repeat(MAX_MIRROR_FILE_BYTES) }));
        expect(() => syncMirror(root, VAULT, many)).toThrow(BadRequest);
        expect(() => syncMirror(root, VAULT, [{ path: 'CLAUDE.md', text: 'a\0b' }])).toThrow(BadRequest);
        expect(() => syncMirror(root, VAULT, [{ path: 'CLAUDE.md', text: 'a' }, { path: 'CLAUDE.md', text: 'b' }])).toThrow(BadRequest);
    });

    test('vaultId must be a UUID', () => {
        expect(() => syncMirror(root, '../x', [])).toThrow(BadRequest);
        expect(() => syncMirror(root, VAULT, 'nope')).toThrow(BadRequest);
        expect(readdirSync(root)).toEqual([]);
    });
});
