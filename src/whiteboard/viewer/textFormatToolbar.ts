import { sliceRichText, type RichText } from '../text/richText';

export type FormatCommand = 'bold' | 'italic' | 'code' | 'link' | 'bullet-list' | 'highlight';
export type FormatState = Readonly<Record<FormatCommand, boolean>>;

// Lucide node data (ISC, lucide-static 1.43.0), the same family as the board's tool bar; see components/whiteboard/chrome/toolIcons.tsx.
const GLYPHS: Readonly<Record<FormatCommand, readonly (readonly [string, Record<string, string>])[]>> = {
    bold: [['path', { d: 'M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8' }]],
    italic: [['line', { x1: '19', x2: '10', y1: '4', y2: '4' }], ['line', { x1: '14', x2: '5', y1: '20', y2: '20' }],
        ['line', { x1: '15', x2: '9', y1: '4', y2: '20' }]],
    code: [['path', { d: 'm16 18 6-6-6-6' }], ['path', { d: 'm8 6-6 6 6 6' }]],
    link: [['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
        ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]],
    'bullet-list': [['path', { d: 'M3 5h.01' }], ['path', { d: 'M3 12h.01' }], ['path', { d: 'M3 19h.01' }],
        ['path', { d: 'M8 5h13' }], ['path', { d: 'M8 12h13' }], ['path', { d: 'M8 19h13' }]],
    highlight: [['path', { d: 'm9 11-6 6v3h9l3-3' }], ['path', { d: 'm22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4' }]],
};
const LABELS: Readonly<Record<FormatCommand, string>> = {
    bold: 'Bold', italic: 'Italic', code: 'Inline code', link: 'Link', 'bullet-list': 'Bulleted list', highlight: 'Highlight',
};
const ORDER: readonly FormatCommand[] = ['bold', 'italic', 'code', 'link', 'bullet-list', 'highlight'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const ACTIVE = { background: 'var(--board-tool-active, #4a7fe8)', color: 'var(--board-tool-active-fg, #fff)' };

/** The formats a selection carries, read from the text it is in: a format is on only when every character of the selection has
 * it (a block format only when every block the selection touches is that kind). Empty selections carry nothing. */
export function formatStateIn(text: RichText, from: number, to: number): FormatState {
    const slice = sliceRichText(text, from, to, true);
    const runs = slice.blocks.flatMap(block => block.runs.filter(run => run.text.length > 0));
    const every = (test: (marks: RichText['blocks'][number]['runs'][number]['marks']) => boolean) => runs.length > 0 && runs.every(run => test(run.marks));
    return {
        bold: every(marks => !!marks.b), italic: every(marks => !!marks.i), code: every(marks => !!marks.code),
        link: every(marks => typeof marks.link === 'string'), highlight: every(marks => !!marks.hl),
        'bullet-list': slice.blocks.length > 0 && slice.blocks.every(block => block.kind === 'ul'),
    };
}

/** The floating "Text formatting" bar. Pointer-down is kept from the editor so the selection survives a click. */
export function createFormatToolbar(run: (command: FormatCommand) => void): { readonly element: HTMLElement; setState(state: FormatState): void } {
    const bar = document.createElement('div');
    bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Text formatting'); bar.hidden = true;
    bar.style.cssText = 'position:absolute;left:0;top:0;display:flex;gap:2px;padding:4px;z-index:2;pointer-events:auto;'
        + 'background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:8px;'
        + 'box-shadow:0 4px 12px rgba(0,0,0,0.25);white-space:nowrap;transform:translate(-50%,-100%);';
    const buttons = new Map<FormatCommand, HTMLButtonElement>();
    for (const command of ORDER) {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.command = command; button.dataset.tooltip = LABELS[command];
        button.setAttribute('aria-label', LABELS[command]); button.setAttribute('aria-pressed', 'false');
        button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;'
            + 'border-radius:6px;cursor:pointer;background:transparent;color:var(--text-normal);';
        const svg = document.createElementNS(SVG_NS, 'svg');
        for (const [name, attributes] of GLYPHS[command]) {
            const node = document.createElementNS(SVG_NS, name);
            for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
            svg.append(node);
        }
        for (const [key, value] of Object.entries({ width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
            'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
        button.append(svg);
        button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); run(command); });
        buttons.set(command, button); bar.append(button);
    }
    return {
        element: bar,
        setState(state) {
            for (const command of ORDER) {
                const button = buttons.get(command)!, on = state[command];
                button.setAttribute('aria-pressed', String(on));
                button.style.background = on ? ACTIVE.background : 'transparent';
                button.style.color = on ? ACTIVE.color : 'var(--text-normal)';
            }
        },
    };
}
