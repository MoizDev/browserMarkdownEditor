import { Decoration, WidgetType } from '@codemirror/view';

/**
 * The span a hidden marker draws — CodeMirror's own widgetless replace (its
 * internal NullWidget), plus a class, so index.css can take the buffers
 * around it out of the text flow.
 *
 * Issue #20: `Decoration.replace({})` with no widget still draws CodeMirror's
 * own zero-width `<img class="cm-widgetBuffer">` on either side (needed so a
 * caret can land beside the hidden range), and an `<img>` is a break
 * opportunity — so a too-wide first word after a hidden `# `/`> `/`- ` could
 * wrap before it, leaving row 1 of the line blank. Giving the hidden range its
 * own class lets index.css take exactly those buffers out of flow, but only
 * that CSS makes it safe: every HIDE is revealed the moment a caret or
 * selection touches it (cursorOnLine/cursorInRange in livePreview.ts), so no
 * caret ever needs to sit beside one of these buffers while it's absolute.
 */
export class HiddenMarkerWidget extends WidgetType {
    override eq(): boolean {
        return true;
    }

    override toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-live-hidden';
        return span;
    }

    // A bare `Decoration.replace({})` has no widget, and the height map counts
    // a widgetless replace as 0 (`deco.widget ? estimatedHeight : 0`); the
    // inherited -1 would count as a whole line height instead.
    override get estimatedHeight(): number {
        return 0;
    }

    override ignoreEvent(): boolean {
        return false;
    }
}

/** One instance backs every hidden marker in the document (see livePreview.ts's
 *  own singleton comment) — sharing lets CodeMirror's decoration diff
 *  short-circuit on identity, and a fresh Decoration per call site would cost
 *  thousands of identical objects per rebuild. */
export const HIDE = Decoration.replace({ widget: new HiddenMarkerWidget() });
