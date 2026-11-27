import { Decoration, WidgetType } from '@codemirror/view';
import { countEditorWidget } from './editorPerf';

export class HiddenMarkerWidget extends WidgetType {
    constructor() {
        super();
        if (__BME_BENCH__) { countEditorWidget(); }
    }

    override eq(): boolean {
        return true;
    }

    override toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-live-hidden';
        return span;
    }

    override get estimatedHeight(): number {
        return 0;
    }

    override ignoreEvent(): boolean {
        return false;
    }
}

export const HIDE = Decoration.replace({ widget: new HiddenMarkerWidget() });
