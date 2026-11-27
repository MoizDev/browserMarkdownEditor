import { ToolState, type ToolRegistration } from './gesture';
import type { UiBlock } from '../model/styles';

export const BOARD_TOOL_REGISTRATIONS: readonly ToolRegistration[] = Object.freeze([
    { id: 'select', persistence: 'persistent' }, { id: 'pen', persistence: 'persistent' },
    { id: 'highlighter', persistence: 'persistent' }, { id: 'eraser', persistence: 'persistent' },
    { id: 'hand', persistence: 'persistent' }, { id: 'laser', persistence: 'persistent' },
    { id: 'zoom', persistence: 'single-use', lockable: false }, { id: 'text', persistence: 'single-use' },
    { id: 'sticky', persistence: 'single-use' }, { id: 'figure', persistence: 'single-use', hasVariants: true },
    { id: 'frame', persistence: 'single-use' }, { id: 'connector', persistence: 'single-use' },
    { id: 'polyline', persistence: 'single-use' }, { id: 'media', persistence: 'single-use' },
]);
export function createBoardToolState(ui: UiBlock, locked: boolean): ToolState {
    const tools = new ToolState(BOARD_TOOL_REGISTRATIONS, 'select', 'figure', locked);
    if (ui.tool === 'figure') tools.setTool('figure', 'rectangle');
    else tools.adoptTool(ui.tool);
    return tools;
}
