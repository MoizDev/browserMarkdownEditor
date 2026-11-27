import { useCallback, useState } from 'react';
import { SheetMenu, type SheetMenuProps } from './SheetMenu';

type SheetMenuState = Omit<SheetMenuProps, 'anchor' | 'close'>;

export function useSheetMenu(props: SheetMenuState) {
    const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
    const openSheets = useCallback((button: HTMLButtonElement) => {
        setAnchor(current => current === button ? null : button);
    }, []);
    const closeSheets = useCallback(() => setAnchor(null), []);
    const menu = anchor && <SheetMenu {...props} anchor={anchor} close={closeSheets} />;
    return { openSheets, closeSheets, menu };
}
