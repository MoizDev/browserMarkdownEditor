import type { ChangeDesc, Text } from '@codemirror/state';

export interface LineMatch {
    from: number;
    to: number;
    /** The captures are retained because filtered matches still consume their source. */
    groups: readonly string[];
}

export interface LineScans {
    inline: LineMatch[];
    dollars: LineMatch[];
    highlights: LineMatch[];
    wikilinks: LineMatch[];
    mathTokens: number[];
    embedOpeners: number[];
}

interface Window { from: number; to: number }

function lineWindow(doc: Text, from: number, to: number): Window {
    return { from: doc.lineAt(from).from, to: doc.lineAt(to).to };
}

function merge(windows: Window[]): Window[] {
    windows.sort((a, b) => a.from - b.from);
    const result: Window[] = [];
    for (const w of windows) {
        const prev = result[result.length - 1];
        if (prev && w.from <= prev.to + 1) prev.to = Math.max(prev.to, w.to);
        else result.push({ ...w });
    }
    return result;
}

function changedWindows(changes: ChangeDesc, oldDoc: Text, newDoc: Text): [Window[], Window[]] {
    const oldWindows: Window[] = [], newWindows: Window[] = [];
    changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        oldWindows.push(lineWindow(oldDoc, fromA, toA));
        newWindows.push(lineWindow(newDoc, fromB, toB));
    });
    return [merge(oldWindows), merge(newWindows)];
}

function scan(doc: Text, windows: readonly Window[]): LineScans {
    const out: LineScans = { inline: [], dollars: [], highlights: [], wikilinks: [], mathTokens: [], embedOpeners: [] };
    const patterns: [keyof Pick<LineScans, 'inline' | 'dollars' | 'highlights' | 'wikilinks'>, RegExp][] = [
        ['inline', /(?<![\\$])\$(?![\s$])([^$\n]*?[^\s$])\$(?!\$)/g],
        ['dollars', /\$+/g],
        ['highlights', /(?<!=)==(?!=)(.+?)(?<!=)==(?!=)/g],
        ['wikilinks', /(!?)\[\[([^\]\n]+?)\]\]/g],
    ];
    for (const window of windows) {
        let line = doc.lineAt(window.from);
        for (;;) {
            const text = line.text;
            for (const [key, regex] of patterns) {
                regex.lastIndex = 0;
                let match: RegExpExecArray | null;
                while ((match = regex.exec(text))) out[key].push({
                    from: line.from + match.index, to: line.from + match.index + match[0].length,
                    groups: match.slice(1),
                });
            }
            for (let i = 0; i < text.length; i++) {
                if (text[i] === '$' && text[i + 1] === '$' && text[i - 1] !== '\\') out.mathTokens.push(line.from + i);
                if (text.startsWith('![[', i)) out.embedOpeners.push(line.from + i);
            }
            if (line.to >= window.to || line.number === doc.lines) break;
            line = doc.line(line.number + 1);
        }
    }
    return out;
}

export function scanAllLines(doc: Text): LineScans {
    return scan(doc, [{ from: 0, to: doc.length }]);
}

/** Rescan only changed logical lines, mapping retained matches in one pass. */
export function updateLineScans(previous: LineScans, changes: ChangeDesc, oldDoc: Text, newDoc: Text): LineScans {
    if (changes.empty) return previous;
    const [oldWindows, newWindows] = changedWindows(changes, oldDoc, newDoc);
    const fresh = scan(newDoc, newWindows);
    const combine = <T>(left: T[], right: T[], position: (item: T) => number): T[] => {
        const result: T[] = [];
        let i = 0, j = 0;
        while (i < left.length && j < right.length) {
            result.push(position(left[i]) <= position(right[j]) ? left[i++] : right[j++]);
        }
        while (i < left.length) result.push(left[i++]);
        while (j < right.length) result.push(right[j++]);
        return result;
    };
    const mapMatches = (old: LineMatch[], added: LineMatch[]): LineMatch[] => {
        let w = 0;
        const kept: LineMatch[] = [];
        for (const item of old) {
            while (w < oldWindows.length && oldWindows[w].to < item.from) w++;
            if (w < oldWindows.length && oldWindows[w].from <= item.to) continue;
            kept.push({ ...item, from: changes.mapPos(item.from, 1), to: changes.mapPos(item.to, -1) });
        }
        return combine(kept, added, item => item.from);
    };
    const mapTokens = (old: number[], added: number[]): number[] => {
        let w = 0;
        const kept: number[] = [];
        for (const pos of old) {
            while (w < oldWindows.length && oldWindows[w].to < pos) w++;
            if (w < oldWindows.length && oldWindows[w].from <= pos) continue;
            kept.push(changes.mapPos(pos, 1));
        }
        return combine(kept, added, item => item);
    };
    return {
        inline: mapMatches(previous.inline, fresh.inline),
        dollars: mapMatches(previous.dollars, fresh.dollars),
        highlights: mapMatches(previous.highlights, fresh.highlights),
        wikilinks: mapMatches(previous.wikilinks, fresh.wikilinks),
        mathTokens: mapTokens(previous.mathTokens, fresh.mathTokens),
        embedOpeners: mapTokens(previous.embedOpeners, fresh.embedOpeners),
    };
}
