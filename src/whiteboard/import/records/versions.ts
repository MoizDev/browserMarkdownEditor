import { KNOWN_SEQUENCES, object, type LegacyObject } from './envelope';
import type { LegacyShape } from './common';

// Older tldraw generations wrote the same shapes with fewer or differently named props. Where the mapping is plain
// (a prop added later with a fixed default, plain text before rich text), the shape is brought to the current layout
// here, before the strict readers; anything else stays as written and the reader refuses that ONE shape.
// The record as written is always preserved beside the converted node when anything was filled in (read.ts).

export type VersionCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** A record family newer than the newest this reader knows cannot be mapped with confidence: its records are left
 * out (and preserved), never guessed at. */
export function checkVersion(versions: ReadonlyMap<string, number>, family: string): VersionCheck {
    const declared = versions.get(family), known = KNOWN_SEQUENCES[family];
    if (declared === undefined || known === undefined || declared <= known) return { ok: true };
    return { ok: false, reason: `Made by a newer tldraw (${family} version ${declared}, this app reads up to ${known})` };
}

/** Plain text as the rich text document every current reader takes: one paragraph per line. */
function plainToRich(text: string): LegacyObject {
    return { type: 'doc', content: text.split('\n').map(line => line
        ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }) };
}

/** Returns the props in the current layout, and whether anything had to be filled in or renamed. */
export function upgradeShapeProps(shape: LegacyShape): { readonly props: LegacyObject; readonly upgraded: boolean } {
    const props: Record<string, unknown> = { ...shape.props };
    let upgraded = false;
    const fill = (key: string, value: unknown) => { if (props[key] === undefined) { props[key] = value; upgraded = true; } };
    const textToRich = () => {
        if (props.richText === undefined && typeof props.text === 'string') {
            props.richText = plainToRich(props.text); delete props.text; upgraded = true;
        }
    };
    switch (shape.type) {
        case 'geo':
            textToRich();
            fill('scale', 1); fill('labelColor', 'black'); fill('url', ''); fill('verticalAlign', 'middle');
            fill('growY', 0);
            break;
        case 'note':
            textToRich();
            fill('scale', 1); fill('labelColor', 'black'); fill('url', ''); fill('verticalAlign', 'middle');
            fill('growY', 0); fill('fontSizeAdjustment', 0);
            break;
        case 'text':
            textToRich();
            // `align` became `textAlign` (tldraw AddTextAlign); the values kept their names.
            if (props.textAlign === undefined && typeof props.align === 'string') {
                props.textAlign = props.align === 'start' || props.align === 'end' ? props.align : 'middle';
                delete props.align; upgraded = true;
            }
            fill('scale', 1); fill('autoSize', true);
            break;
        case 'arrow': {
            textToRich();
            fill('scale', 1); fill('labelColor', 'black'); fill('labelPosition', 0.5); fill('kind', 'arc');
            fill('elbowMidPoint', 0.5);
            // Before bindings were their own records (tldraw ExtractBindings) a terminal was {type:'point', x, y} or a
            // binding to a shape. A point terminal is a plain end; a bound one stays as written and the reader refuses it.
            for (const end of ['start', 'end'] as const) {
                const terminal = object(props[end]);
                if (terminal?.type === 'point' && typeof terminal.x === 'number' && typeof terminal.y === 'number') {
                    props[end] = { x: terminal.x, y: terminal.y }; upgraded = true;
                }
            }
            break;
        }
        case 'line': fill('scale', 1); break;
        default: break;
    }
    return { props, upgraded };
}
