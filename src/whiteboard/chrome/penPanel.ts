import type { Rgba } from '../../platform/types';
import { styleGeometryMetrics } from '../geom/styleMetrics';
import { SWATCHES } from '../model/styles';
import { colourCss, resolveSwatch, type PaintPalette } from '../render/colour';
import type { BoardSession } from '../session/BoardSession';
import { penScaleFromSlider, penSliderFromScale } from './penWidth';
import type { BoardStyleCommands } from './styleCommands';

function luminance(color: Rgba): number {
    const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
}

function indicatorOutline(pigment: Rgba, background: Rgba): string {
    const a = luminance(pigment), b = luminance(background);
    const black = Math.min((a + 0.05) / 0.05, (b + 0.05) / 0.05);
    const white = Math.min(1.05 / (a + 0.05), 1.05 / (b + 0.05));
    return black >= white ? '#000' : '#fff';
}

export function penPanelView(
    session: BoardSession,
    commands: BoardStyleCommands,
    palette: PaintPalette,
    activeTool: string,
    panelBackground: Rgba,
    translate: (key: string) => string,
    persistScale: (scale: number) => void,
) {
    const ui = session.doc.ui;
    const highlighter = activeTool === 'highlighter';
    const next = highlighter ? ui.next.highlighterColor : ui.next.color;
    const pigment = resolveSwatch(palette, next, highlighter ? 'highlight' : 'stroke')!;
    const selected = commands.currentWidthScale();
    const width = selected ?? styleGeometryMetrics.legacyEquivalent('stroke:pen', 's', ui.penWidth);
    return {
        swatches: SWATCHES.filter(color => color !== 'white').map(color => ({
            id: color, label: translate(`colours.${color}`), color: colourCss(resolveSwatch(palette, color)!),
        })),
        selectedColor: commands.currentColor(),
        nextColorCss: colourCss(pigment), indicatorOutline: indicatorOutline(pigment, panelBackground),
        sliderPosition: penSliderFromScale(width), mixedWidthLabel: selected === null ? translate('styles.mixedWidth') : undefined,
        widthLabel: translate('chrome.penWidth'), hideLabel: translate('chrome.hideColours'),
        showLabel: translate('chrome.showColours'), disabled: session.isReadOnly,
        setColor: (id: string) => { if (SWATCHES.some(color => color === id)) commands.setColor(id as typeof SWATCHES[number]); },
        beginWidth: () => commands.beginWidth(),
        changeWidth: (position: number) => { const scale = penScaleFromSlider(position); commands.setWidth(scale); persistScale(scale); },
        commitWidth: () => commands.endWidth(),
        resetWidth: () => { commands.beginWidth(); try { commands.setWidth(1); persistScale(1); } finally { commands.endWidth(); } },
    };
}

