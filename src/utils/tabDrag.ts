export const TAB_DRAG_TYPE = 'application/x-md-tab';

export function isTabDrag(dataTransfer: DataTransfer | null): boolean {
    return !!dataTransfer && Array.from(dataTransfer.types).includes(TAB_DRAG_TYPE);
}
