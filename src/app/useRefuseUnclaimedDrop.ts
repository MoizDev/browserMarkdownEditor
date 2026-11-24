import { useEffect } from 'react';

/**
 * A file or link dropped anywhere nothing claims it would make the browser
 * navigate away to it — leaving the app, with whatever was unsaved. Refused
 * here, last, so every real drop target (the tree, a canvas, the editor's own
 * text drop) still gets it first.
 */
export function useRefuseUnclaimedDrop(): void {
  useEffect(() => {
    const refuseUnclaimedDrop = (event: DragEvent) => {
      if (event.defaultPrevented || !event.dataTransfer) return;
      const types = event.dataTransfer.types;
      const files = types.includes('Files');
      const link = types.includes('text/uri-list');
      if (!files && !link) return;
      if (!files && event.target instanceof Element &&
          event.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), .cm-content')) return;
      event.preventDefault();
      if (event.type === 'dragover') event.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuseUnclaimedDrop, { passive: false });
    window.addEventListener('drop', refuseUnclaimedDrop, { passive: false });
    return () => {
      window.removeEventListener('dragover', refuseUnclaimedDrop);
      window.removeEventListener('drop', refuseUnclaimedDrop);
    };
  }, []);
}
