import type { TerminalFontCandidate } from '../../../shared/vaultAgentProtocol';
import { setDetectedTerminalFont, getTerminalSettings, subscribeTerminalSettings } from '../../utils/terminalSettings';

export const SYMBOLS_FAMILY = 'Symbols Nerd Font Mono';
const PROBE_FAMILY = 'BME Terminal Font';
const OPEN_WAIT_MS = 1500;
const PROBE_MS = 1200;
const DEFAULT_SIZE = 13;

export interface ResolvedFont {
    family: string;
    size: number;
}

let detectedFamily: string | null = null;
let detectedSize: number | null = null;
let detection: Promise<void> | null = null;
let symbols: Promise<void> | null = null;
let monospace: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

export function subscribeFont(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

subscribeTerminalSettings(emit);

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

function familyInstalled(family: string): boolean {
    measureContext ??= document.createElement('canvas').getContext('2d');
    const ctx = measureContext;
    if (!ctx) return false;
    const sample = 'mmmmmmmmmmlli0OxwWAV';
    const width = (font: string) => { ctx.font = `64px ${font}`; return ctx.measureText(sample).width; };
    const q = quote(family);
    return width(`${q}, monospace`) !== width('monospace') || width(`${q}, serif`) !== width('serif');
}

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

function boldName(postscript: string): string {
    return /regular$/i.test(postscript) ? postscript.replace(/regular$/i, 'Bold') : `${postscript}-Bold`;
}

async function apply(candidates: TerminalFontCandidate[]): Promise<boolean> {
    for (const c of candidates) {
        const label = c.family ?? c.postscript;
        if (!label) continue;
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

export function startFontDetection(candidates: () => Promise<TerminalFontCandidate[]>): void {
    if (detection) return;
    detection = (async () => {
        try {
            await apply(await candidates());
        } catch { /* no hint: the fallback stack stands */ }
    })();
}

function loadSymbols(): Promise<void> {
    symbols ??= document.fonts.load(`${DEFAULT_SIZE}px ${quote(SYMBOLS_FAMILY)}`, '\uE700').then(
        () => { emit(); },
        () => { /* the DOM or canvas shows boxes for icons; nothing to retry */ },
    );
    return symbols;
}

export function fontsReady(): Promise<void> {
    return withTimeout(Promise.all([loadSymbols(), detection ?? Promise.resolve()]), OPEN_WAIT_MS).then(() => undefined);
}
