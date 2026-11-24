import { WidgetType } from '@codemirror/view';

/**
 * A simple horizontal rule widget.
 */
export class HorizontalRuleWidget extends WidgetType {
    eq(): boolean { return true; }

    toDOM(): HTMLElement {
        const el = document.createElement('div');
        el.className = 'cm-hr-widget';
        return el;
    }

    ignoreEvent(): boolean { return false; }
}
