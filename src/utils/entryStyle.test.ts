import { describe, expect, it } from 'bun:test';
import {
    emptyEntryStyles, mergeShard, needsFanOut, parseEntryStyles, serializeEntryStyles,
    shardEntryStyles, withEntryOrder, withEntryStyle, type EntryStyleFile,
} from './entryStyle';

/** The merged view the app works in: a couple of folders deep, with an order. */
function sample(): EntryStyleFile {
    let file = emptyEntryStyles();
    file = withEntryStyle(file, 'Math', { icon: 'sigma', color: 'blue' }, [['path', { d: 'M1' }]]);
    file = withEntryStyle(file, 'Math/Deep', { color: 'amber' });
    file = withEntryStyle(file, 'Math/Deep/inner.md', { icon: 'anchor' }, [['path', { d: 'M2' }]]);
    file = withEntryOrder(file, '', ['Math', 'top.md']);
    file = withEntryOrder(file, 'Math', ['Deep', 'note.md']);
    return file;
}

describe('shardEntryStyles', () => {
    it('gives each folder its own children, by name', () => {
        const shards = shardEntryStyles(sample());
        expect([...shards.keys()].sort()).toEqual(['', 'Math', 'Math/Deep']);
        expect(shards.get('')!.entries).toEqual({ Math: { icon: 'sigma', color: 'blue' } });
        expect(shards.get('Math')!.entries).toEqual({ Deep: { icon: undefined, color: 'amber' } });
        expect(shards.get('Math/Deep')!.entries).toEqual({ 'inner.md': { icon: 'anchor', color: undefined } });
    });

    it('puts a folder’s own order under the empty key, and nobody else’s', () => {
        const shards = shardEntryStyles(sample());
        expect(shards.get('')!.order).toEqual({ '': ['Math', 'top.md'] });
        expect(shards.get('Math')!.order).toEqual({ '': ['Deep', 'note.md'] });
        expect(shards.get('Math/Deep')!.order).toEqual({});
    });

    it('writes each file only the artwork that file still refers to', () => {
        const shards = shardEntryStyles(sample());
        const icons = (folder: string) => Object.keys(JSON.parse(serializeEntryStyles(shards.get(folder)!)).icons);
        // Without this a folder opened as a vault would carry the whole vault's
        // icon set, and every file would grow with every icon ever tried.
        expect(icons('')).toEqual(['sigma']);
        expect(icons('Math')).toEqual([]);
        expect(icons('Math/Deep')).toEqual(['anchor']);
    });

    it('gives a folder with nothing to say no file at all', () => {
        expect(shardEntryStyles(emptyEntryStyles()).size).toBe(0);
    });
});

describe('mergeShard', () => {
    it('is the inverse of the cut: read every file back and the view returns', () => {
        const original = sample();
        let rebuilt = emptyEntryStyles();
        for (const [folder, shard] of shardEntryStyles(original)) {
            rebuilt = mergeShard(rebuilt, folder, parseEntryStyles(serializeEntryStyles(shard)));
        }
        expect(rebuilt.entries).toEqual(original.entries);
        expect({ ...rebuilt.order }).toEqual({ ...original.order });
        expect(Object.keys(rebuilt.icons).sort()).toEqual(['anchor', 'sigma']);
    });

    it('keeps what the store already holds — a file read late must not undo a pick', () => {
        const picked = withEntryStyle(emptyEntryStyles(), 'Math/Deep', { color: 'green' });
        const stale = mergeShard(picked, 'Math', parseEntryStyles(JSON.stringify({
            entries: { Deep: { color: 'red' } },
        })));
        expect(stale.entries['Math/Deep']).toEqual({ icon: undefined, color: 'green' });
    });

    it('reads a pre-shard root file, whose keys are already whole paths', () => {
        const old = parseEntryStyles(JSON.stringify({
            version: 1,
            entries: { Math: { color: 'blue' }, 'Math/Deep/inner.md': { color: 'red' } },
            order: { '': ['Math'], Math: ['Deep'] },
        }));
        const merged = mergeShard(emptyEntryStyles(), '', old);
        expect(merged.entries['Math/Deep/inner.md']).toEqual({ icon: undefined, color: 'red' });
        expect({ ...merged.order }).toEqual({ '': ['Math'], Math: ['Deep'] });
    });

    it('returns the very same view when the file adds nothing', () => {
        const file = sample();
        // Identity matters: FileExplorer re-sorts the whole tree on a new one.
        expect(mergeShard(file, 'Math', emptyEntryStyles())).toBe(file);
    });
});

describe('needsFanOut', () => {
    it('is true for the old layout: one file keyed all the way down', () => {
        expect(needsFanOut(parseEntryStyles(JSON.stringify({
            entries: { 'Math/Deep': { color: 'blue' } },
        })))).toBe(true);
        expect(needsFanOut(parseEntryStyles(JSON.stringify({
            entries: {}, order: { Math: ['Deep'] },
        })))).toBe(true);
    });

    it('is false for a file that is already one folder’s own', () => {
        expect(needsFanOut(parseEntryStyles(JSON.stringify({
            entries: { Math: { color: 'blue' } }, order: { '': ['Math'] },
        })))).toBe(false);
        expect(needsFanOut(emptyEntryStyles())).toBe(false);
    });
});
