// The fonts the user's own terminal apps are set to, so the in-app terminal can
// draw their prompt's icons (a Nerd Font) the way their terminal does. The
// browser takes the first candidate that is actually installed (CSS `local()`).
//
// Everything is best effort and read-only: a missing, unreadable or unparsable
// config is skipped silently, every read and command has a 2 s timeout, and what
// is read is never logged — a config can hold anything. The parsers are pure
// (text in, candidates out), so they are tested against fixtures.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalFontCandidate } from '../../../shared/vaultAgentProtocol.ts';
import { runCapture } from '../proc.ts';

const READ_TIMEOUT_MS = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 16;

type Candidate = TerminalFontCandidate;

/* ───────────────────────── small format readers ───────────────────────── */

/** A font name that is safe to hand to the page's CSS: no quotes, escapes, braces or controls. */
function cleanName(raw: string | undefined): string | undefined {
    const s = raw?.trim();
    // eslint-disable-next-line no-control-regex
    if (!s || s.length > 120 || /["'\\;{}<>`\u0000-\u001f\u007f]/.test(s)) return undefined;
    return s;
}

function cleanSize(raw: number | string | undefined): number | undefined {
    const n = typeof raw === 'string' ? parseFloat(raw) : raw;
    return n !== undefined && Number.isFinite(n) && n >= 4 && n <= 96 ? n : undefined;
}

function make(source: string, parts: { family?: string; postscript?: string; size?: number | string }): Candidate | null {
    const family = cleanName(parts.family);
    const postscript = cleanName(parts.postscript);
    if (!family && !postscript) return null;
    const size = cleanSize(parts.size);
    return { source, ...(family ? { family } : {}), ...(postscript ? { postscript } : {}), ...(size ? { size } : {}) };
}

/** CSS generic and meta families name no installed font. */
const GENERIC = new Set(['monospace', 'sans-serif', 'serif', 'cursive', 'fantasy', 'system-ui', 'ui-monospace', 'ui-sans-serif', 'auto', 'default']);

function realFamily(name: string | undefined): string | undefined {
    return name && !GENERIC.has(name.trim().toLowerCase()) ? name : undefined;
}

/** JSON with comments and trailing commas (Windows Terminal, VS Code). Null when it is not that. */
export function parseJsonc(text: string): unknown {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 2;
        } else {
            out += c;
            i++;
        }
    }
    try {
        return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
}

export class PlistData {
    constructor(readonly base64: string) {}
}
export type PlistValue = string | number | boolean | PlistData | PlistValue[] | { [key: string]: PlistValue };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (s: string) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === '#') {
            const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });

/** The XML property-list format (`defaults export … -`, `plutil -convert xml1`). Null when it is not one. */
export function parsePlist(xml: string): PlistValue | null {
    const token = /<(\/?)([A-Za-z]+)\s*(\/?)>|<[?!][^>]*>|([^<]+)/g;
    const next = (): { close: boolean; tag: string; self: boolean } | { text: string } | null => {
        for (let m = token.exec(xml); m; m = token.exec(xml)) {
            if (m[4] !== undefined) {
                if (m[4].trim()) return { text: m[4] };
                continue;
            }
            if (m[2]) return { close: m[1] === '/', tag: m[2], self: m[3] === '/' };
        }
        return null;
    };
    const text = (): string => {
        const t = next();
        if (!t) return '';
        if ('text' in t) {
            next(); // the closing tag
            return decodeEntities(t.text);
        }
        return ''; // an empty element: `<string></string>`
    };
    const value = (t: { close: boolean; tag: string; self: boolean }, depth: number): PlistValue | null => {
        if (depth > 40 || t.close) return null;
        switch (t.tag) {
            case 'true': return true;
            case 'false': return false;
            case 'string': return t.self ? '' : text();
            case 'date': return t.self ? '' : text();
            case 'data': return t.self ? new PlistData('') : new PlistData(text().replace(/\s+/g, ''));
            case 'integer':
            case 'real': {
                const n = Number(t.self ? NaN : text());
                return Number.isNaN(n) ? null : n;
            }
            case 'array': {
                const out: PlistValue[] = [];
                if (t.self) return out;
                for (let n = next(); n; n = next()) {
                    if ('text' in n) continue;
                    if (n.close) break;
                    const v = value(n, depth + 1);
                    if (v === null) return null;
                    out.push(v);
                }
                return out;
            }
            case 'dict': {
                const out: { [key: string]: PlistValue } = {};
                if (t.self) return out;
                let key: string | null = null;
                for (let n = next(); n; n = next()) {
                    if ('text' in n) continue;
                    if (n.close) break;
                    if (n.tag === 'key') {
                        key = n.self ? '' : text();
                        continue;
                    }
                    const v = value(n, depth + 1);
                    if (v === null || key === null) return null;
                    out[key] = v;
                    key = null;
                }
                return out;
            }
            default: return null;
        }
    };
    for (let t = next(); t; t = next()) {
        if ('text' in t || t.close) continue;
        if (t.tag === 'plist') continue;
        return value(t, 0);
    }
    return null;
}

const isDict = (v: PlistValue | null | undefined): v is { [key: string]: PlistValue } =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PlistData);

/** Splits `Name 13` / `MesloLGS-NF-Regular 12.5` into the name and the trailing size. */
function nameAndSize(s: string): { name: string; size?: number } {
    const m = /^(.*\S)\s+(\d+(?:\.\d+)?)$/.exec(s.trim());
    return m ? { name: m[1], size: parseFloat(m[2]) } : { name: s.trim() };
}

/* ───────────────────────── per-app parsers ───────────────────────── */

/** `~/.config/ghostty/config`: `font-family = "X"` repeats for fallbacks; an empty value clears the list. */
export function parseGhostty(text: string): Candidate[] {
    const families: string[] = [];
    let size: string | undefined;
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(font-family|font-size)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const v = m[2].replace(/^"(.*)"$/, '$1').trim();
        if (m[1] === 'font-size') size = v;
        else if (!v) families.length = 0;
        else families.push(v);
    }
    return families.map(f => make('ghostty', { family: f, size })).filter((c): c is Candidate => !!c);
}

/** iTerm2 (`defaults export com.googlecode.iterm2 -`): the default profile's `Normal Font`, "PostScriptName size". */
export function parseIterm2(plist: string): Candidate[] {
    const root = parsePlist(plist);
    if (!isDict(root)) return [];
    const profiles = root['New Bookmarks'];
    if (!Array.isArray(profiles)) return [];
    const wanted = root['Default Bookmark Guid'];
    const dicts = profiles.filter(isDict);
    const profile = dicts.find(p => p.Guid === wanted) ?? dicts[0];
    const font = profile?.['Normal Font'];
    if (typeof font !== 'string') return [];
    const { name, size } = nameAndSize(font);
    const c = make('iterm2', { postscript: name, size });
    return c ? [c] : [];
}

/** `kitty.conf`: `font_family Name`, or the newer `family="Name" postscript_name="…"` form. */
export function parseKitty(text: string): Candidate[] {
    let family: string | undefined;
    let postscript: string | undefined;
    let size: string | undefined;
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(font_family|font_size)\s+(.*?)\s*$/.exec(line);
        if (!m) continue;
        if (m[1] === 'font_size') {
            size = m[2];
            continue;
        }
        const pairs = [...m[2].matchAll(/(family|postscript_name)=(?:"([^"]*)"|(\S+))/g)];
        if (pairs.length) {
            for (const p of pairs) {
                if (p[1] === 'family') family = p[2] ?? p[3];
                else postscript = p[2] ?? p[3];
            }
        } else {
            family = m[2];
            postscript = undefined;
        }
    }
    const c = make('kitty', { family: realFamily(family), postscript, size });
    return c ? [c] : [];
}

/** `alacritty.toml`: `[font.normal] family = "X"` (or the inline `normal = { family = "X" }`), `[font] size = 12`. */
export function parseAlacritty(text: string): Candidate[] {
    let section = '';
    let family: string | undefined;
    let size: string | undefined;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\s#.*$/, '').trim();
        const head = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(line);
        if (head) {
            section = head[1];
            continue;
        }
        if (section === 'font.normal') {
            const m = /^family\s*=\s*["']([^"']+)["']/.exec(line);
            if (m) family = m[1];
        } else if (section === 'font') {
            const sz = /^size\s*=\s*([\d.]+)/.exec(line);
            if (sz) size = sz[1];
            const inline = /^normal\s*=\s*\{[^}]*family\s*=\s*["']([^"']+)["']/.exec(line);
            if (inline) family = inline[1];
        }
    }
    const c = make('alacritty', { family, size });
    return c ? [c] : [];
}

/** `wezterm.lua`, by pattern (it is a program): `wezterm.font("X")`, `wezterm.font_with_fallback({ "A", "B" })`. */
export function parseWezterm(text: string): Candidate[] {
    const code = text.replace(/--[^\n]*/g, '');
    const size = /font_size\s*=\s*([\d.]+)/.exec(code)?.[1];
    const names: string[] = [];
    const fallback = /wezterm\.font_with_fallback\s*\(\s*\{([^}]*)\}/s.exec(code);
    if (fallback) {
        for (const m of fallback[1].matchAll(/(?:family\s*=\s*)?["']([^"']+)["']/g)) if (m[1] !== 'family') names.push(m[1]);
    } else {
        const single = /wezterm\.font\s*\(?\s*(?:\{\s*family\s*=\s*)?["']([^"']+)["']/.exec(code);
        if (single) names.push(single[1]);
    }
    return names.map(n => make('wezterm', { family: n, size })).filter((c): c is Candidate => !!c);
}

/** Windows Terminal `settings.json`: the default profile's font, then `profiles.defaults`. */
export function parseWindowsTerminal(text: string): Candidate[] {
    const root = parseJsonc(text) as { defaultProfile?: unknown; profiles?: { defaults?: unknown; list?: unknown[] } } | null;
    if (!root || typeof root !== 'object') return [];
    const fontOf = (p: unknown): { face?: string; size?: number } => {
        if (!p || typeof p !== 'object') return {};
        const o = p as { font?: { face?: unknown; size?: unknown }; fontFace?: unknown; fontSize?: unknown };
        const face = o.font?.face ?? o.fontFace;
        const size = o.font?.size ?? o.fontSize;
        return { face: typeof face === 'string' ? face : undefined, size: typeof size === 'number' ? size : undefined };
    };
    const defaults = fontOf(root.profiles?.defaults);
    const def = (root.profiles?.list ?? []).find(p => !!p && typeof p === 'object' && (p as { guid?: unknown }).guid === root.defaultProfile);
    const own = fontOf(def);
    const out: Candidate[] = [];
    for (const f of [own, defaults]) {
        const c = f.face ? make('windows-terminal', { family: f.face, size: f.size ?? defaults.size }) : null;
        if (c) out.push(c);
    }
    return out;
}

/** VS Code `settings.json`: `terminal.integrated.fontFamily` is a CSS list; each real family is a candidate. */
export function parseVscode(text: string): Candidate[] {
    const root = parseJsonc(text) as Record<string, unknown> | null;
    if (!root || typeof root !== 'object') return [];
    const list = root['terminal.integrated.fontFamily'];
    if (typeof list !== 'string') return [];
    const size = root['terminal.integrated.fontSize'];
    const out: Candidate[] = [];
    for (const part of list.split(',')) {
        const family = realFamily(part.trim().replace(/^(["'])(.*)\1$/, '$2'));
        const c = make('vscode', { family, size: typeof size === 'number' ? size : undefined });
        if (c) out.push(c);
    }
    return out;
}

/** Terminal.app, step 1 (`defaults export com.apple.Terminal -`): the default profile's `Font`, an archived NSFont. */
export function terminalAppFontData(plist: string): string | null {
    const root = parsePlist(plist);
    if (!isDict(root)) return null;
    const settings = root['Window Settings'];
    const wanted = root['Default Window Settings'];
    if (!isDict(settings) || typeof wanted !== 'string') return null;
    const profile = settings[wanted];
    const font = isDict(profile) ? profile.Font : undefined;
    return font instanceof PlistData && font.base64 ? font.base64 : null;
}

/** Terminal.app, step 2 (that archive after `plutil -convert xml1`): its NSFont's `NSName` (a PostScript name) and `NSSize`. */
export function parseTerminalAppFont(archiveXml: string): Candidate[] {
    const root = parsePlist(archiveXml);
    if (!isDict(root) || !Array.isArray(root.$objects)) return [];
    const objects = root.$objects;
    for (const o of objects) {
        if (!isDict(o) || !('NSName' in o) || !('NSSize' in o)) continue;
        const ref = o.NSName;
        const uid = isDict(ref) ? ref['CF$UID'] : undefined;
        const name = typeof uid === 'number' ? objects[uid] : undefined;
        const size = typeof o.NSSize === 'number' ? o.NSSize : undefined;
        const c = typeof name === 'string' ? make('terminal-app', { postscript: name, size }) : null;
        return c ? [c] : [];
    }
    return [];
}

/* ───────────────────────── collecting ───────────────────────── */

export interface FontHintDeps {
    platform: string;
    home: string;
    env: Record<string, string | undefined>;
    /** The file's text, or null if it is missing/unreadable/too big. */
    readText(path: string): Promise<string | null>;
    /** A command's stdout, or null on any failure. */
    run(cmd: string[]): Promise<string | null>;
    /** `plutil -convert xml1` of a binary property list given as base64: XML, or null. */
    decodeArchive(base64: string): Promise<string | null>;
}

export const realFontHintDeps: FontHintDeps = {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    async readText(path) {
        try {
            const file = Bun.file(path);
            if (file.size > MAX_FILE_BYTES) return null;
            return await Promise.race([file.text(), Bun.sleep(READ_TIMEOUT_MS).then(() => null)]);
        } catch {
            return null;
        }
    },
    async run(cmd) {
        const r = await runCapture(cmd, { timeoutMs: READ_TIMEOUT_MS });
        return r.code === 0 && !r.timedOut ? r.stdout : null;
    },
    async decodeArchive(base64) {
        // Through a file: runCapture feeds stdin as UTF-8 text, which would mangle a binary plist.
        const dir = mkdtempSync(join(tmpdir(), 'bme-font-'));
        try {
            const file = join(dir, 'font.plist');
            writeFileSync(file, Buffer.from(base64, 'base64'), { mode: 0o600 });
            const r = await runCapture(['plutil', '-convert', 'xml1', '-o', '-', file], { timeoutMs: READ_TIMEOUT_MS });
            return r.code === 0 && !r.timedOut ? r.stdout : null;
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    },
};

async function firstText(deps: FontHintDeps, paths: string[]): Promise<string | null> {
    for (const p of paths) {
        const t = await deps.readText(p);
        if (t !== null) return t;
    }
    return null;
}

async function terminalApp(deps: FontHintDeps): Promise<Candidate[]> {
    const plist = await deps.run(['defaults', 'export', 'com.apple.Terminal', '-']);
    const data = plist && terminalAppFontData(plist);
    if (!data) return [];
    // The archive is a binary plist: plutil is the one tool that reads it.
    const archive = await deps.decodeArchive(data);
    return archive ? parseTerminalAppFont(archive) : [];
}

/**
 * Candidates, best first. A terminal app's own font wins over VS Code's, and
 * Terminal.app's — everyone has it, whether or not they use it, and its default
 * has no icons — comes last, so a font the user chose for a terminal they do use
 * is tried first.
 */
export async function collectFontHints(deps: FontHintDeps = realFontHintDeps): Promise<TerminalFontCandidate[]> {
    const { home, env, platform } = deps;
    const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const read = async (parse: (t: string) => Candidate[], paths: string[]) => {
        const t = await firstText(deps, paths);
        return t === null ? [] : parse(t);
    };
    const guard = async (job: () => Promise<Candidate[]>): Promise<Candidate[]> => {
        try {
            return await job();
        } catch {
            return [];
        }
    };
    const mac = platform === 'darwin';
    const win = platform === 'win32';
    const vscodeDir = mac ? join(home, 'Library', 'Application Support', 'Code', 'User') : win ? join(appData, 'Code', 'User') : join(xdg, 'Code', 'User');
    const jobs: Array<() => Promise<Candidate[]>> = [
        () => read(parseGhostty, [join(xdg, 'ghostty', 'config'), ...(mac ? [join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty', 'config')] : [])]),
        async () => (mac ? parseIterm2((await deps.run(['defaults', 'export', 'com.googlecode.iterm2', '-'])) ?? '') : []),
        () => read(parseKitty, [join(xdg, 'kitty', 'kitty.conf'), ...(mac ? [join(home, 'Library', 'Preferences', 'kitty', 'kitty.conf')] : [])]),
        () => read(parseAlacritty, [join(xdg, 'alacritty', 'alacritty.toml'), join(home, '.alacritty.toml'), ...(win ? [join(appData, 'alacritty', 'alacritty.toml')] : [])]),
        () => read(parseWezterm, [join(xdg, 'wezterm', 'wezterm.lua'), join(home, '.wezterm.lua')]),
        () => (win ? read(parseWindowsTerminal, [
            join(local, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
            join(local, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
            join(local, 'Microsoft', 'Windows Terminal', 'settings.json'),
        ]) : Promise.resolve([])),
        () => read(parseVscode, [join(vscodeDir, 'settings.json')]),
        () => (mac ? terminalApp(deps) : Promise.resolve([])),
    ];
    const results = await Promise.all(jobs.map(guard));
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const c of results.flat()) {
        const key = (c.postscript ?? c.family ?? '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(c);
        if (out.length >= MAX_CANDIDATES) break;
    }
    return out;
}
