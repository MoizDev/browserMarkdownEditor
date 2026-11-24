import { parseJson } from '../../format/jsonRead';
import type { SavedView } from '../../format/encode';
import { UI_DEFAULTS, VIEW_DEFAULTS } from '../../model/defaults';
import type { ViewFlags } from '../../model/doc';
import { DASHES, FILLS, FONTS, H_ALIGNS, SIZES, SWATCHES, V_ALIGNS, type NextStyles, type ToolId, type UiBlock } from '../../model/styles';
import { object, type LegacyObject } from './envelope';

const TOOL_MAP: Readonly<Record<string, ToolId>> = {
    select: 'select', hand: 'hand', draw: 'pen', highlight: 'highlighter', eraser: 'eraser',
    laser: 'laser', text: 'text', geo: 'figure', arrow: 'connector', line: 'polyline',
    frame: 'frame', note: 'sticky', asset: 'media',
};
function choice<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
    return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
}
function flag(value: unknown, fallback: boolean): boolean { return typeof value === 'boolean' ? value : fallback; }
export function readLegacyUi(ui: LegacyObject | null): UiBlock {
    const styles = object(ui?.stylesForNextShape);
    const d = UI_DEFAULTS.next;
    const next: NextStyles = {
        ...d,
        color: choice(styles?.['tldraw:color'], SWATCHES, d.color),
        fill: choice(styles?.['tldraw:fill'], FILLS, d.fill),
        dash: choice(styles?.['tldraw:dash'], DASHES, d.dash),
        size: choice(styles?.['tldraw:size'], SIZES, d.size),
        font: choice(styles?.['tldraw:font'], FONTS, d.font),
        align: choice(styles?.['tldraw:horizontalAlign'], H_ALIGNS, d.align),
        valign: choice(styles?.['tldraw:verticalAlign'], V_ALIGNS, d.valign),
    };
    const scale = ui?.penScale;
    const penWidth = typeof scale === 'number' && Number.isFinite(scale) ? 3 * Math.max(0.12, Math.min(3.5, scale)) : UI_DEFAULTS.penWidth;
    const raw = ui ? parseJson(JSON.stringify(ui)).raw() : null;
    return { tool: typeof ui?.toolId === 'string' ? TOOL_MAP[ui.toolId] ?? 'pen' : 'pen', next, penWidth,
        ext: raw ? { fields: new Map([['legacyUi', raw]]), raw: new Map() } : null };
}
export function readLegacyView(session: LegacyObject | null): { readonly flags: ViewFlags; readonly camera?: SavedView } {
    const flags: ViewFlags = { ...VIEW_DEFAULTS,
        grid: flag(session?.isGridMode, false), focusMode: flag(session?.isFocusMode, false),
        toolLock: flag(session?.isToolLocked, false), transparent: !flag(session?.exportBackground, true),
        debugMode: flag(session?.isDebugMode, false) };
    const sheet = session?.currentPageId;
    if (typeof sheet !== 'string' || !Array.isArray(session?.pageStates)) return { flags };
    for (const entry of session.pageStates) {
        const state = object(entry), camera = object(state?.camera);
        if (state?.pageId !== sheet || !camera) continue;
        const { x, y, z } = camera;
        if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
            && typeof z === 'number' && Number.isFinite(z) && z > 0) {
            return { flags, camera: { sheet, x: -x, y: -y, zoom: z } };
        }
    }
    return { flags };
}
