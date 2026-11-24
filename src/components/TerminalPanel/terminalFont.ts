// Which font the terminal draws with, and making sure it can draw the user's
// prompt (requirement 8: Nerd Font icons must render, never boxes).
//
// The stack, in order of authority:
//   1. Settings → Terminal font, if the user set one (a CSS family list, used as typed);
//   2. the font the user's OWN terminal app is set to — the helper reads Ghostty,
//      iTerm2, kitty, Alacritty, WezTerm, Windows Terminal, Terminal.app and VS Code
//      (`terminal.fontHint`), and the first candidate this browser can actually load
//      wins;
//   3. the editor's monospace.
// then, always, between them and the generic fallback, the bundled
// "Symbols Nerd Font Mono" (terminalFont.css): every icon code point the chosen font
// lacks is drawn from it, and nothing else ever is.
//
// A page cannot list installed fonts without a permission prompt, so each candidate
// is PROBED: a PostScript or full name through `new FontFace(…, 'local("name")').load()`
// (rejects when no such font is installed), a bare family name by measuring text
// against two generic fallbacks. Detection never holds the terminal up past
// OPEN_WAIT_MS: it opens with what it has and swaps when a better answer lands.

import type { TerminalFontCandidate } from '../../../shared/vaultAgentProtocol';
import { setDetectedTerminalFont, getTerminalSettings, subscribeTerminalSettings } from '../../utils/terminalSettings';

export const SYMBOLS_FAMILY = 'Symbols Nerd Font Mono';
/** The family a probed `local()` face is registered under. */
const PROBE_FAMILY = 'BME Terminal Font';
/** How long opening a terminal waits for font detection and the symbols face. */
const OPEN_WAIT_MS = 1500;
/** One candidate's own limit: `local()` on a huge font collection can be slow. */
const PROBE_MS = 1200;
const DEFAULT_SIZE = 13;

export interface ResolvedFont {
    /** A CSS font-family list, ready for xterm's `fontFamily`. */
    family: string;
    size: number;
}

let detectedFamily: string | null = null;
let detectedSize: number | null = null;
/** Null until detection has been asked for; then the promise of its end. */
let detection: Promise<void> | null = null;
let symbols: Promise<void> | null = null;
let monospace: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

/** Called when anything the stack is built from changed: the setting, or a late
 *  detection answer. The store re-applies the font to every terminal. */
export function subscribeFont(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

// A settings change is a font change.
subscribeTerminalSettings(emit);

/** The editor's own monospace stack, read from CSS: a canvas cannot resolve `var()`. */
function monospaceStack(): string {
    if (monospace === null) {
        const value = getComputedStyle(document.documentElement).getPropertyValue('--font-monospace').trim();
        monospace = value || 'Menlo, Consolas, "Courier New", monospace';
        if (!/\bmonospace\b/i.test(monospace)) monospace += ', monospace';
    }
    return monospace;
}

function quote(name: string): string {
    return `"${name.replace(/["\\]/g, '')}"`;
}

export function currentFont(): ResolvedFont {
    const settings = getTerminalSettings();
    const head = settings.fontFamily || detectedFamily || '';
    const family = [head, quote(SYMBOLS_FAMILY), monospaceStack()].filter(Boolean).join(', ');
    return { family, size: settings.fontSize ?? detectedSize ?? DEFAULT_SIZE };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise(resolve => {
        const timer = window.setTimeout(() => resolve(undefined), ms);
        promise.then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(undefined); });
    });
}

let measureContext: CanvasRenderingContext2D | null = null;

/** Whether a family is installed: its text measures differently from BOTH generic
 *  fallbacks (one alone can coincide when the font has the fallback's metrics). */
function familyInstalled(family: string): boolean {
    measureContext ??= document.createElement('canvas').getContext('2d');
    const ctx = measureContext;
    if (!ctx) return false;
    const sample = 'mmmmmmmmmmlli0OxwWAV';
    const width = (font: string) => { ctx.font = `64px ${font}`; return ctx.measureText(sample).width; };
    const q = quote(family);
    return width(`${q}, monospace`) !== width('monospace') || width(`${q}, serif`) !== width('serif');
}

/** Registers an installed font under PROBE_FAMILY by one of its local names. */
async function loadLocal(name: string, weight: 'normal' | 'bold'): Promise<boolean> {
    try {
        const face = new FontFace(PROBE_FAMILY, `local(${quote(name)})`, { weight });
        await face.load();
        document.fonts.add(face);
        return true;
    } catch {
        return false;
    }
}

/** `MesloLGS-NF-Regular` → `MesloLGS-NF-Bold`. */
function boldName(postscript: string): string {
    return /regular$/i.test(postscript) ? postscript.replace(/regular$/i, 'Bold') : `${postscript}-Bold`;
}

/** The first candidate this browser can draw with, applied; false when none. */
async function apply(candidates: TerminalFontCandidate[]): Promise<boolean> {
    for (const c of candidates) {
        const label = c.family ?? c.postscript;
        if (!label) continue;
        // An installed FAMILY is the best answer: the system picks bold and italic itself.
        if (c.family && familyInstalled(c.family)) {
            detectedFamily = quote(c.family);
        } else {
            const names = [c.postscript, c.family, c.family ? `${c.family} Regular` : undefined];
            let found = false;
            for (const name of names) {
                if (name && await withTimeout(loadLocal(name, 'normal'), PROBE_MS)) { found = true; break; }
            }
            if (!found) continue;
            if (c.postscript) void withTimeout(loadLocal(boldName(c.postscript), 'bold'), PROBE_MS);
            detectedFamily = quote(PROBE_FAMILY);
        }
        detectedSize = c.size && c.size >= 6 && c.size <= 72 ? Math.round(c.size) : null;
        setDetectedTerminalFont(label, detectedSize);
        return true;
    }
    return false;
}

/** Starts font detection, once per page. The helper is asked for the candidates;
 *  an old helper, a refused request or no candidate at all just leaves the editor's
 *  monospace plus the bundled icons. */
export function startFontDetection(candidates: () => Promise<TerminalFontCandidate[]>): void {
    if (detection) return;
    detection = (async () => {
        try {
            // apply() reports what it found to the settings store, whose change
            // notification (subscribed above) is what re-applies the font.
            await apply(await candidates());
        } catch { /* no hint: the fallback stack stands */ }
    })();
}

/** The bundled icon font, loaded now: it must be in the document before xterm
 *  measures and rasterizes anything. `unicode-range` makes a load of nothing a
 *  no-op, so a code point inside it is named. */
function loadSymbols(): Promise<void> {
    symbols ??= document.fonts.load(`${DEFAULT_SIZE}px ${quote(SYMBOLS_FAMILY)}`, '\uE700').then(
        () => { emit(); },
        () => { /* the DOM or canvas shows boxes for icons; nothing to retry */ },
    );
    return symbols;
}

/** Resolves when opening a terminal may go ahead: the icon font is loaded and
 *  detection (if it was started) has answered — or OPEN_WAIT_MS passed. */
export function fontsReady(): Promise<void> {
    return withTimeout(Promise.all([loadSymbols(), detection ?? Promise.resolve()]), OPEN_WAIT_MS).then(() => undefined);
}
