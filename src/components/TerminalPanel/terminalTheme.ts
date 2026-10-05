// The terminal's colours, from the app's own theme.
//
// Background, foreground, cursor and selection are CSS variables, resolved to
// concrete `rgb()` through a probe element: xterm paints on a canvas and a
// `var()` means nothing there. The 16 ANSI colours are the editor's code
// palette (One Dark Darker / One Light, `editor/codePalette.ts`), so `ls`,
// `git diff` and a Racket file in a note are one colour scheme.
//
// Re-derived on any change to <html>'s `data-theme` or `style` (a custom accent
// is an inline override there). A `[theme]` effect would read STALE values:
// App's theme effect runs after its children's, so the attribute has not moved
// yet when a child's effect for the same render runs. A MutationObserver fires
// once it has.

import type { ITheme } from '@xterm/xterm';
import { CODE_DARK, CODE_LIGHT } from '../../editor/codePalette';

// ANSI black has to stay visible on the dark page: a step lighter than it.
const DARK = { ...CODE_DARK, black: '#3e4451' };
const LIGHT = { ...CODE_LIGHT, black: '#383a42' };

/** `#rrggbb` mixed toward `toward` by `amount` (0–1). */
function mix(hex: string, toward: string, amount: number): string {
    const a = parseInt(hex.slice(1), 16);
    const b = parseInt(toward.slice(1), 16);
    const channel = (shift: number) => {
        const from = (a >> shift) & 255;
        const to = (b >> shift) & 255;
        return Math.round(from + (to - from) * amount);
    };
    return `#${((1 << 24) | (channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).slice(1)}`;
}

function ansi(light: boolean): Partial<ITheme> {
    const p = light ? LIGHT : DARK;
    // Bright = the same hue, pushed away from the page: lighter on dark,
    // deeper on light, so bold/bright text stands out the way it does
    // in the user's own terminal.
    const bright = (c: string) => mix(c, light ? '#000000' : '#ffffff', light ? 0.14 : 0.18);
    return {
        black: p.black, red: p.variable, green: p.string, yellow: p.type,
        blue: p.func, magenta: p.keyword, cyan: p.operator,
        // ANSI white is "a light grey", not the foreground: prompts use it for
        // dim text, and on the light page it must still be readable — so a mid
        // grey there (~4.9:1 on white; One Light's #a0a1a7 measured ~2.6:1, and
        // its bright white near-invisible), as VS Code's light themes do too.
        white: light ? '#6f7179' : p.base,
        brightBlack: light ? '#696c77' : p.comment,
        brightRed: bright(p.variable), brightGreen: bright(p.string), brightYellow: bright(p.type),
        brightBlue: bright(p.func), brightMagenta: bright(p.keyword), brightCyan: bright(p.operator),
        brightWhite: light ? '#a0a1a7' : '#ffffff',
    };
}

let probe: HTMLElement | null = null;
let canvas: CanvasRenderingContext2D | null = null;

function resolve(expr: string): string {
    if (!probe) {
        probe = document.createElement('div');
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none;';
        // A child of <html>, not of any panel: the custom accent is an inline
        // override on <html> and only its descendants inherit it.
        document.documentElement.appendChild(probe);
    }
    probe.style.color = '';
    probe.style.color = expr;
    return getComputedStyle(probe).color;
}

/** A computed colour as [r, g, b], whatever syntax the engine serialized it in. */
function channels(color: string): [number, number, number] {
    const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(color);
    if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
    // `color(srgb …)`, `oklch(…)`: let the canvas convert it.
    canvas ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!canvas) return [128, 128, 128];
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = color;
    canvas.fillRect(0, 0, 1, 1);
    const d = canvas.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
}

export function isLightTheme(): boolean {
    return document.documentElement.getAttribute('data-theme') === 'light';
}

export function deriveTheme(): ITheme {
    const light = isLightTheme();
    const background = resolve('var(--background-primary)');
    const foreground = resolve('var(--text-normal)');
    const accent = resolve('var(--interactive-accent)');
    const [r, g, b] = channels(accent);
    const [fr, fg, fb] = channels(resolve('var(--text-faint)'));
    return {
        background,
        foreground,
        cursor: accent,
        cursorAccent: background,
        selectionBackground: `rgba(${r}, ${g}, ${b}, 0.3)`,
        // Unfocused: the same selection, quieter, so two terminals side by side
        // do not both shout.
        selectionInactiveBackground: `rgba(${r}, ${g}, ${b}, 0.16)`,
        scrollbarSliderBackground: `rgba(${fr}, ${fg}, ${fb}, 0.3)`,
        scrollbarSliderHoverBackground: `rgba(${fr}, ${fg}, ${fb}, 0.5)`,
        scrollbarSliderActiveBackground: `rgba(${fr}, ${fg}, ${fb}, 0.7)`,
        ...ansi(light),
    };
}

/** Calls `onChange` with a fresh theme whenever the app's theme or an accent
 *  override changes. Returns the unsubscribe. */
export function watchTheme(onChange: (theme: ITheme) => void): () => void {
    let frame = 0;
    const observer = new MutationObserver(() => {
        // Several attributes move in one burst (the theme, then the accent
        // that goes with it); one derivation per frame.
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            onChange(deriveTheme());
        });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => {
        observer.disconnect();
        if (frame) cancelAnimationFrame(frame);
    };
}
