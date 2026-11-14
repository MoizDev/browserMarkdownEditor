import { Children, cloneElement, isValidElement, type ReactNode } from 'react';
import {
    ColorSchemeMenu, DefaultMainMenu, DefaultMainMenuContent, PreferencesGroup,
    computed, createTLCurrentUser,
} from 'tldraw';
import type { TLUiMainMenuProps, TLUserPreferences } from 'tldraw';

// tldraw's user record is shared across editors. A stored dark preference (or a
// whiteboard changing it later) must not recolour ink against white paper, nor
// may opening a paper host overwrite the whiteboard's own preference.
const sharedUser = createTLCurrentUser();
const paperPreferences = computed('paper user preferences', () => ({
    ...sharedUser.userPreferences.get(), colorScheme: 'light' as const,
}));
export const PAPER_USER = createTLCurrentUser({
    userPreferences: paperPreferences,
    setUserPreferences(next: TLUserPreferences) {
        const current = sharedUser.userPreferences.get();
        const updated = { ...next, colorScheme: current.colorScheme };
        if (Object.keys(updated).some(key => updated[key as keyof TLUserPreferences] !== current[key as keyof TLUserPreferences])) {
            sharedUser.setUserPreferences(updated);
        }
    },
});

// Keep the library's menu and preferences intact except for the paper-only
// colour-scheme control. The component identities are its public menu API.
function withoutScheme(node: ReactNode): ReactNode {
    return Children.map(node, child => {
        if (!isValidElement<{ children?: ReactNode }>(child)) return child;
        if (child.type === ColorSchemeMenu) return null;
        if (child.type === PreferencesGroup) return <PaperPreferencesGroup />;
        if (child.props.children === undefined) return child;
        return cloneElement(child, {}, withoutScheme(child.props.children));
    });
}

function PaperPreferencesGroup() {
    return withoutScheme(PreferencesGroup());
}

function PaperMenuContent() {
    return withoutScheme(DefaultMainMenuContent());
}

export function PaperMainMenu(props: TLUiMainMenuProps) {
    return <DefaultMainMenu {...props}><PaperMenuContent /></DefaultMainMenu>;
}
