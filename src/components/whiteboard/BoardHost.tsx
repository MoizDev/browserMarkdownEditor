import { useEffect, type ReactNode } from 'react';
import ViewerHost, { type ViewerHostProps } from './ViewerHost';
import type { SheetMenuProps } from './SheetMenu';
import { useSheetMenu } from './useSheetMenu';
import './boardHost.css';

export interface BoardHostProps<T extends object> extends Omit<ViewerHostProps<T>, 'chrome' | 'readOnly'> {
    readonly readOnly: boolean;
    readonly sheets: Omit<SheetMenuProps, 'anchor' | 'close' | 'readOnly'>;
    readonly renderChrome: (openSheets: (anchor: HTMLButtonElement) => void) => ReactNode;
    readonly pageControls?: ReactNode;
}

export default function BoardHost<T extends object>({ readOnly, sheets, renderChrome, pageControls, ...view }: BoardHostProps<T>) {
    const { openSheets, closeSheets, menu } = useSheetMenu({ ...sheets, readOnly });
    useEffect(() => { if (!view.isVisible) closeSheets(); }, [view.isVisible, closeSheets]);
    const chrome = <>{renderChrome(openSheets)}{pageControls && <div className="board-page-controls">{pageControls}</div>}{menu}</>;
    return <ViewerHost {...view} readOnly={readOnly} chrome={chrome} />;
}
