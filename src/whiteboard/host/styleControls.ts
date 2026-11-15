import type { Rgba } from '../../platform/types';
import { BoardLanguageState, translateBoard } from '../chrome/language';
import { penPanelView } from '../chrome/penPanel';
import { figureLabelGrowY } from '../text/edit/growth';
import { clampPenScale } from '../chrome/penWidth';
import { BoardStyleCommands } from '../chrome/styleCommands';
import type { ToolState } from '../input/gesture';
import type { NodeId } from '../model/ids';
import type { Dash, Fill, Font, HAlign, Size, Swatch, TextAlign, VAlign } from '../model/styles';
import type { PaintPalette } from '../render/colour';
import type { BoardRuntime } from './runtime';

export interface BoardStyleControlsOptions {
    readonly runtime: BoardRuntime;
    readonly tool: ToolState;
    readonly language: BoardLanguageState;
    palette(): PaintPalette;
    panelBackground(): Rgba;
    subscribeAppearance(listener: () => void): () => void;
    currentOwner(): boolean;
    persistScale(scale: number): void;
    onError(error: unknown): void;
}

/** This view store borrows the session, tool and selection; none is recreated by the panel. */
export function createBoardStyleControls(options: BoardStyleControlsOptions) {
    const { runtime, tool, language } = options, session = runtime.session;
    const commands = new BoardStyleCommands(session, () => runtime.selection.getSnapshot().selected, () => tool.getSnapshot().active.id,
        node => figureLabelGrowY(request => runtime.render.text.layout.measure(request), runtime.render.text.fonts.epoch, node));
    const listeners = new Set<() => void>();
    let disposed = false, cached: ReturnType<typeof penPanelView> | undefined;
    const refresh = () => {
        if (disposed) return;
        cached = undefined;
        for (const listener of [...listeners]) {
            try { listener(); } catch (error) { options.onError(error); }
        }
    };
    const finish = () => { try { commands.endWidth(); } catch (error) { options.onError(error); } };
    const execute = (action: () => void) => {
        if (disposed || !options.currentOwner() || session.isReadOnly) { finish(); return; }
        try { action(); } catch (error) { finish(); options.onError(error); }
    };
    const styles = {
        currentColor: () => commands.currentColor(),
        currentWidthScale: () => commands.currentWidthScale(),
        sampleStyle: (id: NodeId) => execute(() => commands.sampleStyle(id)),
        setColor: (color: Swatch) => execute(() => commands.setColor(color)),
        setFill: (fill: Fill) => execute(() => commands.setFill(fill)),
        setDash: (dash: Dash) => execute(() => commands.setDash(dash)),
        setFont: (font: Font) => execute(() => commands.setFont(font)),
        setAlignment: (align: HAlign, textAlign: TextAlign) => execute(() => commands.setAlignment(align, textAlign)),
        setVerticalAlignment: (align: VAlign) => execute(() => commands.setVerticalAlignment(align)),
        setSize: (size: Size) => execute(() => commands.setSize(size)),
        beginWidth: () => execute(() => commands.beginWidth()),
        setWidth: (scale: number) => execute(() => { const value = clampPenScale(scale); commands.setWidth(value); options.persistScale(value); }),
        endWidth: finish,
    };
    const getSnapshot = (): ReturnType<typeof penPanelView> => {
        if (!cached) {
            const languageSnapshot = language.getSnapshot();
            const view = penPanelView(session, commands, options.palette(), tool.getSnapshot().active.id,
                options.panelBackground(), key => translateBoard(languageSnapshot.table, key), options.persistScale);
            cached = { ...view, disabled: view.disabled || !options.currentOwner() || disposed,
                setColor: id => execute(() => view.setColor(id)),
                beginWidth: () => execute(() => view.beginWidth()),
                changeWidth: position => execute(() => view.changeWidth(position)),
                commitWidth: finish,
                resetWidth: () => execute(() => view.resetWidth()) };
        }
        return cached;
    };
    const subscriptions = [session.subscribe(refresh), runtime.selection.subscribe(refresh), tool.subscribe(refresh),
        language.subscribe(refresh), options.subscribeAppearance(refresh)];
    return {
        commands: styles,
        getSnapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        refresh,
        /** Call before hiding or detaching the panel, including cancellation mid-drag. */
        finish,
        dispose() {
            if (disposed) return;
            finish(); disposed = true; cached = undefined;
            for (const unsubscribe of subscriptions) unsubscribe();
            listeners.clear();
        },
    };
}
