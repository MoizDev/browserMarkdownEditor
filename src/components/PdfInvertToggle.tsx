// The invert button beside a PDF's thumbnails button, in the reader and in the
// annotate canvas.
//
// A VIEW preference. Pages, and while annotating the ink over them, are shown
// through a CSS colour inversion; the file on disk and any PDF exported from it
// keep their real colours. It reads and writes the shared store itself, so every
// PDF on screen flips together. See utils/pdfViewState.ts.

import { useSyncExternalStore } from 'react';
import { getPdfInverted, setPdfInverted, subscribePdfInverted } from '../utils/pdfViewState';

export default function PdfInvertToggle() {
    const inverted = useSyncExternalStore(subscribePdfInverted, getPdfInverted);
    return (
        <button
            type="button"
            className={`pdf-viewer-invert-toggle${inverted ? ' is-on' : ''}`}
            onClick={() => setPdfInverted(!inverted)}
            title={inverted ? 'Show pages in their own colours' : 'Invert pages for reading in the dark'}
            aria-label="Invert page colours"
            aria-pressed={inverted}
        >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 18a6 6 0 0 0 0-12v12z" fill="currentColor" />
            </svg>
        </button>
    );
}
