import { ToolState, type ToolRegistration } from './gesture';
import type { UiBlock } from '../model/styles';

/** One session UI choice, shared by every view. Pointer implementations are
 * installed by the concrete view services, never by the state registry. */
export const BOARD_TOOL_REGISTRATIONS: readonly ToolRegistration[] = Object.freeze([
    { id: 'select', persistence: 'persistent' }, { id: 'pen', persistence: 'persistent' },
    { id: 'highlighter', persistence: 'persistent' }, { id: 'eraser', persistence: 'persistent' },
    { id: 'hand', persistence: 'persistent' }, { id: 'laser', persistence: 'persistent' },
    { id: 'zoom', persistence: 'single-use' }, { id: 'text', persistence: 'single-use' },
    { id: 'sticky', persistence: 'single-use' }, { id: 'figure', persistence: 'single-use', hasVariants: true },
    { id: 'frame', persistence: 'single-use' }, { id: 'connector', persistence: 'single-use' },
    { id: 'polyline', persistence: 'single-use' }, { id: 'media', persistence: 'single-use' },
]);
export function createBoardToolState(ui: UiBlock, locked: boolean): ToolState {
    const tools = new ToolState(BOARD_TOOL_REGISTRATIONS, 'select', 'figure', locked);
    if (tools.getRegistration(ui.tool)) tools.setTool(ui.tool);
    return tools;
}
