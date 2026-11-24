import { WidgetType } from '@codemirror/view';
import { countEditorWidget } from './editorPerf';

/**
 * A simple horizontal rule widget.
 */
export class HorizontalRuleWidget extends WidgetType {
    constructor() {
        super();
        if (__BME_BENCH__) { countEditorWidget(); }
    }

    eq(): boolean { return true; }

    toDOM(): HTMLElement {
        const el = document.createElement('div');
        el.className = 'cm-hr-widget';
        return el;
    }

    ignoreEvent(): boolean { return false; }
}
