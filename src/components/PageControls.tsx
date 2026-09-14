// The page box and the thumbnail toggle for a canvas of pages: the PDF
// annotator's and a notebook's. (The PDF reader has its own, wired into its
// scroll pass.)
//
// The page on screen arrives through a handle, not a prop. It changes on every
// page boundary of a scroll, and a prop would re-render the host, which for
// these hosts means tldraw.

import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { ThumbnailsToggle } from './PdfThumbnails';

export interface PageControlsHandle {
    /** Show 0-based page `index` in the box (left alone while it is being typed in). */
    setPage(index: number): void;
}

interface PageControlsProps {
    pageCount: number;
    thumbsOpen: boolean;
    onToggleThumbs: () => void;
    onJump: (index: number) => void;
    /** More buttons for the thumbnails pill: the PDF annotator's invert toggle. */
    children?: React.ReactNode;
}

function PageControls({ pageCount, thumbsOpen, onToggleThumbs, onJump, children }: PageControlsProps, ref: React.ForwardedRef<PageControlsHandle>) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    /** What the box read when it took focus, so a blur only jumps if it changed. */
    const focusValueRef = useRef('');
    const pageRef = useRef(0);

    useImperativeHandle(ref, () => ({
        setPage(index: number) {
            pageRef.current = index;
            const input = inputRef.current;
            if (input && document.activeElement !== input) input.value = String(index + 1);
        },
    }), []);

    const reset = useCallback(() => {
        const input = inputRef.current;
        if (input) input.value = String(pageRef.current + 1);
    }, []);

    /** Go to the typed page. Out of range clamps ("999" plainly means the end),
     *  and anything unreadable puts the box back. */
    const commit = useCallback((onlyIfChanged: boolean) => {
        const input = inputRef.current;
        if (!input || (onlyIfChanged && input.value === focusValueRef.current)) return;
        const typed = Number.parseInt(input.value, 10);
        if (!Number.isFinite(typed)) { reset(); return; }
        const page = Math.min(pageCount, Math.max(1, typed));
        input.value = String(page);
        // So the blur that follows an Enter does not jump a second time.
        focusValueRef.current = input.value;
        onJump(page - 1);
    }, [pageCount, onJump, reset]);

    return (
        <div className="pdf-viewer-controls">
            <div className="pdf-viewer-pill">
                <ThumbnailsToggle open={thumbsOpen} onToggle={onToggleThumbs} />
                {children}
            </div>
            <div className="pdf-viewer-pill pdf-viewer-pages">
                <input
                    ref={inputRef}
                    className="pdf-viewer-page-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    style={{ width: `${Math.max(2, String(pageCount).length)}ch` }}
                    title="Current page: type a number and press Enter to jump"
                    aria-label="Page number"
                    onFocus={e => {
                        focusValueRef.current = e.currentTarget.value;
                        e.currentTarget.select();
                    }}
                    onKeyDown={e => {
                        // Digits and Backspace are tldraw shortcuts too.
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                            commit(false);
                            e.currentTarget.blur();
                        } else if (e.key === 'Escape') {
                            reset();
                            focusValueRef.current = e.currentTarget.value;
                            e.currentTarget.blur();
                        }
                    }}
                    onBlur={() => commit(true)}
                />
                <span className="pdf-viewer-page-total">/ {pageCount}</span>
            </div>
        </div>
    );
}

export default forwardRef(PageControls);
