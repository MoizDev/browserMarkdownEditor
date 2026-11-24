// What a board says when a change to it is refused because its file changed or went on disk and the DiskBar's question is
// still open. One place for the words: the host that refuses the write says them (app/useNativeCanvasHost.tsx), and the
// board that showed them takes them down once the question is answered (NativeCanvasEditing.tsx) — left up, the notice
// went on pointing at "the bar above" after the bar had gone (review run: Keep mine on a drawing, notice still there
// after the next stroke saved).
export const DISK_CHANGED_BOARD_NOTICE = 'This file changed on disk. Choose Reload or Keep mine in the bar above to go on editing.';
export const DISK_DELETED_BOARD_NOTICE = 'This file was deleted on disk. Choose Save again or Close in the bar above.';
