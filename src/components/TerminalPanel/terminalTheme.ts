import type { ITheme } from '@xterm/xterm';
import { CODE_DARK, CODE_LIGHT } from '../../editor/codePalette';

const DARK = { ...CODE_DARK, black: '#3e4451' };
const LIGHT = { ...CODE_LIGHT, black: '#383a42' };

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
    const bright = (c: string) => mix(c, light ? '#000000' : '#ffffff', light ? 0.14 : 0.18);
    return {
        black: p.black, red: p.variable, green: p.string, yellow: p.type,
        blue: p.func, magenta: p.keyword, cyan: p.operator,
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
        document.documentElement.appendChild(probe);
    }
    probe.style.color = '';
    probe.style.color = expr;
    return getComputedStyle(probe).color;
}

function channels(color: string): [number, number, number] {
    const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(color);
    if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
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
        selectionInactiveBackground: `rgba(${r}, ${g}, ${b}, 0.16)`,
        scrollbarSliderBackground: `rgba(${fr}, ${fg}, ${fb}, 0.3)`,
        scrollbarSliderHoverBackground: `rgba(${fr}, ${fg}, ${fb}, 0.5)`,
        scrollbarSliderActiveBackground: `rgba(${fr}, ${fg}, ${fb}, 0.7)`,
        ...ansi(light),
    };
}

export function watchTheme(onChange: (theme: ITheme) => void): () => void {
    let frame = 0;
    const observer = new MutationObserver(() => {
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
