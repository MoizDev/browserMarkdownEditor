import { useEffect, useState } from 'react';
import { getBoardPreferences, subscribeBoardPreferences, updateBoardPreferences } from '../../utils/boardPreferences';
import { BoardLanguageState, loadBoardLanguage } from '../../whiteboard/chrome/language';

export function useNativeBoardLanguage(onError: (error: unknown) => void): BoardLanguageState | null {
    const [state, setState] = useState<BoardLanguageState | null>(null);
    useEffect(() => {
        let live = true, language: BoardLanguageState | undefined;
        const initial = getBoardPreferences().locale;
        void loadBoardLanguage(initial).then(table => {
            if (!live) return;
            language = new BoardLanguageState(initial, table, locale => updateBoardPreferences({ locale }));
            setState(language);
            const current = getBoardPreferences().locale;
            if (current !== initial) void language.select(current, false).catch(onError);
        }, error => { if (live) onError(error); });
        const stop = subscribeBoardPreferences(preferences => {
            if (language && language.getSnapshot().locale !== preferences.locale) void language.select(preferences.locale, false).catch(onError);
        });
        return () => { live = false; stop(); };
    }, [onError]);
    return state;
}
