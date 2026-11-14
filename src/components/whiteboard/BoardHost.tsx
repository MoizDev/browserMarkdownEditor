import { useEffect, type ReactNode } from 'react';
import ViewerHost, { type ViewerHostProps } from './ViewerHost';
import type { SheetMenuProps } from './SheetMenu';
import { useSheetMenu } from './useSheetMenu';
import './boardHost.css';

export interface BoardHostProps<T extends object> extends Omit<ViewerHostProps<T>, 'chrome' | 'readOnly'> {
    /** This must be session authority, not a UI-only preference. */
    readonly readOnly: boolean;
    readonly sheets: Omit<SheetMenuProps, 'anchor' | 'close' | 'readOnly'>;
    readonly renderChrome: (openSheets: (anchor: HTMLButtonElement) => void) => ReactNode;
    /** Notebook paper and PDF page controls are supplied by their host, outside document inversion. */
    readonly pageControls?: ReactNode;
}

/** One App-owned session can attach this shell for a drawing, notebook or PDF-ink view. */
export default function BoardHost<T extends object>({ readOnly, sheets, renderChrome, pageControls, ...view }: BoardHostProps<T>) {
    const { openSheets, closeSheets, menu } = useSheetMenu({ ...sheets, readOnly });
    useEffect(() => { if (!view.isVisible) closeSheets(); }, [view.isVisible, closeSheets]);
    const chrome = <>{renderChrome(openSheets)}{pageControls && <div className="board-page-controls">{pageControls}</div>}{menu}</>;
    return <ViewerHost {...view} readOnly={readOnly} chrome={chrome} />;
}
