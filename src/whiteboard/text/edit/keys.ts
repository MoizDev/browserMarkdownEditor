import { graphemeBoundaries } from '../graphemes';
import type { EditSelection, TextChange } from './host';

export interface KeyServices {
    text(): string;
    selection(): EditSelection;
    setSelection(selection: EditSelection): void;
    replace(change: TextChange): void;
    // Visual movement is supplied by the caret index built from the renderer's
    // TextPaint, not by a second text layout in the input layer.
    move(offset: number, direction: 'left' | 'right' | 'up' | 'down' | 'line-start' | 'line-end' | 'word-left' | 'word-right'): number;
    command(command: string): void;
    inList(): boolean;
    undoTransformation(): boolean;
}

function adjacentGrapheme(text: string, offset: number, direction: -1 | 1): number {
    const boundaries = graphemeBoundaries(text);
    if (direction < 0) {
        for (let i = boundaries.length - 1; i >= 0; i--) if (boundaries[i] < offset) return boundaries[i];
        return 0;
    }
    for (const boundary of boundaries) if (boundary > offset) return boundary;
    return text.length;
}

function consume(event: KeyboardEvent): void { event.preventDefault(); event.stopPropagation(); }

export function handleEditKey(event: KeyboardEvent, services: KeyServices, mac: boolean): boolean {
    if (event.isComposing) return false;
    const mod = mac ? event.metaKey : event.ctrlKey;
    const word = mac ? event.altKey : event.ctrlKey;
    const { anchor, focus } = services.selection();
    const text = services.text();
    const lower = event.key.toLowerCase();
    if (mod && !event.altKey && lower === 'a') {
        consume(event); services.setSelection({ anchor: 0, focus: text.length }); return true;
    }
    if (mod && !event.altKey && ['b', 'i', 'u', 'e', 'k', 'h', 's', 'z', 'c', 'x', 'v'].includes(lower)) {
        const command = lower === 'b' ? 'bold' : lower === 'i' ? 'italic' : lower === 'u' ? 'underline'
            : lower === 'e' ? 'code' : lower === 'k' ? 'link' : lower === 'h' && event.shiftKey ? 'highlight'
            : lower === 's' && event.shiftKey ? 'strike' : lower === 'z' ? event.shiftKey ? 'redo' : 'undo'
            : lower === 'c' ? 'copy' : lower === 'x' ? 'cut' : lower === 'v' ? event.shiftKey ? 'paste-plain' : 'paste' : null;
        if (command) { consume(event); services.command(command); return true; }
    }
    if (mod && event.altKey && (/^[0-6]$/.test(event.key) || /^Digit[0-6]$/.test(event.code))) {
        const level = /^[0-6]$/.test(event.key) ? event.key : event.code.slice(-1);
        consume(event); services.command(`heading-${level}`); return true;
    }
    if (mod && event.shiftKey && (event.key === '7' || event.key === '8' || event.code === 'Digit7' || event.code === 'Digit8')) {
        consume(event); services.command(event.code === 'Digit7' || event.key === '7' ? 'ordered-list' : 'bullet-list'); return true;
    }
    if (event.key === 'Escape' || (mod && event.key === 'Enter')) {
        consume(event); services.command('finish'); return true;
    }
    if (event.key === 'Tab' && services.inList()) {
        consume(event); services.command(event.shiftKey ? 'outdent' : 'indent'); return true;
    }
    if (event.key === 'Enter') {
        consume(event); services.command('enter'); return true;
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
        if (event.key === 'Backspace' && !mod && !event.altKey && anchor === focus && services.undoTransformation()) { consume(event); return true; }
        const backward = event.key === 'Backspace';
        let from = Math.min(anchor, focus), to = Math.max(anchor, focus);
        if (from === to) {
            const destination = mod && mac && backward ? services.move(focus, 'line-start')
                : word ? services.move(focus, backward ? 'word-left' : 'word-right')
                : adjacentGrapheme(text, focus, backward ? -1 : 1);
            from = Math.min(focus, destination); to = Math.max(focus, destination);
        }
        consume(event);
        if (from !== to) services.replace({ from, to, text: '', selection: { anchor: from, focus: from } });
        return true;
    }
    const movement = event.key === 'ArrowLeft' ? 'left' : event.key === 'ArrowRight' ? 'right'
        : event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down'
        : event.key === 'Home' ? 'line-start' : event.key === 'End' ? 'line-end' : null;
    if (!movement) return false;
    let next: number;
    if ((mod && mac && (movement === 'up' || movement === 'down')) || (!mac && event.ctrlKey && (movement === 'line-start' || movement === 'line-end'))) next = movement === 'up' || movement === 'line-start' ? 0 : text.length;
    else if (mod && mac && (movement === 'left' || movement === 'right')) next = services.move(focus, movement === 'left' ? 'line-start' : 'line-end');
    else if (word && (movement === 'left' || movement === 'right')) next = services.move(focus, movement === 'left' ? 'word-left' : 'word-right');
    else next = services.move(focus, movement);
    consume(event);
    services.setSelection({ anchor: event.shiftKey ? anchor : next, focus: next });
    return true;
}
