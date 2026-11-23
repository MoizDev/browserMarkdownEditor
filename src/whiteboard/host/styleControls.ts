import type { Rgba } from '../../platform/types';
import { BoardLanguageState, translateBoard } from '../chrome/language';
import { stylePanelModel, type StylePanelModel } from '../chrome/stylePanel';
import { clampPenScale } from '../chrome/penWidth';
import { BoardStyleCommands } from '../chrome/styleCommands';
import type { ToolState } from '../input/gesture';
import type { NodeId } from '../model/ids';
import type { Arrowhead, Dash, Fill, FigureShape, Font, HAlign, Size, Swatch, TextAlign, VAlign } from '../model/styles';
import type { PaintPalette } from '../render/colour';
import type { BoardRuntime } from './runtime';
import { figureLabelGrowY } from '../text/edit/growth';

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

export type StyleCommands = ReturnType<typeof createBoardStyleControls>['commands'];

export interface StylePanelSnapshot extends StylePanelModel {
    readonly disabled: boolean;
    /** The active tool: the popover button is unavailable for the tools that draw nothing with a pointer. */
    readonly tool: string;
    readonly translate: (key: string) => string;
}

/** This view store borrows the session, tool and selection; none is recreated by the panel. */
export function createBoardStyleControls(options: BoardStyleControlsOptions) {
    const { runtime, tool, language } = options, session = runtime.session;
    const commands = new BoardStyleCommands(session, () => runtime.selection.getSnapshot().selected, () => tool.getSnapshot().active.id,
        node => figureLabelGrowY(request => runtime.render.text.layout.measure(request), runtime.render.text.fonts.epoch, node));
    const listeners = new Set<() => void>();
    let disposed = false, cached: StylePanelSnapshot | undefined;
    const refresh = () => {
        if (disposed) return;
        cached = undefined;
        for (const listener of [...listeners]) {
            try { listener(); } catch (error) { options.onError(error); }
        }
    };
    const finish = () => { try { commands.end(); } catch (error) { options.onError(error); } };
    const execute = (action: () => void) => {
        if (disposed || !options.currentOwner() || session.isReadOnly) { finish(); return; }
        try { action(); } catch (error) { finish(); options.onError(error); }
    };
    /** A figure tool's shape is its variant, which is the next shape when nothing is selected. */
    const setFigureVariant = (shape: FigureShape) => {
        if (tool.getSnapshot().active.id === 'figure') tool.setTool('figure', shape);
    };
    const hasSelection = () => runtime.selection.getSnapshot().selected.length > 0;
    const styles = {
        sampleStyle: (id: NodeId) => execute(() => commands.sampleStyle(id)),
        setColor: (color: Swatch) => execute(() => commands.setColor(color)),
        setOpacity: (value: number) => execute(() => commands.setOpacity(value)),
        setFill: (fill: Fill) => execute(() => commands.setFill(fill)),
        setDash: (dash: Dash) => execute(() => commands.setDash(dash)),
        setFont: (font: Font) => execute(() => commands.setFont(font)),
        setTextAlignment: (align: TextAlign) => execute(() => commands.setTextAlignment(align)),
        setLabelAlignment: (align: HAlign) => execute(() => commands.setLabelAlignment(align)),
        setVerticalAlignment: (align: VAlign) => execute(() => commands.setVerticalAlignment(align)),
        setShape: (shape: FigureShape) => execute(() => { commands.setShape(shape); if (!hasSelection()) setFigureVariant(shape); }),
        setRoute: (route: 'arc' | 'elbow') => execute(() => commands.setRoute(route)),
        setArrowhead: (end: 'start' | 'end', head: Arrowhead) => execute(() => commands.setArrowhead(end, head)),
        setSpline: (spline: 'line' | 'cubic') => execute(() => commands.setSpline(spline)),
        setSize: (size: Size) => execute(() => commands.setSize(size)),
        /** One undo step until `endGesture`: a slider drag, a held arrow key or a swatch scrub. */
        beginGesture: (label: string) => execute(() => commands.begin(label)),
        endGesture: finish,
        setWidth: (scale: number) => execute(() => { const value = clampPenScale(scale); commands.setWidth(value); options.persistScale(value); }),
    };
    const getSnapshot = (): StylePanelSnapshot => {
        if (!cached) {
            const languageSnapshot = language.getSnapshot();
            const active = tool.getSnapshot().active;
            const model = stylePanelModel(session, commands, runtime.selection.getSnapshot().selected, active.id, active.variant,
                options.palette(), options.panelBackground());
            cached = { ...model, tool: active.id, disabled: session.isReadOnly || !options.currentOwner() || disposed,
                translate: key => translateBoard(languageSnapshot.table, key) };
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
        /** Call before hiding or detaching the panel, including cancellation mid-gesture. */
        finish,
        dispose() {
            if (disposed) return;
            finish(); disposed = true; cached = undefined;
            for (const unsubscribe of subscriptions) unsubscribe();
            listeners.clear();
        },
    };
}
