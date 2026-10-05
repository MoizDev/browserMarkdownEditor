// The vault locator: what the terminal's working directory is built on.
//
// Everything here runs against a real temporary tree, because the thing being
// tested IS the filesystem walk — a mocked `readdir` would prove nothing about
// symlinks, permissions or depth.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isVaultRoot, locateVault, rememberVaultPath, searchForVault, terminalCwdFor } from '../src/vaultPath.ts';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

function tree(): string {
    return mkdtempSync(join(tmpdir(), 'vaultpath-'));
}

/** A vault: a folder with the editor's marker at its root. */
function makeVault(root: string, id: string): string {
    mkdirSync(join(root, '.VaultAgent'), { recursive: true });
    writeFileSync(join(root, '.VaultAgent', 'vault.json'), JSON.stringify({ id }));
    return root;
}

describe('isVaultRoot', () => {
    test('is the marker and the id, not the folder name', () => {
        const home = tree();
        try {
            const vault = makeVault(join(home, 'Notes'), ID);
            expect(isVaultRoot(vault, ID)).toBe(true);
            expect(isVaultRoot(vault, OTHER)).toBe(false);
            // A folder called the same thing, with no marker, is not it.
            mkdirSync(join(home, 'Decoy'), { recursive: true });
            expect(isVaultRoot(join(home, 'Decoy'), ID)).toBe(false);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('a corrupt marker is not a match, and does not throw', () => {
        const home = tree();
        try {
            const vault = join(home, 'Notes');
            mkdirSync(join(vault, '.VaultAgent'), { recursive: true });
            writeFileSync(join(vault, '.VaultAgent', 'vault.json'), '{ not json');
            expect(isVaultRoot(vault, ID)).toBe(false);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('searchForVault', () => {
    test('finds a vault a few folders down', () => {
        const home = tree();
        try {
            const vault = makeVault(join(home, 'Documents', 'school', 'CS145 notes'), ID);
            expect(searchForVault(home, ID)).toBe(vault);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('skips hidden folders, node_modules and Library', () => {
        const home = tree();
        try {
            makeVault(join(home, 'Library', 'Hidden'), ID);
            makeVault(join(home, '.config', 'Hidden'), ID);
            makeVault(join(home, 'project', 'node_modules', 'pkg'), ID);
            expect(searchForVault(home, ID)).toBeNull();
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('does not follow symlinks out of the tree', () => {
        const home = tree();
        const elsewhere = tree();
        try {
            makeVault(join(elsewhere, 'Vault'), ID);
            symlinkSync(elsewhere, join(home, 'link'));
            expect(searchForVault(home, ID)).toBeNull();
        } finally {
            rmSync(home, { recursive: true, force: true });
            rmSync(elsewhere, { recursive: true, force: true });
        }
    });

    test('stops at the depth limit and at the budget', () => {
        const home = tree();
        try {
            makeVault(join(home, 'a', 'b', 'c', 'd', 'e', 'f', 'g'), ID);
            expect(searchForVault(home, ID, { maxDepth: 3 })).toBeNull();
            // A clock that has already run out: nothing is walked.
            expect(searchForVault(home, ID, { now: () => 1e9 })).toBeNull();
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('is breadth-first: a shallow vault wins over a deep one', () => {
        const home = tree();
        try {
            const shallow = makeVault(join(home, 'Notes'), ID);
            makeVault(join(home, 'Archive', 'old', 'deeper', 'Notes'), ID);
            expect(searchForVault(home, ID)).toBe(shallow);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('locateVault and the cache', () => {
    test('remembers the answer, and forgets one that stopped being true', () => {
        const home = tree();
        try {
            const vault = makeVault(join(home, 'Notes'), ID);
            expect(locateVault(ID, home)).toBe(vault);
            // The cached path is re-checked: strip the marker and it is not used.
            rmSync(join(vault, '.VaultAgent'), { recursive: true, force: true });
            expect(locateVault(ID, home)).toBeNull();
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('a path the user typed is accepted only for the right vault', () => {
        const home = tree();
        try {
            const vault = makeVault(join(home, 'Elsewhere', 'Vault'), ID);
            expect(rememberVaultPath(OTHER, vault, home)).toBeNull();
            expect(rememberVaultPath(ID, vault, home)).toBe(vault);
            expect(rememberVaultPath(ID, join(home, 'nope'), home)).toBeNull();
            expect(locateVault(ID, home)).toBe(vault);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('a bad vault id is never a path', () => {
        expect(locateVault('../etc', '/tmp')).toBeNull();
        expect(locateVault(undefined, '/tmp')).toBeNull();
    });
});

describe('terminalCwdFor', () => {
    test('is the folder of the file the editor named', () => {
        const home = tree();
        try {
            const vault = makeVault(join(home, 'Notes'), ID);
            mkdirSync(join(vault, 'CS145', 'a3'), { recursive: true });
            expect(terminalCwdFor(ID, 'CS145/a3', home)).toBe(join(vault, 'CS145', 'a3'));
            expect(terminalCwdFor(ID, '', home)).toBe(vault);
            expect(terminalCwdFor(ID, '.', home)).toBe(vault);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('falls back to the vault root, never outside it', () => {
        const home = tree();
        try {
            const vault = makeVault(join(home, 'Notes'), ID);
            // A folder that has been deleted since the editor last looked.
            expect(terminalCwdFor(ID, 'gone/missing', home)).toBe(vault);
            // Escapes, in every spelling.
            expect(terminalCwdFor(ID, '../..', home)).toBe(vault);
            expect(terminalCwdFor(ID, 'CS145/../../..', home)).toBe(vault);
            expect(terminalCwdFor(ID, '/etc', home)).toBe(vault);
            expect(terminalCwdFor(ID, 'a\0b', home)).toBe(vault);
            // A FILE is not a working directory.
            writeFileSync(join(vault, 'note.md'), '# hi');
            expect(terminalCwdFor(ID, 'note.md', home)).toBe(vault);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('an unfindable vault is null, which the caller reads as "home"', () => {
        const home = tree();
        try {
            expect(terminalCwdFor(ID, 'CS145', home)).toBeNull();
            expect(terminalCwdFor('not-a-uuid', 'CS145', home)).toBeNull();
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
